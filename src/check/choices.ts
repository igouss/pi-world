/**
 * The choices that make one generated input. Each draw asks for an integer in [0, bound]; it comes from `prefix` while
 * that lasts, then from `random`, then is 0. Replaying the recorded draws as a prefix gives the same input, and a
 * shorter or smaller prefix gives a simpler one, which is what shrinking relies on.
 */
export class Choices {
	private readonly drawn: number[] = [];
	private readonly prefix: readonly number[];
	private readonly random: (() => number) | undefined;

	constructor(
		prefix: readonly number[],
		random?: () => number,
	) {
		this.prefix = prefix;
		this.random = random;
	}

	next(bound: number): number {
		const i = this.drawn.length;
		const value = i < this.prefix.length ? Math.min(this.prefix[i]!, bound) : this.random ? Math.floor(this.random() * (bound + 1)) : 0;
		this.drawn.push(value);
		return value;
	}

	/** The draws made so far. */
	record(): readonly number[] {
		return this.drawn;
	}
}
