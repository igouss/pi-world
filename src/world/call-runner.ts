import type { DataRow } from "./data-port.ts";
import type { Grants } from "./grants.ts";
import type { DataChanges } from "./overlay-data-port.ts";
import type { Outcome } from "./world-vm.ts";

/** The head a call runs at: its revision and the content hash of the blob holding its snapshot. */
export interface HeadRef {
	readonly revision: number;
	readonly blob: string;
}

/**
 * The world as a call found it when it arrived: the head it runs at, what the world's grants let it reach, and the
 * latest time it may start, in epoch milliseconds. A call that cannot start by then is refused as busy, so a world
 * whose isolate is saturated refuses work instead of queueing it without bound.
 */
export interface CallScope {
	readonly head: HeadRef;
	readonly grants: Grants;
	readonly startBy: number;
}

export type ExecuteResult = Outcome & { readonly rolledBack: DataChanges };

/**
 * A call the world refused without running it, because it could not start within its deadline. It is not an outcome
 * of world code, so it is never an incident and a caller may simply try again.
 */
export interface Refused {
	readonly ok: false;
	readonly refused: "busy";
	readonly error: string;
}

export const BUSY_REFUSAL: Refused = { ok: false, refused: "busy", error: "the world is busy: the call could not start within a second of arriving; try again" };

export function isRefused(answer: object): answer is Refused {
	return "refused" in answer;
}

/** What kind of failure or refusal a call came back with. */
export function failureKind(answer: Exclude<Outcome, { ok: true }> | Refused): string {
	return isRefused(answer) ? answer.refused : answer.failure;
}

/** A failed or refused call, as one line for a person or the agent: its kind, then its error. */
export function failureText(answer: Exclude<Outcome, { ok: true }> | Refused): string {
	return `${failureKind(answer)}: ${answer.error}`;
}

/**
 * Where a world's calls run: in this process, or in an isolate of the world's own. A call from another world brings
 * `chain`, the worlds it passed through; a call that starts here passes an empty one.
 */
export interface CallRunner {
	call(name: string, args: readonly unknown[], chain: readonly string[], scope: CallScope): Promise<Outcome | Refused>;
	/** A preview: heap changes and data writes are rolled back; the result names the writes. */
	execute(expression: string, scope: CallScope): Promise<ExecuteResult | Refused>;
	dispose(): void;
}

/** The world's data as its owner manages it, outside any call. */
export interface DataAdmin {
	list(prefix: string): Promise<readonly DataRow[]>;
	delete(key: string): Promise<boolean>;
}
