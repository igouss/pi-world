import { OBJECTIVES } from "../objectives.ts";
import { TODOS } from "../lib/fixtures.ts";
import type { Scenario } from "../lib/scenario.ts";

/** O1b, O6b, O7: Demo todos' `setTodo` (one data write per call, over 50 keys) at the rated rate, warm. */
export const writeCall: Scenario = {
	id: "write-call",
	title: "Direct call writing one key at the rated rate",
	objectives: ["O1b", "O6b", "O7"],
	params: { rate: OBJECTIVES.O6b.rate, duration: 60, warmup: 10, keys: 50 },
	async run(ctx) {
		const id = await ctx.fixture.world("todos", TODOS);
		const keys = ctx.param("keys", 50);
		await ctx.api.mustCall(id, "setTodo", ["k0", "warm"]);
		const rate = ctx.param("rate", OBJECTIVES.O6b.rate);
		const [set] = await ctx.load(
			"steady",
			[{ name: "setTodo", rate, arrivals: "poisson", maxInFlight: 4096, request: (i) => ctx.api.callReply(id, "setTodo", [`k${i % keys}`, `text ${i}`]) }],
			{ warmupS: ctx.param("warmup", 10), durationS: ctx.param("duration", 60) },
		);
		ctx.judgeLatency("O1b", set!, OBJECTIVES.O1b);
		ctx.judgeFailures(rate >= OBJECTIVES.O6b.rate ? "O6b" : "O7", set!, OBJECTIVES.O7.maxFailures);
	},
};
