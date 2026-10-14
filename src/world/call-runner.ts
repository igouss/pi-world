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
 * Where a world's calls run: in this process, or in an isolate of the world's own. A call from another world brings
 * `chain`, the worlds it passed through; a call that starts here passes an empty one.
 */
export interface CallRunner {
	call(name: string, args: readonly unknown[], chain: readonly string[], scope: CallScope): Promise<Outcome>;
	/** A preview: heap changes and data writes are rolled back; the result names the writes. */
	execute(expression: string, scope: CallScope): Promise<ExecuteResult>;
	dispose(): void;
}

/** The world's data as its owner manages it, outside any call. */
export interface DataAdmin {
	list(prefix: string): Promise<readonly DataRow[]>;
	delete(key: string): Promise<boolean>;
}
