import { OBJECTIVES } from "../objectives.ts";
import { CURRENCY, TODOS } from "../lib/fixtures.ts";
import type { Scenario } from "../lib/scenario.ts";

/**
 * O1a, O9: a failed call of a defined function is an incident, recorded with a durable commit in the world's cell. A
 * caller sending a bad currency to `convert` at `badRate` while good calls arrive at `rate` shows what the failures
 * cost the good calls of the same world, against O1a. Two controls separate the cause: failures that record nothing
 * (a name the world does not define), and calls that write data in the runtime facet instead of the cell.
 */
export const failureStorm: Scenario = {
	id: "failure-storm",
	title: "Failing calls beside good ones in one world",
	objectives: ["O1a", "O9"],
	params: { rate: 50, badRate: 50, duration: 30, warmup: 5 },
	async run(ctx) {
		const id = await ctx.fixture.world("currency", CURRENCY + TODOS);
		await ctx.api.mustCall(id, "convert", [1, "USD", "EUR"]);
		const window = { warmupS: ctx.param("warmup", 5), durationS: ctx.param("duration", 30), drainS: 60 };
		const good = () => ({ name: "good convert", rate: ctx.param("rate", 50), arrivals: "poisson" as const, maxInFlight: 4096, request: () => ctx.api.callReply(id, "convert", [1, "USD", "EUR"]) });
		const [alone] = await ctx.load("good calls alone", [good()], window);
		const bad = {
			name: "failing convert",
			rate: ctx.param("badRate", 50),
			arrivals: "poisson" as const,
			maxInFlight: 4096,
			// The failure is the expected answer here: an incident, status 422.
			request: async () => {
				const { status, body } = await ctx.api.call(id, "convert", [1, "USD", "XXX"]);
				return status === 422 && body.ok === false ? ({ ok: true } as const) : ({ ok: false, kind: `${status}` } as const);
			},
		};
		// The control: calls of a name the world does not define fail as often, but record no incident.
		const unrecorded = {
			...bad,
			name: "failing call of an undefined name",
			request: async () => {
				const { status, body } = await ctx.api.call(id, "nope", []);
				return status === 422 && body.ok === false ? ({ ok: true } as const) : ({ ok: false, kind: `${status}` } as const);
			},
		};
		const [withUnrecorded] = await ctx.load("good calls beside failures that record nothing", [good(), unrecorded], window);
		// The other control: calls that write data, in the world's runtime facet rather than its cell, as often.
		const writing = { ...bad, name: "writing setTodo", request: (i: number) => ctx.api.callReply(id, "setTodo", [`k${i % 50}`, "x"]) };
		const [withWrites] = await ctx.load("good calls beside calls that write data", [good(), writing], window);
		const [withFailures, failures] = await ctx.load("good calls beside failing ones", [good(), bad], window);
		ctx.judgeLatency("O1a", alone!, OBJECTIVES.O1a);
		ctx.judgeLatency("O1a", { ...withUnrecorded!, name: "good convert beside failures that record nothing" }, OBJECTIVES.O1a);
		ctx.judgeLatency("O1a", { ...withWrites!, name: "good convert beside data writes" }, OBJECTIVES.O1a);
		ctx.judgeLatency("O1a", { ...withFailures!, name: "good convert beside failures" }, OBJECTIVES.O1a);
		ctx.verdict({ objective: "O9", metric: "failing call p99 ms (each records an incident)", measured: failures!.ok.p99Ms, limit: OBJECTIVES.O9.maxHoldMs, holds: failures!.ok.p99Ms <= OBJECTIVES.O9.maxHoldMs });
	},
};
