import type { Failure } from "../world/world-vm.ts";
import type { Origin } from "./revision.ts";

/**
 * What a rejected attempt tried and why it was turned away: a develop source that failed to evaluate or broke a
 * check, or a proposed check whose enrolment was refused.
 */
export type Attempted =
	| { readonly kind: "develop"; readonly source: string; readonly failure: Failure | "check"; readonly check?: string }
	| { readonly kind: "check"; readonly name: string; readonly expression: string; readonly counterexample: string };

/**
 * A rejected develop or a refused check, numbered in its own sequence. It is kept beside the revisions so a
 * rejection stays queryable after the conversation that produced it is compacted.
 */
export type Rejection = Attempted & RejectionRecord;

export interface RejectionRecord {
	readonly n: number;
	/** The head revision the attempt ran against. */
	readonly base: number;
	readonly summary: string;
	readonly at: number;
	readonly origin: Origin;
	readonly reason: string;
}

export interface Rejections {
	/** How many rejections there are; the next one is numbered `count`. */
	readonly count: number;
	/** Tool calls that produced a rejection, so a rerun after a crash returns the same rejection. */
	readonly calls: Readonly<Record<string, number>>;
}

/** Why a rejection happened, in a few words: the check a develop broke, how it failed, or a refused enrolment. */
export function rejectionCause(rejection: Attempted): string {
	if (rejection.kind === "check") return "refused";
	return rejection.check ? `broke the check "${rejection.check}"` : rejection.failure;
}
