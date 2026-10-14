import type { RunRecord, Verdict } from "./result.ts";

/**
 * The best value each verdict's metric has ever measured, per target kind and scenario. A newer result that is worse
 * than the best by more than the tolerance is a regression, even when it still meets its objective: the objective
 * is the floor, the best-ever is the peg.
 */
export type Baselines = Record<string, { readonly best: number; readonly at: string; readonly git: string }>;

export interface Comparison {
	readonly key: string;
	readonly measured: number;
	readonly best: number | undefined;
	readonly regressed: boolean;
	readonly improved: boolean;
}

/** Latency noise between runs of one build on one machine; tighter would ratchet on noise (a false red). */
export const TOLERANCE: number = 0.25;

/** Latencies and counts of failures are better lower; counts of worlds and counters are better higher. */
export function higherIsBetter(verdict: Verdict): boolean {
	return verdict.objective === "O5a" || verdict.objective === "correctness";
}

export function key(record: RunRecord, verdict: Verdict): string {
	return `${record.target.kind}/${record.scenario}/${verdict.objective}/${verdict.metric}`;
}

export function compare(records: readonly RunRecord[], baselines: Baselines): Comparison[] {
	return records.flatMap((record) =>
		record.verdicts
			.filter((v) => !v.invalid)
			.map((v) => {
				const k = key(record, v);
				const best = baselines[k]?.best;
				const up = higherIsBetter(v);
				const slack = Math.max(Math.abs(best ?? 0) * TOLERANCE, up ? 0 : 1);
				const regressed = best !== undefined && (up ? v.measured < best - (v.objective === "correctness" ? 0 : slack) : v.measured > best + slack);
				const improved = best === undefined || (up ? v.measured > best : v.measured < best);
				return { key: k, measured: v.measured, best, regressed, improved };
			}),
	);
}

/** Baselines moved to every improvement among `records`; regressions never move them. */
export function advance(records: readonly RunRecord[], baselines: Baselines): Baselines {
	const next: Baselines = { ...baselines };
	for (const record of records) {
		for (const v of record.verdicts) {
			if (v.invalid) continue;
			const k = key(record, v);
			const best = next[k]?.best;
			const better = best === undefined || (higherIsBetter(v) ? v.measured > best : v.measured < best);
			if (better) next[k] = { best: v.measured, at: record.startedAt, git: record.git };
		}
	}
	return next;
}
