import { OBJECTIVES } from "../objectives.ts";
import { CURRENCY, propertyCheck, SPIN, TODOS } from "../lib/fixtures.ts";
import type { Stream } from "../lib/open-loop.ts";
import type { Scenario } from "../lib/scenario.ts";

/**
 * O4, O9: how long one world can hold up another. A victim world answers `convert` at 10/s throughout; each phase adds
 * one aggressor in a different world: a call that computes, a flood of cheap calls, a develop that computes, and a develop
 * with property checks.
 * The victim's p99 in each phase is judged against its own baseline plus O4's rise.
 */
export const stall: Scenario = {
	id: "stall",
	title: "Stall one world causes another",
	objectives: ["O4", "O9"],
	params: { duration: 30, warmup: 5, spin: 3_000_000, aggressorRate: 1, floodRate: 200 },
	async run(ctx) {
		const victim = await ctx.fixture.world("victim", CURRENCY);
		const busy = await ctx.fixture.world("aggressor", SPIN + TODOS);
		let checks = true;
		for (let i = 0; i < 3 && checks; i++) checks = await ctx.api.enrol(busy, propertyCheck(i));
		if (!checks) ctx.note("the target cannot enrol checks over REST, so the property-check phase runs a develop with none");
		await ctx.api.mustCall(victim, "convert", [1, "USD", "EUR"]);
		const spin = ctx.param("spin", 3_000_000);
		const aggressorRate = ctx.param("aggressorRate", 1);
		const window = { warmupS: ctx.param("warmup", 5), durationS: ctx.param("duration", 30), drainS: 120 };
		const victimStream = (): Stream => ({ name: "victim convert", rate: OBJECTIVES.O4.victimRate, arrivals: "poisson", maxInFlight: 4096, request: () => ctx.api.callReply(victim, "convert", [1, "USD", "EUR"]) });
		const aggressor = (name: string, request: (i: number) => Promise<import("../lib/open-loop.ts").Reply>): Stream => ({ name, rate: aggressorRate, arrivals: "uniform", maxInFlight: 64, request });

		const [baseline] = await ctx.load("baseline", [victimStream()], window);
		const phases: readonly { name: string; stream: Stream }[] = [
			{ name: "a call computing", stream: aggressor(`call spin(${spin})`, () => ctx.api.callReply(busy, "spin", [spin])) },
			{
				name: "a world flooded with cheap calls",
				stream: { name: `stats @ ${ctx.param("floodRate", 200)}/s`, rate: ctx.param("floodRate", 200), arrivals: "poisson", maxInFlight: 4096, request: () => ctx.api.callReply(busy, "stats", []) },
			},
			{ name: "a develop computing", stream: aggressor(`develop running spin(${spin})`, (i) => ctx.api.developReply(busy, `const r${i % 2} = spin(${spin});`)) },
			{ name: "a develop with 3 property checks", stream: aggressor("develop with property checks", (i) => ctx.api.developReply(busy, `define("stats", () => ({ open: 0, done: 0, total: 0, n: ${i} - ${i} }));`)) },
		];
		for (const phase of phases) {
			const [victimRun, aggressorRun] = await ctx.load(phase.name, [victimStream(), phase.stream], window);
			ctx.verdict({
				objective: "O4",
				metric: `victim p99 rise with ${phase.name} (ms)`,
				measured: Math.round((victimRun!.ok.p99Ms - baseline!.ok.p99Ms) * 10) / 10,
				limit: OBJECTIVES.O4.maxRiseMs,
				holds: victimRun!.ok.p99Ms - baseline!.ok.p99Ms <= OBJECTIVES.O4.maxRiseMs,
			});
			ctx.verdict({ objective: "O9", metric: `${phase.stream.name} service max (ms)`, measured: aggressorRun!.service.maxMs, limit: OBJECTIVES.O9.maxHoldMs, holds: aggressorRun!.service.maxMs <= OBJECTIVES.O9.maxHoldMs });
		}
	},
};
