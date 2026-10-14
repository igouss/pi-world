import { counter, CURRENCY } from "../lib/fixtures.ts";
import type { Scenario } from "../lib/scenario.ts";

/**
 * Correctness under concurrency: N concurrent increments of one data key, as a call that reads, awaits another world,
 * then writes, and as a call that does not await. If calls were serializable the count would be N both times.
 */
export const lostUpdate: Scenario = {
	id: "lost-update",
	title: "Concurrent read-modify-write calls",
	objectives: ["correctness"],
	params: { calls: 20 },
	async run(ctx) {
		const peer = await ctx.fixture.world("peer", CURRENCY);
		const n = ctx.param("calls", 20);
		for (const fn of ["bump", "bumpSync"] as const) {
			const id = await ctx.fixture.world(`counter-${fn}`, counter(peer));
			await ctx.api.mustCall(id, "count", []);
			const answers = await Promise.all(Array.from({ length: n }, () => ctx.api.call(id, fn, [])));
			const succeeded = answers.filter((a) => a.status === 200 && a.body.ok).length;
			const count = (await ctx.api.mustCall(id, "count", [])) as number;
			ctx.verdict({ objective: "correctness", metric: `${fn}: count after ${succeeded} successful concurrent increments`, measured: count, limit: succeeded, holds: count === succeeded });
		}
	},
};
