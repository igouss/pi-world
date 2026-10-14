/** What a replay ends shrinking with. */
export const STOP: unique symbol = Symbol("stop");

/** A replay's answer: the choices it drew when it failed, undefined when it passed, or `STOP`. */
export type Replay = readonly number[] | undefined | typeof STOP;

/**
 * The smallest choice sequence found that still fails, starting from one that fails. Smaller means shorter, then
 * lexicographically lower. Each pass tries deleting runs of choices, then lowering single choices (to 0, halved, minus
 * one, never below 0), and keeps any candidate that still fails; passes repeat until none helps or `budget` tries are spent. No candidate is replayed twice.
 *
 * `fails` replays a candidate and returns the choices the replay actually drew, or undefined when it passes; a replay
 * can draw fewer choices than it was given, and the drawn ones are what is kept. A replay that returns `STOP` ends
 * the shrinking at the smallest sequence found before it.
 */
export async function shrink(start: readonly number[], fails: (choices: readonly number[]) => Promise<Replay>, budget: number): Promise<readonly number[]> {
	let best = start;
	let tries = 0;
	let stopped: boolean = false;
	const tried = new Set<string>();
	const attempt = async (candidate: readonly number[]): Promise<boolean> => {
		const key = candidate.join(",");
		if (stopped || tries >= budget || !smaller(candidate, best) || tried.has(key)) return false;
		tried.add(key);
		tries++;
		const drawn = await fails(candidate);
		if (drawn === STOP) {
			stopped = true;
			return false;
		}
		if (drawn === undefined || !smaller(drawn, best)) return false;
		best = drawn;
		return true;
	};
	for (let improved = true; improved && !stopped && tries < budget; ) {
		improved = false;
		for (const size of [8, 4, 2, 1])
			for (let i = 0; i + size <= best.length; )
				if (await attempt([...best.slice(0, i), ...best.slice(i + size)])) improved = true;
				else i++;
		for (let i = 0; i < best.length; i++)
			for (const lower of lowerChoices(best[i]!))
				if (await attempt(best.map((value, j) => (j === i ? lower : value)))) {
					improved = true;
					break;
				}
	}
	return best;
}

/** Values to try in place of choice `value`, smallest first: 0, half of it, one less; none below 0. */
function lowerChoices(value: number): number[] {
	return [...new Set([0, Math.floor(value / 2), value - 1])].filter((lower) => lower >= 0 && lower < value);
}

/** Shorter first, then lexicographically lower. */
export function smaller(a: readonly number[], b: readonly number[]): boolean {
	if (a.length !== b.length) return a.length < b.length;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i]! < b[i]!;
	return false;
}
