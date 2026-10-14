import { OBJECTIVES } from "../objectives.ts";
import { CURRENCY, dashboard, tripBudget } from "../lib/fixtures.ts";
import type { Scenario } from "../lib/scenario.ts";

/** O2: Dashboard → Trip budget → Currency, the node's own chain of three worlds, read-only at 10 calls/s. */
export const chain: Scenario = {
	id: "chain",
	title: "Chain of three worlds",
	objectives: ["O2", "O7"],
	params: { rate: OBJECTIVES.O2.rate, duration: 60, warmup: 10 },
	async run(ctx) {
		const currency = await ctx.fixture.world("currency", CURRENCY);
		const trip = await ctx.fixture.world("trip", tripBudget(currency));
		const dash = await ctx.fixture.world("dashboard", dashboard(trip));
		await ctx.api.mustCall(trip, "addExpense", ["ramen", 1200]);
		await ctx.api.mustCall(trip, "addExpense", ["train", 14000]);
		const warm = (await ctx.api.mustCall(dash, "tripIn", ["USD"])) as { error?: string };
		if (warm.error) throw new Error(`the chain does not answer: ${warm.error}`);
		const rate = ctx.param("rate", OBJECTIVES.O2.rate);
		const direct = { name: "convert (one world)", rate, arrivals: "poisson" as const, maxInFlight: 4096, request: () => ctx.api.callReply(currency, "convert", [15200, "JPY", "USD"]) };
		const chained = { name: "tripIn (three worlds)", rate, arrivals: "poisson" as const, maxInFlight: 4096, request: () => ctx.api.callReply(dash, "tripIn", ["USD"], (value) => (value as { error?: string })?.error) };
		const [one, three] = await ctx.load("steady", [direct, chained], { warmupS: ctx.param("warmup", 10), durationS: ctx.param("duration", 60) });
		ctx.judgeLatency("O2", three!, OBJECTIVES.O2);
		ctx.judgeFailures("O7", three!, OBJECTIVES.O7.maxFailures);
		ctx.note(`a chain of three costs ${(three!.ok.p50Ms - one!.ok.p50Ms).toFixed(1)} ms at p50 over one direct call`);
	},
};
