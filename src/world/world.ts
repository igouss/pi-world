import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { JsonObject, Session, Tx } from "@earendil-works/pi-durable";
import type { Check, RemovedCheck } from "../check/check.ts";
import { parseGenerator } from "../check/generator.ts";
import type { BlobStore } from "../revision/blob-store.ts";
import { WorldChecks, WorldGrants, WorldHead, WorldRejection, WorldRejections, WorldRevision, type ChecksState } from "../revision/documents.ts";
import { NumberedLog } from "../revision/numbered-log.ts";
import { plain } from "../revision/plain.ts";
import type { Attempted, Rejection, RejectionRecord, Rejections } from "../revision/rejection.ts";
import { developSources, type Head, type Origin, type Revision } from "../revision/revision.ts";
import { references, type References } from "../source/references.ts";
import { rewriteSource } from "../source/rewrite.ts";
import { diffCatalogues } from "./catalogue-diff.ts";
import { isRefused, type CallRunner, type CallScope, type ExecuteResult, type Refused } from "./call-runner.ts";
import { IncidentLog } from "../incident/incident-log.ts";
import type { CallOutcome, Incidents } from "../incident/incident.ts";
import { ANY_WORLD, type Grants } from "./grants.ts";
import { Mutex } from "./mutex.ts";
import { PRELUDE_VERSION } from "./prelude.ts";
import { rememberCall } from "./remember-call.ts";
import type { Heap, Workbench } from "./workbench.ts";
import { WorldVm, type AttemptMode, type CatalogueEntry, type Failure, type Outcome } from "./world-vm.ts";

/** Runs one atomic commit; a tool passes its own `api.commit`, everything else the Session's. */
export type Commit = <T>(change: (tx: Tx) => T | Promise<T>) => Promise<T>;

export interface WorldDeps {
	readonly session: Pick<Session, "commit" | "snapshot">;
	readonly blobs: BlobStore;
	/** Where calls and previews run. */
	readonly calls: CallRunner;
	/** Where changes do their VM work. */
	readonly workbench: Workbench;
	readonly now?: () => number;
}

export type DevelopResult =
	| { readonly status: "accepted"; readonly revision: Revision; readonly replayed: boolean }
	| { readonly status: "rejected"; readonly rejection: Rejection & { readonly kind: "develop" } };

/** A check as proposed: its generator is unchecked JSON until enrolment parses it. */
export interface CheckProposal {
	readonly name: string;
	readonly expression: string;
	readonly counterexample: string;
	readonly generator?: unknown;
}

export type EnrolResult =
	| { readonly status: "enrolled"; readonly check: Check }
	| { readonly status: "refused"; readonly rejection: Rejection & { readonly kind: "check" } };

/** What an agent's tool call produced before a crash made it run again. */
type Previous = { readonly kind: "revision"; readonly revision: Revision } | { readonly kind: "rejection"; readonly rejection: Rejection };

const KEPT_CALLS: number = 200;

/** How long after it arrives a call may still start (objective O8: excess is refused within 1 s). */
const START_WITHIN_MS: number = 1000;

/**
 * One world: its head revision, and the only path that changes it.
 *
 * Changes (develop, rollback, checks, upgrades) run one at a time under the world's lock; their VM work is the
 * `Workbench`'s, which holds the head between them. Calls and previews belong to its `CallRunner`, which runs each call on a VM of its
 * own at the head the call started at, reading that head's snapshot from the blob store: a call never observes an attempt in progress, a call that
 * started before a new revision finishes on the old one, and heap changes a call makes vanish with its VM, because
 * only revisions persist heap state. A call's data writes are made when it succeeds; a failed call is an incident.
 */
export class World {
	private readonly lock: Mutex = new Mutex();
	private readonly listeners: Set<() => void> = new Set();
	private readonly revisions: NumberedLog<Revision>;
	private readonly rejected: NumberedLog<Rejection>;
	/** The head's definitions; empty until the workbench has opened the head. */
	private currentCatalogue: readonly CatalogueEntry[] = [];
	private graph: { readonly catalogue: readonly CatalogueEntry[]; readonly references: ReadonlyMap<string, References> } | undefined;

