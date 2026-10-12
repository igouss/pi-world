import type { Generator } from "./generator.ts";

/**
 * A check is an expression evaluated in the world after each attempt; the attempt is accepted only if every enrolled
 * check returns exactly `true`. A property check has a generator, and its expression must be `true` for every
 * generated `input`. Checks are stored by the host, outside the heap, so world code cannot change them.
 */
export interface Check {
	readonly name: string;
	readonly expression: string;
	/** For a property check, how its `input` is generated. */
	readonly generator?: Generator;
	/** The develop source that was seen breaking this check at enrolment, as evaluated after the host rewrite. */
	readonly counterexample: string;
	/** The counterexample as written, when the host rewrite changed it. */
	readonly written?: string;
	readonly enrolledAt: number;
}

export interface RemovedCheck {
	readonly check: Check;
	readonly reason: string;
	readonly removedAt: number;
}
