import type { DataRow } from "./data-port.ts";
import type { DataChanges } from "./overlay-data-port.ts";
import type { Outcome } from "./world-vm.ts";

/** The head a call runs at: its revision and the content hash of the blob holding its snapshot. */
export interface HeadRef {
	readonly revision: number;
	readonly blob: string;
}

export type ExecuteResult = Outcome & { readonly rolledBack: DataChanges };

/**
 * Where a world's calls run, and where its data lives: in the world's own process, or in an isolate of its own. A call
 * from another world brings `chain`, the worlds it passed through; a call that starts here passes an empty one.
 */
export interface CallRunner {
	call(name: string, args: readonly unknown[], chain: readonly string[], head: HeadRef): Promise<Outcome>;
	/** A preview: heap changes and data writes are rolled back; the result names the writes. */
	execute(expression: string, chain: readonly string[], head: HeadRef): Promise<ExecuteResult>;
	dataList(prefix: string): Promise<readonly DataRow[]>;
	dataDelete(key: string): Promise<boolean>;
	dispose(): void;
}