	/** Calls that failed, kept so they can be fixed and retried. */
	readonly incidents: IncidentLog;
	private readonly deps: WorldDeps;
	private current: Head;
	private checksState: ChecksState;
	private rejectionsState: Rejections;
	private grantsState: Grants;

	private constructor(
		deps: WorldDeps,
		current: Head,
		checksState: ChecksState,
		rejectionsState: Rejections,
		grantsState: Grants,
		incidents: Incidents,
	) {
		this.deps = deps;
		this.current = current;
		this.checksState = checksState;
		this.rejectionsState = rejectionsState;
		this.grantsState = grantsState;
		this.incidents = new IncidentLog(deps.session, this.sessionCommit, incidents, () => this.now(), () => this.notify());
		this.revisions = new NumberedLog(deps.session, WorldRevision, "revision");
		this.rejected = new NumberedLog(deps.session, WorldRejection, "rejection");
	}

	/** Open the world at its head, creating revision 0 (the prelude alone) on first use. */
	static async open(deps: WorldDeps): Promise<World> {
		const head = await deps.session.snapshot(WorldHead, BACKGROUND_CONTEXT);
		const checks = (await deps.session.snapshot(WorldChecks, BACKGROUND_CONTEXT)) ?? { checks: [], removed: [] };
		const rejections = (await deps.session.snapshot(WorldRejections, BACKGROUND_CONTEXT)) ?? { count: 0, calls: {} };
		const grants = (await deps.session.snapshot(WorldGrants, BACKGROUND_CONTEXT)) ?? ANY_WORLD;
		const incidents = await IncidentLog.load(deps.session);
		if (head && head.revision >= 0) {
			const world = new World(deps, head, checks, rejections, grants, incidents);
			await world.openHead();
			return world;
		}
		const world = new World(deps, { revision: -1, blob: "", calls: {} }, checks, rejections, grants, incidents);
		await world.accept(
			await deps.workbench.genesis(),
			{ kind: "genesis", summary: "the prelude", at: world.now(), origin: { by: "host" }, changes: { added: [], changed: [], removed: [] } },
			world.sessionCommit,
		);
		return world;
	}

	head(): Head {
		return this.current;
	}

	/** Called after every change of the head, the checks or the grants, and after every rejection and incident. */
	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	catalogue(): readonly CatalogueEntry[] {
		return this.currentCatalogue;
	}

	/** Who calls whom among the head's definitions, read from their sources once per catalogue. */
	callGraph(): ReadonlyMap<string, References> {
		if (this.graph?.catalogue !== this.currentCatalogue) this.graph = { catalogue: this.currentCatalogue, references: references(this.currentCatalogue) };
		return this.graph.references;
	}

	checks(): ChecksState {
		return this.checksState;
	}

	grants(): Grants {
		return this.grantsState;
	}

	/** An operator call: what this world's code may reach. Calls already running keep the grants they started with. */
	async setGrants(grants: Grants): Promise<void> {
		await this.exclusive(async () => {
			this.grantsState = await this.sessionCommit(async (tx) => {
				const doc = await tx.doc(WorldGrants);
				Object.assign(doc, grants);
				return plain<Grants>(doc);
			});
			this.notify();
		});
	}

	/** Attempt a develop source, as written: top-level declarations become definitions (`rewriteSource`). */
	async develop(written: string, summary: string, origin: Origin, commit: Commit = this.sessionCommit): Promise<DevelopResult> {
		return this.exclusive(async () => {
			const previous = await this.previous(origin);
			if (previous?.kind === "revision") return { status: "accepted", revision: previous.revision, replayed: true };
			if (previous?.rejection.kind === "develop") return { status: "rejected", rejection: previous.rejection };
			const at = this.now();
			const sources = developSources(written, rewriteSource(written));
			const evaluated = sources.source;
			const attempt = await this.deps.workbench.develop(this.current.blob, evaluated, this.checksState.checks, this.attemptMode(at));
			if (!attempt.accepted) {
				const { failure, reason, check } = attempt;
				const rejection = await this.reject({ kind: "develop", ...sources, failure, check, summary, at, origin, reason }, commit);
				return { status: "rejected", rejection };
			}
			const revision = await this.accept(attempt.heap, { kind: "develop", ...sources, summary, at, origin, changes: attempt.changes }, commit);
			return { status: "accepted", revision, replayed: false };
		});
	}

