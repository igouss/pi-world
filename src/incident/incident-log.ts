import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { JsonObject, Session } from "@earendil-works/pi-durable";
import { WorldIncident, WorldIncidents } from "../revision/documents.ts";
import { NumberedLog } from "../revision/numbered-log.ts";
import { plain } from "../revision/plain.ts";
import type { Origin } from "../revision/revision.ts";
import type { Commit } from "../world/world.ts";
import type { Failure } from "../world/world-vm.ts";
import { incidentKey, MAX_ARGS_JSON, type Incident, type Incidents, type Resolution } from "./incident.ts";

/** A call that failed, as the world saw it. */
export interface FailedCall {
	readonly name: string;
	readonly args: readonly unknown[];
	readonly failure: Failure;
	readonly error: string;
	readonly revision: number;
}

/** How an incident closes, before the log stamps it with who and when. */
export type Closing = { readonly kind: "retried"; readonly revision: number; readonly value: unknown } | { readonly kind: "returned"; readonly value: unknown } | { readonly kind: "dismissed"; readonly reason: string };

/** The latest of the repeats of one open incident not yet written, and how many there were. */
type Repeats = Pick<Incident, "failure" | "error" | "revision" | "lastAt" | "count">;

/**
 * How long repeats of open incidents wait before they are written, together, in one commit. A durable write holds
 * every response of the world's cell until the bucket proves it (celld's output gate), so a write per failed call
 * held up the world's good calls too: under celld dev, 50 failing calls a second raised a good call's p50 from 4 to
 * 34 ms. A crash loses at most this much of the repeat counts, never an incident.
 */
export const REPEATS_FLUSH_MS: number = 30_000;

/**
 * A world's incidents: each failed call of a definition, numbered, with what closed it. Opening or closing an incident
 * is one durable commit, by default the session's; repeats of an open incident are counted in memory, shown to
 * readers merged with what is stored, and written together at most every `REPEATS_FLUSH_MS`, or before a retry or a
 * close changes the incident. This object is the only writer, so it keeps its cache current. `changed` is told
 * whenever the set of open incidents changes.
 */
export class IncidentLog {
	private readonly log: NumberedLog<Incident>;
	private pending: Map<number, Repeats> = new Map();
	private flushing: Promise<void> = Promise.resolve();
	private scheduled: boolean = false;

	constructor(
		session: Pick<Session, "snapshot">,
		private readonly sessionCommit: Commit,
		private state: Incidents,
		private readonly now: () => number,
		private readonly changed: () => void,
		/** Runs the flush of repeats later; a timer by default. */
		private readonly later: (run: () => void, ms: number) => void = (run, ms) => void setTimeout(run, ms),
	) {
		this.log = new NumberedLog(session, WorldIncident, "incident");
	}

	static async load(session: Pick<Session, "snapshot">): Promise<Incidents> {
		return (await session.snapshot(WorldIncidents, BACKGROUND_CONTEXT)) ?? { count: 0, open: {} };
	}

	openCount(): number {
		return Object.keys(this.state.open).length;
	}

	/** Every open incident, newest first. */
	async openOnes(): Promise<Incident[]> {
		return Promise.all(Object.values(this.state.open).sort((a, b) => b - a).map(async (n) => this.withRepeats(await this.log.require(n))));
	}

	async get(n: number): Promise<Incident | undefined> {
		const incident = await this.log.get(n);
		return incident && this.withRepeats(incident);
	}

	/** Newest first. */
	async list(limit: number, before?: number): Promise<Incident[]> {
		return (await this.log.newestFirst(this.state.count, limit, before)).map((incident) => this.withRepeats(incident));
	}

	async requireOpen(n: number): Promise<Incident> {
		return assertOpen(this.withRepeats(await this.log.require(n)));
	}

	/** An incident as stored, with the repeats counted since its last write. */
	private withRepeats(incident: Incident): Incident {
		const repeats = this.pending.get(incident.n);
		return repeats ? { ...incident, ...repeats, count: incident.count + repeats.count } : incident;
	}

