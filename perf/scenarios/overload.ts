import { OBJECTIVES } from "../objectives.ts";
import { CURRENCY } from "../lib/fixtures.ts";
import type { Scenario } from "../lib/scenario.ts";

/**
 * O8: twice the rated read-only rate into one world. Excess must be refused explicitly within 1 s, and the requests
 * that are accepted must keep O1a's p99.
 */
export const overload: Scenario = {
	id: "overload",
	title: "Overload at twice the rated rate",
	objectives: ["O8"],
	params: { rate: OBJECTIVES.O6a.rate * OBJECTIVES.O8.factor, duration: 30, warmup: 5 },
	async run(ctx) {
		const id = await ctx.fixture.world("currency", CURRENCY);
		await ctx.api.mustCall(id, "convert", [1, "USD", "EUR"]);
		const [run] = await ctx.load(
			"twice rated",
			[{ name: "convert", rate: ctx.param("rate", OBJECTIVES.O6a.rate * OBJECTIVES.O8.factor), arrivals: "poisson", maxInFlight: 4096, request: () => ctx.api.callReply(id, "convert", [1, "USD", "EUR"]) }],
			{ warmupS: ctx.param("warmup", 5), durationS: ctx.param("duration", 30), drainS: 60 },
		);
		ctx.verdict({ objective: "O8", metric: "accepted p99 ms", measured: run!.ok.p99Ms, limit: OBJECTIVES.O1a.p99Ms, holds: run!.ok.p99Ms <= OBJECTIVES.O1a.p99Ms });
		const refused = run!.failed.count;
		ctx.verdict({ objective: "O8", metric: "refusals: p99 ms to the refusal", measured: refused === 0 ? 0 : run!.failed.p99Ms, limit: OBJECTIVES.O8.maxRefusalMs, holds: refused === 0 || run!.failed.p99Ms <= OBJECTIVES.O8.maxRefusalMs });
		ctx.verdict({ objective: "O8", metric: "max wait of any request ms", measured: Math.max(run!.ok.maxMs, run!.failed.maxMs), limit: OBJECTIVES.O8.maxQueueMs, holds: Math.max(run!.ok.maxMs, run!.failed.maxMs) <= OBJECTIVES.O8.maxQueueMs });
	},
};
