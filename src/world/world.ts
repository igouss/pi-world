import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { JsonObject, Session, Tx } from "@earendil-works/pi-durable";
import type { Snapshot } from "quickjs-wasi";
import type { Check, RemovedCheck } from "../check/check.ts";
import { contentHash, type BlobStore } from "../revision/blob-store.ts";
import { WorldChecks, WorldHead, WorldRevision, type ChecksState } from "../revision/documents.ts";
import type { Head, Origin, Revision } from "../revision/revision.ts";
import { attemptDevelop, attemptEnrolment, type AttemptMode } from "./attempt.ts";
import { diffCatalogues } from "./catalogue-diff.ts";
import type { DataPort } from "./data-port.ts";
import { NO_PEERS, type PeerPort } from "./peer-port.ts";
import { Mutex } from "./mutex.ts";
import { VmPool } from "./vm-pool.ts";
import { PRELUDE_VERSION } from "./prelude.ts";
import { DEFAULT_LIMITS, WorldVm, type CatalogueEntry, type Failure, type Outcome, type VmLimits } from "./world-vm.ts";

/** Runs one atomic commit; a tool passes its own `api.commit`, everything else the Session's. */
export type Commit = <T>(change: (tx: Tx) => T | Promise<T>) => Promise<T>;

export interface WorldDeps {
	readonly session: Pick<Session, "commit" | "snapshot">;
	readonly blobs: BlobStore;
	readonly data: DataPort;
	/** The other worlds, for calls that start here; a call from another world brings its own. */
	readonly peers?: PeerPort;
	readonly wasm: WebAssembly.Module;
	readonly limits?: VmLimits;
	readonly now?: () => number;
	/** How many calls one world runs at once; more wait. Each running call holds a VM of about the snapshot's size. */
	readonly concurrentCalls?: number;
}

const CONCURRENT_CALLS: number = 8;
const WARM_VMS: number = 2;

export type DevelopResult =
	| { readonly status: "accepted"; readonly revision: Revision; readonly replayed: boolean }
	| { readonly status: "rejected"; readonly failure: Failure | "check"; readonly reason: string; readonly check?: string };

export type EnrolResult = { readonly status: "enrolled"; readonly check: Check } | { readonly status: "refused"; readonly reason: string };

const KEPT_CALLS: number = 200;

/**
 * One world: its head revision, and the only path that changes it.
 *
 * Changes (develop, rollback, checks, upgrades) run one at a time under the world's lock, on the main VM, which is
 * always at the head between them. Calls run concurrently, each on its own VM from a pool, restored from the head
 * the call started at: a call never observes an attempt in progress, a call that started before a new revision
 * finishes on the old one, and heap changes a call makes vanish with its VM, because only revisions persist heap
 * state. Data is shared: calls see each other's writes between their awaits.
 */
export class World {
	private readonly lock: Mutex = new Mutex();
	private readonly listeners: Set<() => void> = new Set();
	private readonly revisions: Map<number, Revision> = new Map();
	private readonly pool: VmPool;

	private constructor(
		private readonly deps: WorldDeps,
		private readonly vm: WorldVm,
		private headSnapshot: Snapshot,
		private current: Head,
		private currentCatalogue: readonly CatalogueEntry[],
		private checksState: ChecksState,
	) {
		const limits = deps.limits ?? DEFAULT_LIMITS;
		this.pool = new VmPool(
			(snapshot) => WorldVm.fromSnapshot(snapshot, deps.wasm, limits),
			() => ({ revision: this.current.revision, snapshot: this.headSnapshot }),
			deps.concurrentCalls ?? CONCURRENT_CALLS,
			WARM_VMS,
		);
	}

	/** Open the world at its head, creating revision 0 (the prelude alone) on first use. */
	static async open(deps: WorldDeps): Promise<World> {
		const limits = deps.limits ?? DEFAULT_LIMITS;
		const head = await deps.session.snapshot(WorldHead, BACKGROUND_CONTEXT);
		const checks = (await deps.session.snapshot(WorldChecks, BACKGROUND_CONTEXT)) ?? { checks: [], removed: [] };
		if (head && head.revision >= 0) {
			const bytes = await deps.blobs.get(head.blob);
			if (!bytes) throw new Error(`world head points at blob ${head.blob}, which is missing`);
			const vm = await WorldVm.fromBytes(bytes, deps.wasm, limits);
			const world = new World(deps, vm, vm.snapshot(), head, vm.catalogue(), checks);
			await world.upgradePrelude();
			return world;
		}
		const vm = await WorldVm.create(deps.wasm, limits);
		const snapshot = vm.snapshot();
		const world = new World(deps, vm, snapshot, { revision: -1, blob: "", calls: {} }, [], checks);
		await world.accept(
			snapshot,
			{ kind: "genesis", summary: "the prelude", at: world.now(), origin: { by: "host" }, changes: { added: [], changed: [], removed: [] } },
			[],
			world.sessionCommit,
		);
		return world;
	}

