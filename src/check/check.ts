/**
 * A check is an expression evaluated in the world after each attempt; the attempt is accepted only if every enrolled
 * check returns exactly `true`. Checks are stored by the host, outside the heap, so world code cannot change them.
 */
export interface Check {
	readonly name: string;
	readonly expression: string;
	/** The develop source that was seen breaking this check at enrolment. */
	readonly counterexample: string;
	readonly enrolledAt: number;
}

export interface RemovedCheck {
	readonly check: Check;
	readonly reason: string;
	readonly removedAt: number;
}