	/** Restore an earlier revision's heap as a new revision. History is never rewritten. */
	async rollback(target: number, reason: string, origin: Origin, commit: Commit = this.sessionCommit): Promise<Revision> {
		if (!reason.trim()) throw new Error("a rollback needs a reason");
		return this.exclusive(async () => {
			const previous = await this.previous(origin);
			if (previous?.kind === "revision") return previous.revision;
			const revision = await this.revisions.require(target);
			if (target === this.current.revision) throw new Error(`revision ${target} is already the head`);
			const heap = await this.deps.workbench.rollback(revision.blob, revision.prelude);
			const changes = diffCatalogues(this.catalogue(), heap.catalogue);
			return this.accept(heap, { kind: "rollback", target, reason, summary: `rollback to revision ${target}: ${reason}`, at: this.now(), origin, changes }, commit);
		});
	}

	/**
	 * Evaluate an expression against the world and its data, as a preview: heap changes and data writes are both
	 * discarded, and the result names the writes it rolled back. Other worlds it calls write for real.
	 */
	async execute(expression: string): Promise<ExecuteResult | Refused> {
		return this.deps.calls.execute(expression, this.scope());
	}

	/**
	 * Call a definition directly, as an end user or another world would. Heap changes are discarded; data writes are
	 * made only if the call succeeds. A call from another world passes `chain`, the worlds it came through. A failed
	 * call of a definition is recorded as an incident, which the outcome names; a call of a name the world does not
	 * define is the caller's mistake and is not recorded.
	 */
	async call(name: string, args: readonly unknown[], chain: readonly string[] = []): Promise<CallOutcome | Refused> {
		const { outcome, revision, defined } = await this.run(name, args, chain);
		if (outcome.ok || !defined || isRefused(outcome)) return outcome;
		const incident = await this.incidents.record({ name, args, failure: outcome.failure, error: outcome.error, revision });
		return { ...outcome, incident };
	}

	/**
	 * Call an open incident's definition again with its arguments, at the head as it is now. A retry that succeeds
	 * closes the incident with its value; one that fails leaves it open with the new error. A retry refused as busy
	 * never ran, so it changes nothing.
	 */
	async retryIncident(n: number, by: Origin["by"], commit: Commit = this.sessionCommit): Promise<Outcome | Refused> {
		const incident = await this.incidents.requireOpen(n);
		if (!incident.args) throw new Error(`incident ${n} kept no arguments (they were too large), so it cannot be retried`);
		const { outcome, revision } = await this.run(incident.name, incident.args, []);
		if (outcome.ok) await this.incidents.close(n, by, { kind: "retried", revision, value: outcome.value }, commit);
		else if (!isRefused(outcome)) await this.incidents.retryFailed(n, outcome.failure, outcome.error, revision, commit);
		return outcome;
	}

	/** Run a call at the head as it is when the call starts, and say whether the head defines the name. */
	private async run(name: string, args: readonly unknown[], chain: readonly string[]): Promise<{ outcome: Outcome | Refused; revision: number; defined: boolean }> {
		const scope = this.scope();
		const defined = this.currentCatalogue.some((entry) => entry.name === name);
		return { outcome: await this.deps.calls.call(name, args, chain, scope), revision: scope.head.revision, defined };
	}

