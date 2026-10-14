/**
 * The objectives the operator approved on 2026-10-14 (bead pw-djz). Every scenario judges its results against these
 * numbers and nothing else, so changing an objective is a change to this file, reviewed like any other.
 *
 * Latencies are measured open loop from the intended start of each request, from a client on the node over loopback
 * (a run from elsewhere is reported but judges nothing it adds network to); warm means the world's runtime isolate is
 * resident and its head snapshot is in the cell.
 */
export const OBJECTIVES = {
	O1a: { title: "Direct call, read-only, warm, at the O6a rate", p50Ms: 10, p99Ms: 50 },
	O1b: { title: "Direct call writing one key, warm, at the O6b rate", p50Ms: 120, p99Ms: 250 },
	O1c: { title: "Cold call: the first after eviction", p99Ms: 1000 },
	O2: { title: "Chain of three worlds, read-only, warm, at 10 calls/s", p50Ms: 30, p99Ms: 100, rate: 10 },
	O3: { title: "Develop with P plain and Q property checks", baseMs: 150, perPlainMs: 10, perPropertyMs: 300, p99Factor: 2 },
	O4: { title: "Stall one world may cause another (victim p99 rise over its baseline)", maxRiseMs: 50, victimRate: 10 },
	O5a: { title: "Resident worlds per node (have run a call)", worlds: 300 },
	O5b: { title: "Registered worlds per node, mostly evicted, with O1c holding", worlds: 5000 },
	O5c: { title: "100 resident worlds at 5 calls/s each, O1a holding", worlds: 100, ratePerWorld: 5 },
	O6a: { title: "Sustained read-only calls per world, O1a holding", rate: 100 },
	O6b: { title: "Sustained writing calls per world, O1b holding", rate: 50 },
	O7: { title: "Errors at or below the rated rate", maxFailures: 0 },
	O8: { title: "Overload at twice the rated rate", factor: 2, maxRefusalMs: 1000, maxQueueMs: 1000 },
	O9: { title: "One operation is bounded", maxHoldMs: 5000 },
} as const;

export type ObjectiveId = keyof typeof OBJECTIVES;

/** O3's bound on a develop's p50 with `plain` plain checks and `property` property checks. */
export function developBoundMs(plain: number, property: number): { p50Ms: number; p99Ms: number } {
	const o = OBJECTIVES.O3;
	const p50Ms = o.baseMs + o.perPlainMs * plain + o.perPropertyMs * property;
	return { p50Ms, p99Ms: p50Ms * o.p99Factor };
}
