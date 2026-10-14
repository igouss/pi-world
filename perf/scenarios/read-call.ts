import { OBJECTIVES } from "../objectives.ts";
import { CURRENCY } from "../lib/fixtures.ts";
import type { Scenario } from "../lib/scenario.ts";

/** O1a, O6a, O7: Currency's `convert` (read-only) at the rated rate, warm. */
export const readCall: Scenario = {
	id: "read-call",
	title: "Direct read-only call at the rated rate",
	objectives: ["O1a", "O6a", "O7"],
	params: { rate: OBJECTIVES.O6a.rate, duration: 60, warmup: 10 },
	async run(ctx) {
		const id = await ctx.fixture.world("currency", CURRENCY);
		await ctx.api.mustCall(id, "convert", [100, "USD", "JPY"]);
		const rate = ctx.param("rate", OBJECTIVES.O6a.rate);
		const [convert] = await ctx.load(
			"steady",
			[{ name: "convert", rate, arrivals: "poisson", maxInFlight: 4096, request: () => ctx.api.callReply(id, "convert", [100, "USD", "JPY"]) }],
			{ warmupS: ctx.param("warmup", 10), durationS: ctx.param("duration", 60) },
		);
		ctx.judgeLatency("O1a", convert!, OBJECTIVES.O1a);
		ctx.judgeFailures(rate >= OBJECTIVES.O6a.rate ? "O6a" : "O7", convert!, OBJECTIVES.O7.maxFailures);
	},
};
