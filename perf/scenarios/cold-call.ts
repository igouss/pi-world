import { OBJECTIVES } from "../objectives.ts";
import { CURRENCY } from "../lib/fixtures.ts";
import { Latencies } from "../lib/histogram.ts";
import type { Scenario } from "../lib/scenario.ts";

/** O1c: the first call after the world's cell is evicted, repeated; each eviction goes through celld's operator route. */
export const coldCall: Scenario = {
	id: "cold-call",
	title: "Cold call after eviction",
	objectives: ["O1c"],
	params: { rounds: 20 },
	async run(ctx) {
		if (!ctx.operator) throw new Error("cold-call needs the target's internal listener (--internal)");
		const before = new Set(await ctx.operator.residents());
		const id = await ctx.fixture.world("currency", CURRENCY);
		await ctx.api.mustCall(id, "convert", [1, "USD", "EUR"]);
		const scope = (await ctx.operator.residents()).find((s) => s.startsWith("WorldCell:") && !before.has(s));
		if (!scope) throw new Error("could not find the new world's cell among the residents");
		const cold = new Latencies();
		const warm = new Latencies();
		for (let round = 0; round < ctx.param("rounds", 20); round++) {
			const reply = await ctx.operator.evict(scope);
			if (!/"ok"\s*:\s*true|evicted/i.test(reply)) ctx.note(`eviction ${round}: ${reply.slice(0, 200)}`);
			await new Promise((r) => setTimeout(r, 500));
			const t0 = performance.now();
			await ctx.api.mustCall(id, "convert", [1, "USD", "EUR"]);
			cold.recordMs(performance.now() - t0);
			const t1 = performance.now();
			await ctx.api.mustCall(id, "convert", [1, "USD", "EUR"]);
			warm.recordMs(performance.now() - t1);
		}
		const c = cold.percentiles();
		ctx.say(`  cold: n=${c.count} p50=${c.p50Ms} p99=${c.p99Ms} max=${c.maxMs} ms; the next call: p50=${warm.percentiles().p50Ms} ms`);
		ctx.verdict({ objective: "O1c", metric: `cold call p99 ms (n=${c.count}, so p99 is the max)`, measured: c.p99Ms, limit: OBJECTIVES.O1c.p99Ms, holds: c.p99Ms <= OBJECTIVES.O1c.p99Ms, ...(ctx.loopback ? {} : { invalid: "the client is not on the celld host" }) });
	},
};
