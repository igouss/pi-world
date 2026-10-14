import { OBJECTIVES } from "../objectives.ts";
import { CURRENCY } from "../lib/fixtures.ts";
import type { Scenario } from "../lib/scenario.ts";

/**
 * O5a: worlds per node. Opens worlds one after another at a fixed rate, each with a develop and one call, so each
 * has its own resident runtime isolate, and records where opening or calling a world starts to fail and what memory
 * the server holds.
 */
export const worlds: Scenario = {
	id: "worlds",
	title: "Resident worlds per node",
	objectives: ["O5a"],
	params: { worlds: OBJECTIVES.O5a.worlds + 20, rate: 2 },
	async run(ctx) {
		const target = ctx.param("worlds", OBJECTIVES.O5a.worlds + 20);
		const rate = ctx.param("rate", 2);
		const failures: { index: number; kind: string }[] = [];
		const [open] = await ctx.load(
			"open worlds",
			[
				{
					name: "open a world and call it",
					rate,
					arrivals: "uniform",
					maxInFlight: 16,
					request: async (i) => {
						try {
							const id = await ctx.fixture.world(`w${i}`, CURRENCY);
							const reply = await ctx.api.callReply(id, "convert", [1, "USD", "EUR"]);
							if (!reply.ok) failures.push({ index: i, kind: reply.kind });
							return reply;
						} catch (error) {
							const kind = error instanceof Error ? error.message.slice(0, 160) : String(error);
							failures.push({ index: i, kind });
							return { ok: false, kind: kind.replaceAll(new RegExp(`${ctx.fixture.prefix}-w\\d+(-[0-9a-f]{6})?`, "g"), "<world>").slice(0, 160) };
						}
					},
				},
			],
			{ warmupS: 0, durationS: target / rate, drainS: 120 },
		);
		const resident = open!.ok.count;
		const first = failures.sort((a, b) => a.index - b.index)[0];
		if (first) ctx.note(`the first failure was world ${first.index}: ${first.kind}`);
		ctx.verdict({ objective: "O5a", metric: "worlds opened and answering", measured: resident, limit: OBJECTIVES.O5a.worlds, holds: resident >= OBJECTIVES.O5a.worlds });
	},
};