	head(): Head {
		return this.current;
	}

	/** Called after every change of the head or the checks. */
	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	catalogue(): readonly CatalogueEntry[] {
		return this.currentCatalogue;
	}

	checks(): ChecksState {
		return this.checksState;
	}

	async develop(source: string, summary: string, origin: Origin, commit: Commit = this.sessionCommit): Promise<DevelopResult> {
		return this.exclusive(async () => {
			const replayed = await this.replayed(origin);
			if (replayed) return { status: "accepted", revision: replayed, replayed: true };
			const at = this.now();
			const attempt = await attemptDevelop(this.vm, source, this.checksState.checks, this.attemptMode(at));
			if (!attempt.accepted) {
				return {
					status: "rejected",
					failure: attempt.failure,
					reason: attempt.reason,
					...(attempt.check ? { check: attempt.check } : {}),
				};
			}
			const revision = await this.accept(
				attempt.snapshot,
				{ kind: "develop", source, summary, at, origin, changes: attempt.changes },
				attempt.catalogue,
				commit,
			);
			return { status: "accepted", revision, replayed: false };
		});
	}

	/** Restore an earlier revision's heap as a new revision. History is never rewritten. */
	async rollback(target: number, reason: string, origin: Origin, commit: Commit = this.sessionCommit): Promise<Revision> {
		if (!reason.trim()) throw new Error("a rollback needs a reason");
		return this.exclusive(async () => {
			const replayed = await this.replayed(origin);
			if (replayed) return replayed;
			const revision = await this.requireRevision(target);
			if (target === this.current.revision) throw new Error(`revision ${target} is already the head`);
			const bytes = await this.deps.blobs.get(revision.blob);
			if (!bytes) throw new Error(`revision ${target} points at blob ${revision.blob}, which is missing`);
			const before = this.catalogue();
			await this.vm.reset(WorldVm.deserialize(bytes));
			if (revision.prelude < WorldVm.preludeVersion) this.vm.upgrade(revision.prelude);
			const catalogue = this.vm.catalogue();
			return this.accept(
				this.vm.snapshot(),
				{ kind: "rollback", target, reason, summary: `rollback to revision ${target}: ${reason}`, at: this.now(), origin, changes: diffCatalogues(before, catalogue) },
				catalogue,
				commit,
			);
		});
	}

	/** Evaluate an expression against the world and its data. Heap changes are discarded; data writes are kept. */
	async execute(expression: string, peers: PeerPort = this.deps.peers ?? NO_PEERS): Promise<Outcome> {
		return this.pool.run((vm) => vm.evaluate(expression, { kind: "live", data: this.deps.data, peers }));
	}

	/**
	 * Call a definition directly, as an end user or another world would. Heap changes are discarded; data writes are
	 * kept. `peers` is how this call reaches other worlds; a call from another world passes one that knows the chain.
	 */
	async call(name: string, args: readonly unknown[], peers: PeerPort = this.deps.peers ?? NO_PEERS): Promise<Outcome> {
		return this.pool.run((vm) => vm.invoke(name, args, { kind: "live", data: this.deps.data, peers }));
	}

