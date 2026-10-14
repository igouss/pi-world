import { developBoundMs } from "../objectives.ts";
import { plainCheck, propertyCheck, TODOS } from "../lib/fixtures.ts";
import type { Scenario } from "../lib/scenario.ts";

/** A develop that redefines `stats` to an equivalent body, so every enrolled check still holds and every counterexample still fails. */
function redefinition(i: number): string {
	return `define("stats", () => {
  const todos = listTodos();
  const done = todos.filter(t => t.done).length;
  return { open: todos.length - done, done, total: todos.length, rev: ${i} - ${i} };
});`;
}

/**
 * O3: develops with 0, 1 and 10 plain checks, and 1 and 10 property checks, each in a world of its own. Develops of
 * one world run one at a time under its lock, so the rate stays below one develop per bound.
 */
export const develop: Scenario = {
	id: "develop",
	title: "Develop with N checks",
	objectives: ["O3", "O7"],
	params: { rate: 0.5, duration: 40, warmup: 4 },
	async run(ctx) {
		const shapes: readonly { plain: number; property: number }[] = [
			{ plain: 0, property: 0 },
			{ plain: 1, property: 0 },
			{ plain: 10, property: 0 },
			{ plain: 0, property: 1 },
			{ plain: 0, property: 10 },
		];
		for (const shape of shapes) {
			const label = `${shape.plain} plain, ${shape.property} property`;
			const id = await ctx.fixture.world(`develop-${shape.plain}p${shape.property}q`, TODOS);
			const enrolled = [...Array.from({ length: shape.plain }, (_, i) => plainCheck(i)), ...Array.from({ length: shape.property }, (_, i) => propertyCheck(i))];
			let missing = false;
			for (const check of enrolled) missing ||= !(await ctx.api.enrol(id, check));
			if (missing) {
				ctx.note(`skipped ${label}: the target cannot enrol checks over REST`);
				continue;
			}
			const rate = ctx.param("rate", 0.5);
			const [develops] = await ctx.load(
				label,
				[{ name: `develop (${label})`, rate, arrivals: "uniform", maxInFlight: 64, request: (i) => ctx.api.developReply(id, redefinition(i)) }],
				{ warmupS: ctx.param("warmup", 4), durationS: ctx.param("duration", 40), drainS: 120 },
			);
			ctx.judgeLatency("O3", develops!, developBoundMs(shape.plain, shape.property));
			ctx.judgeFailures("O7", develops!, 0);
		}
	},
};
