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

/**
 * A world's incidents: each failed call of a definition, numbered, with what closed it. Every change is one durable
 * commit, by default the session's; this object is the only writer, so it keeps its cache current. `changed` is told
 * whenever the set of open incidents changes.
 */
export class IncidentLog {
	private readonly log: NumberedLog<Incident>;

	constructor(
		session: Pick<Session, "snapshot">,
		private readonly sessionCommit: Commit,
		private state: Incidents,
		private readonly now: () => number,
		private readonly changed: () => void,
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
	openOnes(): Promise<Incident[]> {
		return Promise.all(Object.values(this.state.open).sort((a, b) => b - a).map((n) => this.log.require(n)));
	}

	get(n: number): Promise<Incident | undefined> {
		return this.log.get(n);
	}

	/** Newest first. */
	list(limit: number, before?: number): Promise<Incident[]> {
		return this.log.newestFirst(this.state.count, limit, before);
	}

	async requireOpen(n: number): Promise<Incident> {
		return assertOpen(await this.log.require(n));
	}

	/** Record a failed call: one more failure of the open incident with its key, or a new incident. */
	async record(call: FailedCall, commit: Commit = this.sessionCommit): Promise<number> {
		const at = this.now();
		const key = incidentKey(call.name, call.error);
		const open = this.state.open[key];
		if (open !== undefined) {
			await this.update(open, (incident) => ({ failure: call.failure, error: call.error, revision: call.revision, lastAt: at, count: incident.count + 1 }), commit);
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
	retryFailed(n: number, failure: Failure, error: string, revision: number, commit: Commit = this.sessionCommit): Promise<Incident> {
		return this.update(n, (incident) => (assertOpen(incident) && { failure, error, revision, lastAt: this.now(), retries: incident.retries + 1 }), commit);
	}

	/** Close an open incident: retried, answered with a value, or dismissed with a reason. */
	async close(n: number, by: Origin["by"], closing: Closing, commit: Commit = this.sessionCommit): Promise<Incident> {
		if (closing.kind === "dismissed" && !closing.reason.trim()) throw new Error("dismissing an incident needs a reason");
		const resolution = { ...closing, at: this.now(), by } as Resolution;
		const incident = await this.update(n, (stored) => (assertOpen(stored) && { resolution }), commit, (open, stored) => delete open[stored.key]);
		this.changed();
		return incident;
	}

	/** One commit that sets some fields of one stored incident, and changes the open index when `index` is given. */
	private async update(
		n: number,
		change: (incident: Incident) => Partial<Incident>,
		commit: Commit,
		index?: (open: Record<string, number>, incident: Incident) => void,
	): Promise<Incident> {
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