	/**
	 * Enrol a check only after seeing it fail on its counterexample and pass on the current world. A property check's
	 * generator must parse. Proposing an enrolled check again, as a rerun tool call does, returns the enrolled check.
	 */
	async proposeCheck(proposal: CheckProposal, origin: Origin, commit: Commit = this.sessionCommit): Promise<EnrolResult> {
		const { name, expression, counterexample } = proposal;
		if (!name.trim() || !expression.trim() || !counterexample.trim()) throw new Error("a check needs a name, an expression and a counterexample");
		return this.exclusive(async () => {
			const previous = await this.previous(origin);
			if (previous?.kind === "rejection" && previous.rejection.kind === "check") return { status: "refused", rejection: previous.rejection };
			const at = this.now();
			const refuse = async (reason: string): Promise<EnrolResult> => {
				const attempted = { kind: "check", name, expression, counterexample, generator: proposal.generator } as const;
				return { status: "refused", rejection: await this.reject({ ...attempted, summary: `check "${name}"`, at, origin, reason }, commit) };
			};
			const parsed = proposal.generator === undefined ? undefined : parseGenerator(proposal.generator);
			if (parsed && "error" in parsed) return refuse(`the generator is not valid: ${parsed.error}`);
			const sources = developSources(counterexample, rewriteSource(counterexample));
			const candidate = { expression, counterexample: sources.source, generator: parsed?.generator };
			const existing = this.checksState.checks.find((check) => check.name === name);
			if (existing && sameJson([existing.expression, existing.counterexample, existing.generator], [expression, sources.source, candidate.generator]))
				return { status: "enrolled", check: existing };
			if (existing) return refuse(`a different check named "${name}" is already enrolled`);
			const enrolment = await this.deps.workbench.enrol(this.current.blob, candidate, this.attemptMode(at));
			if (!enrolment.enrolled) return refuse(enrolment.reason);
			const check: Check = plain({ name, ...candidate, written: sources.written, enrolledAt: this.now() });
			this.checksState = await commit(async (tx) => {
				const doc = await tx.doc(WorldChecks);
				(doc.checks as Check[]).push(check);
				return plain<ChecksState>(doc);
			});
			this.notify();
			return { status: "enrolled", check };
		});
	}

	/** An operator call: removing a check needs a reason, which is kept. */
	async removeCheck(name: string, reason: string): Promise<void> {
		if (!reason.trim()) throw new Error("removing a check needs a reason");
		await this.exclusive(async () => {
			this.checksState = await this.sessionCommit(async (tx) => {
				const doc = await tx.doc(WorldChecks);
				const index = (doc.checks as Check[]).findIndex((check) => check.name === name);
				if (index < 0) throw new Error(`no check named "${name}"`);
				const [check] = (doc.checks as Check[]).splice(index, 1);
				(doc.removed as RemovedCheck[]).push({ check: check!, reason, removedAt: this.now() });
				return plain<ChecksState>(doc);
			});
			this.notify();
		});
	}

	revision(n: number): Promise<Revision | undefined> {
		return this.revisions.get(n);
	}

	/** Newest first. */
	history(limit: number, before?: number): Promise<readonly Revision[]> {
		return this.revisions.newestFirst(this.current.revision + 1, limit, before);
	}

	rejection(n: number): Promise<Rejection | undefined> {
		return this.rejected.get(n);
	}

	/** Rejected attempts, newest first. */
	rejections(limit: number, before?: number): Promise<readonly Rejection[]> {
		return this.rejected.newestFirst(this.rejectionsState.count, limit, before);
	}

	rejectionCount(): number {
		return this.rejectionsState.count;
	}

	dispose(): void {
		this.deps.calls.dispose();
		this.deps.workbench.dispose();
	}

	/** Read the head's definitions; a heap built by an older prelude is brought up to date as a revision of its own. */
	private async openHead(): Promise<void> {
		const head = await this.revisions.require(this.current.revision);
		await this.exclusive(async () => {
			const { catalogue, upgraded } = await this.deps.workbench.open(this.current.blob, head.prelude);
			this.currentCatalogue = catalogue;
			if (!upgraded) return;
			const changes = { added: [], changed: [], removed: [] };
			const summary = `prelude ${head.prelude} to ${WorldVm.preludeVersion}`;
			await this.accept(upgraded, { kind: "upgrade", from: head.prelude, summary, at: this.now(), origin: { by: "host" }, changes }, this.sessionCommit);
		});
	}