	/**
	 * Enrol a check only after seeing it fail on its counterexample and pass on the current world. Proposing an
	 * enrolled check again, as a rerun tool call does, returns the enrolled check.
	 */
	async proposeCheck(name: string, expression: string, counterexample: string, commit: Commit = this.sessionCommit): Promise<EnrolResult> {
		return this.exclusive(async () => {
			const existing = this.checksState.checks.find((check) => check.name === name);
			if (existing && existing.expression === expression && existing.counterexample === counterexample) return { status: "enrolled", check: existing };
			if (existing) return { status: "refused", reason: `a different check named "${name}" is already enrolled` };
			const enrolment = await attemptEnrolment(this.vm, expression, counterexample, this.attemptMode(this.now()));
			if (!enrolment.enrolled) return { status: "refused", reason: enrolment.reason };
			const check: Check = { name, expression, counterexample, enrolledAt: this.now() };
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

	async revision(n: number): Promise<Revision | undefined> {
		const cached = this.revisions.get(n);
		if (cached) return cached;
		const revision = (await this.deps.session.snapshot(WorldRevision, String(n), BACKGROUND_CONTEXT)) as Revision | undefined;
		if (revision) this.revisions.set(n, revision);
		return revision;
	}

	/** Newest first. */
	async history(limit: number, before?: number): Promise<readonly Revision[]> {
		const top = Math.min(before === undefined ? this.current.revision : before - 1, this.current.revision);
		const out: Revision[] = [];
		for (let n = top; n >= 0 && out.length < limit; n--) {
			const revision = await this.revision(n);
			if (revision) out.push(revision);
		}
		return out;
	}

	dispose(): void {
		this.pool.dispose();
		this.vm.dispose();
	}

	/** Bring a heap built by an older prelude up to date, as a revision of its own. */
	private async upgradePrelude(): Promise<void> {
		const head = await this.requireRevision(this.current.revision);
		if (head.prelude >= WorldVm.preludeVersion) return;
		await this.exclusive(async () => {
			this.vm.upgrade(head.prelude);
			const changes = { added: [], changed: [], removed: [] };
			const summary = `prelude ${head.prelude} to ${WorldVm.preludeVersion}`;
			await this.accept(this.vm.snapshot(), { kind: "upgrade", from: head.prelude, summary, at: this.now(), origin: { by: "host" }, changes }, this.currentCatalogue, this.sessionCommit);
		});
	}

	/** Hold the lock for a change; the main VM is at the head. */
	private exclusive<T>(body: () => Promise<T>): Promise<T> {
		return this.lock.run(body);
	}

	/** Blob first, then the revision and the head pointer in one commit: a crash leaves an orphan blob at worst. */
	private async accept(
		snapshot: Snapshot,
		draft: AcceptDraft,
		catalogue: readonly CatalogueEntry[],
		commit: Commit,
	): Promise<Revision> {
		try {
			const bytes = WorldVm.serialize(snapshot);
			const blob = await contentHash(bytes);
			await this.deps.blobs.put(blob, bytes);
			const n = this.current.revision + 1;
			const parent = this.current.revision >= 0 ? this.current.revision : null;
			const revision: Revision = { ...draft, n, parent, blob, bytes: bytes.length, prelude: PRELUDE_VERSION };
			const head = await commit(async (tx) => {
				const doc = await tx.doc(WorldHead);
				if (doc.revision !== this.current.revision) throw new Error(`the head moved from ${this.current.revision} to ${doc.revision}`);
				await tx.doc(WorldRevision, String(n), revision as Revision & JsonObject);
				doc.revision = n;
				doc.blob = blob;
				if (draft.origin.by === "agent") {
					const calls = doc.calls as Record<string, number>;
					calls[draft.origin.callId] = n;
					const keys = Object.keys(calls);
					for (const key of keys.slice(0, Math.max(0, keys.length - KEPT_CALLS))) delete calls[key];
				}
				return plain<Head>(doc);
			});
			this.current = head;
			this.headSnapshot = snapshot;
			this.currentCatalogue = catalogue;
			this.revisions.set(n, revision);
			this.notify();
			return revision;
		} catch (error) {
			await this.vm.reset(this.headSnapshot);
			throw error;
		}
	}

	/** The revision an agent's tool call already produced, when the call reruns after a crash. */
	private async replayed(origin: Origin): Promise<Revision | undefined> {
		if (origin.by !== "agent") return undefined;
		const done = this.current.calls[origin.callId];
		return done === undefined ? undefined : this.requireRevision(done);
	}

	private async requireRevision(n: number): Promise<Revision> {
		const revision = await this.revision(n);
		if (!revision) throw new Error(`no revision ${n}`);
		return revision;
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

/** A plain copy of a document draft, which is only valid inside its commit. */
function plain<T>(draft: unknown): T {
	return JSON.parse(JSON.stringify(draft)) as T;
}

/** A revision before `accept` gives it its number, parent and blob. */
type AcceptDraft = Revision extends infer R ? (R extends Revision ? Omit<R, "n" | "parent" | "blob" | "bytes" | "prelude"> : never) : never;
