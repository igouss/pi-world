import { OBJECTIVES } from "../objectives.ts";
import { SPIN } from "../lib/fixtures.ts";
import type { Scenario } from "../lib/scenario.ts";

/**
 * O8: calls that compute, at twice what one world's runtime isolate can serve. The service time is measured first
 * with calls one at a time; the overload rate is then twice its reciprocal. O8 asks that the excess be refused within
 * 1 s and that no request wait longer than 1 s.
 */
export const slowOverload: Scenario = {
	id: "slow-overload",
	title: "Computing calls at twice one world's capacity",
	objectives: ["O8"],
	params: { spin: 300_000, duration: 20, warmup: 2 },
	async run(ctx) {
		const id = await ctx.fixture.world("spin", SPIN);
		const spin = ctx.param("spin", 300_000);
		await ctx.api.mustCall(id, "spin", [spin]);
		const [probe] = await ctx.load("service time", [{ name: "spin one at a time", rate: 2, arrivals: "uniform", maxInFlight: 1, request: () => ctx.api.callReply(id, "spin", [spin]) }], { warmupS: 1, durationS: 5 });
		const capacity = 1000 / Math.max(1, probe!.service.p50Ms);
		const rate = Math.round(capacity * OBJECTIVES.O8.factor * 10) / 10;
		ctx.note(`spin(${spin}) takes ${probe!.service.p50Ms} ms at p50, so one isolate serves about ${capacity.toFixed(1)} calls/s; offering ${rate}/s`);
		const [run] = await ctx.load(
			"twice capacity",
			[{ name: `spin at ${rate}/s`, rate, arrivals: "poisson", maxInFlight: 4096, request: () => ctx.api.callReply(id, "spin", [spin]) }],
			{ warmupS: ctx.param("warmup", 2), durationS: ctx.param("duration", 20), drainS: 120 },
		);
		const refused = run!.failed.count;
		ctx.verdict({ objective: "O8", metric: "refused share of the offered calls", measured: Math.round((refused / Math.max(1, run!.intended)) * 1000) / 1000, limit: 0.5, holds: refused / Math.max(1, run!.intended) >= 0.4 });
		ctx.verdict({ objective: "O8", metric: "accepted calls: max wait ms", measured: run!.ok.maxMs, limit: OBJECTIVES.O8.maxQueueMs, holds: run!.ok.maxMs <= OBJECTIVES.O8.maxQueueMs });
		ctx.verdict({ objective: "O8", metric: "refusals: p99 ms to the refusal", measured: refused === 0 ? 0 : run!.failed.p99Ms, limit: OBJECTIVES.O8.maxRefusalMs, holds: refused === 0 || run!.failed.p99Ms <= OBJECTIVES.O8.maxRefusalMs });
	},
};