	/** Hold the lock for a change. */
	private exclusive<T>(body: () => Promise<T>): Promise<T> {
		return this.lock.run(body);
	}

	/**
	 * Blob first, then the revision and the head pointer in one commit: a crash leaves an orphan blob at worst. A
	 * commit that fails leaves the head where it was; the workbench returns to it at the next change.
	 */
	private async accept(heap: Heap, draft: AcceptDraft, commit: Commit): Promise<Revision> {
		await this.deps.blobs.put(heap.blob, heap.bytes);
		const n = this.current.revision + 1;
		const parent = this.current.revision >= 0 ? this.current.revision : null;
		const revision: Revision = { ...draft, n, parent, blob: heap.blob, bytes: heap.bytes.length, prelude: PRELUDE_VERSION };
		const head = await commit(async (tx) => {
			const doc = await tx.doc(WorldHead);
			if (doc.revision !== this.current.revision) throw new Error(`the head moved from ${this.current.revision} to ${doc.revision}`);
			await tx.doc(WorldRevision, String(n), revision as Revision & JsonObject);
			doc.revision = n;
			doc.blob = heap.blob;
			if (draft.origin.by === "agent") rememberCall(doc.calls as Record<string, number>, draft.origin.callId, n, KEPT_CALLS);
			return plain<Head>(doc);
		});
		this.current = head;
		this.currentCatalogue = heap.catalogue;
		this.revisions.remember(n, revision);
		this.notify();
		return revision;
	}

	/** Record a rejected attempt. The world itself is unchanged. */
	private async reject<A extends Attempted>(attempt: A & Omit<RejectionRecord, "n" | "base">, commit: Commit): Promise<A & RejectionRecord> {
		const base = this.current.revision;
		const { rejection, state } = await commit(async (tx) => {
			const doc = await tx.doc(WorldRejections);
			// A document holds strict JSON, so optional fields left undefined are dropped here.
			const rejection = plain<A & RejectionRecord>({ ...attempt, n: doc.count as number, base });
			await tx.doc(WorldRejection, String(rejection.n), rejection as Rejection & JsonObject);
			doc.count = rejection.n + 1;
			if (attempt.origin.by === "agent") rememberCall(doc.calls as Record<string, number>, attempt.origin.callId, rejection.n, KEPT_CALLS);
			return { rejection, state: plain<Rejections>(doc) };
		});
		this.rejectionsState = state;
		this.rejected.remember(rejection.n, rejection);
		this.notify();
		return rejection;
	}

	/** What an agent's tool call already produced, when the call reruns after a crash. */
	private async previous(origin: Origin): Promise<Previous | undefined> {
		if (origin.by !== "agent") return undefined;
		const revision = this.current.calls[origin.callId];
		if (revision !== undefined) return { kind: "revision", revision: await this.revisions.require(revision) };
		const rejection = this.rejectionsState.calls[origin.callId];
		if (rejection !== undefined) return { kind: "rejection", rejection: await this.rejected.require(rejection) };
		return undefined;
	}

	/** What a call starts from: the head as a call runner needs it (its record of tool calls stays here), the grants, and its start deadline. */
	private scope(): CallScope {
		return { head: { revision: this.current.revision, blob: this.current.blob }, grants: this.grantsState, startBy: this.now() + START_WITHIN_MS };
	}

	private attemptMode(at: number): AttemptMode {
		return { kind: "attempt", at, seed: this.current.revision + 1 };
	}

	private now(): number {
		return (this.deps.now ?? Date.now)();
	}

	private readonly sessionCommit: Commit = (change) => this.deps.session.commit(change, BACKGROUND_CONTEXT);

	private notify(): void {
		for (const listener of this.listeners) listener();
	}
}

function sameJson(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

/** A revision before `accept` gives it its number, parent and blob. */
type AcceptDraft = Revision extends infer R ? (R extends Revision ? Omit<R, "n" | "parent" | "blob" | "bytes" | "prelude"> : never) : never;
