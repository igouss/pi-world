import { firstLine } from "../api/text.ts";
import type { Origin } from "../revision/revision.ts";
import type { Failure, Outcome } from "../world/world-vm.ts";

/** How an incident was closed: by a retry that succeeded, by a value the owner returned, or dismissed. */
export type Resolution =
	| { readonly kind: "retried"; readonly at: number; readonly by: Origin["by"]; readonly revision: number; readonly value: unknown }
	| { readonly kind: "returned"; readonly at: number; readonly by: Origin["by"]; readonly value: unknown }
	| { readonly kind: "dismissed"; readonly at: number; readonly by: Origin["by"]; readonly reason: string };

/**
 * A call of a definition that failed, kept so the owner or the agent can fix the definition and retry the call
 * instead of losing it. Failures of the same definition with the same error, while one is open, count into it.
 */
export interface Incident {
	readonly n: number;
	/** The `incidentKey` it was opened under, which keeps it in the open index until it closes. */
	readonly key: string;
	readonly name: string;
	/** The call's arguments, to retry it with; absent when they were too large to keep. */
	readonly args?: readonly unknown[];
	readonly failure: Failure;
	/** The error of the latest failure, the first one or a failed retry. */
	readonly error: string;
	/** The revision of the latest failure. */
	readonly revision: number;
	readonly at: number;
	readonly lastAt: number;
	/** How many calls failed this way while the incident was open. */
	readonly count: number;
	/** How many retries failed. */
	readonly retries: number;
	readonly resolution?: Resolution;
}

export interface Incidents {
	/** How many incidents there are; the next one is numbered `count`. */
	readonly count: number;
	/** The open incidents, by `incidentKey`. */
	readonly open: Readonly<Record<string, number>>;
}

/** The largest arguments, as JSON, an incident keeps so the call can be retried. */
export const MAX_ARGS_JSON: number = 64 * 1024;

/** Which open incident a failure counts into: the same definition failing with the same first line of error. */
export function incidentKey(name: string, error: string): string {
	return `${name}\n${firstLine(error)}`;
}

/** A failed call's outcome with the incident it was recorded as. */
export type CallOutcome = Outcome & { readonly incident?: number };