	/** Record a failed call: one more failure of the open incident with its key, counted for the next flush, or a new incident. */
	async record(call: FailedCall, commit: Commit = this.sessionCommit): Promise<number> {
		const at = this.now();
		const key = incidentKey(call.name, call.error);
		const open = this.state.open[key];
		if (open !== undefined) {
			const before = this.pending.get(open);
			this.pending.set(open, { failure: call.failure, error: call.error, revision: call.revision, lastAt: at, count: (before?.count ?? 0) + 1 });
			if (!this.scheduled) {
				this.scheduled = true;
				this.later(() => {
					this.scheduled = false;
					void this.flush().catch(() => undefined);
				}, REPEATS_FLUSH_MS);
			}
			return open;
		}
		const args = JSON.stringify(call.args).length <= MAX_ARGS_JSON ? { args: call.args } : {};
		const { incident, state } = await commit(async (tx) => {
			const doc = await tx.doc(WorldIncidents);
			const n = doc.count as number;
			const incident: Incident = { n, key, name: call.name, ...args, failure: call.failure, error: call.error, revision: call.revision, at, lastAt: at, count: 1, retries: 0 };
			await tx.doc(WorldIncident, String(n), incident as Incident & JsonObject);
			doc.count = n + 1;
			(doc.open as Record<string, number>)[key] = n;
			return { incident, state: plain<Incidents>(doc) };
		});
		this.state = state;
		this.log.remember(incident.n, incident);
		this.changed();
		return incident.n;
	}

	/** A retry of an open incident failed again; it stays open, under the key it was opened with, with the new error. */
	async retryFailed(n: number, failure: Failure, error: string, revision: number, commit: Commit = this.sessionCommit): Promise<Incident> {
		await this.flush();
		return this.update(n, (incident) => (assertOpen(incident) && { failure, error, revision, lastAt: this.now(), retries: incident.retries + 1 }), commit);
	}

	/** Close an open incident: retried, answered with a value, or dismissed with a reason. */
	async close(n: number, by: Origin["by"], closing: Closing, commit: Commit = this.sessionCommit): Promise<Incident> {
		if (closing.kind === "dismissed" && !closing.reason.trim()) throw new Error("dismissing an incident needs a reason");
		await this.flush();
		const resolution = { ...closing, at: this.now(), by } as Resolution;
		const incident = await this.update(n, (stored) => (assertOpen(stored) && { resolution }), commit, (open, stored) => delete open[stored.key]);
		this.changed();
		return incident;
	}

	/**
	 * Write the counted repeats, every incident in one commit of the session's. Flushes run one at a time; a flush that
	 * fails puts its repeats back for the next.
	 */
	flush(): Promise<void> {
		this.flushing = this.flushing.catch(() => undefined).then(async () => {
			if (this.pending.size === 0) return;
			const repeats = this.pending;
			this.pending = new Map();
			try {
				await Promise.all([...repeats.keys()].map((n) => this.log.require(n)));
				const updated = await this.sessionCommit(async (tx) => {
					const written: Incident[] = [];
					for (const [n, { count, ...latest }] of repeats) {
						const draft = await tx.doc(WorldIncident, String(n), {} as Incident & JsonObject);
						Object.assign(draft, plain({ ...latest, count: (draft.count as number) + count }));
						written.push(plain<Incident>(draft));
					}
					return written;
				});
				for (const incident of updated) this.log.remember(incident.n, incident);
			} catch (error) {
				for (const [n, r] of repeats) {
					const newer = this.pending.get(n);
					this.pending.set(n, newer ? { ...newer, count: newer.count + r.count } : r);
				}
				throw error;
			}
		});
		return this.flushing;
	}

	/**
	 * One commit that sets some fields of one stored incident, and changes the open index when `index` is given. The
	 * incident must exist: reading a family document with a seed would otherwise create one.
	 */
	private async update(
		n: number,
		change: (incident: Incident) => Partial<Incident>,
		commit: Commit,
		index?: (open: Record<string, number>, incident: Incident) => void,
	): Promise<Incident> {
		await this.log.require(n);
		const { incident, state } = await commit(async (tx) => {
			const doc = await tx.doc(WorldIncidents);
			const draft = await tx.doc(WorldIncident, String(n), {} as Incident & JsonObject);
			Object.assign(draft, plain(change(draft as unknown as Incident)));
			const incident = plain<Incident>(draft);
			index?.(doc.open as Record<string, number>, incident);
			return { incident, state: plain<Incidents>(doc) };
		});
		this.state = state;
		this.log.remember(n, incident);
		return incident;
	}
}

function assertOpen(incident: Incident): Incident {
	if (incident.resolution) throw new Error(`incident ${incident.n} is already closed (${incident.resolution.kind})`);
	return incident;
}
