import type { Check } from "../check/check.ts";
import type { Enrolment } from "./attempt.ts";
import type { CatalogueChanges } from "./catalogue-diff.ts";
import type { AttemptMode, CatalogueEntry, Failure } from "./world-vm.ts";

/** A heap the workbench made, ready to commit: its serialized snapshot, that snapshot's content hash, and its definitions. */
export interface Heap {
	readonly bytes: Uint8Array;
	readonly blob: string;
	readonly catalogue: readonly CatalogueEntry[];
}

export type Developed =
	| { readonly accepted: true; readonly heap: Heap; readonly changes: CatalogueChanges }
	| { readonly accepted: false; readonly failure: Failure | "check"; readonly reason: string; readonly check?: string };

/** A check as enrolment tries it: what it evaluates, the counterexample it must fail on, and its generator. */
export type Candidate = Pick<Check, "expression" | "counterexample" | "generator">;

/**
 * Where a world's changes do their VM work: in this process, or in the world's own isolate, so that the CPU a develop
 * and its checks spend holds up only that world. Every operation names the head blob the caller holds; the workbench
 * keeps its VM at a blob of its own and restores the head's whenever the two differ, so a commit that failed, an
 * evicted isolate or a rollback needs no other protocol. The caller keeps durability: it stores a heap and commits it,
 * or not.
 */
export interface Workbench {
	/** Revision 0: the prelude alone. */
	genesis(): Promise<Heap>;
	/** The head's definitions; when the head was built by an older prelude, also the heap upgraded to the current one. */
	open(head: string, prelude: number): Promise<{ readonly catalogue: readonly CatalogueEntry[]; readonly upgraded: Heap | undefined }>;
	/** Attempt a develop source on the head, under the enrolled checks (`attemptDevelop`). */
	develop(head: string, source: string, checks: readonly Check[], mode: AttemptMode): Promise<Developed>;
	/** Try a check for enrolment on the head (`attemptEnrolment`). */
	enrol(head: string, candidate: Candidate, mode: AttemptMode): Promise<Enrolment>;
	/** The heap of an earlier revision, brought up to the current prelude, as the next head. */
	rollback(target: string, prelude: number): Promise<Heap>;
	dispose(): void;
}
