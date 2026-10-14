import { describe, expect, it } from "vitest";
import { runOpenLoop, type Reply } from "./open-loop.ts";

/** A server that answers one request at a time in 1 ms, except one request that holds it for `stallMs`. */
function singleServer(stallAt: number, stallMs: number): (i: number) => Promise<Reply> {
	let tail: Promise<unknown> = Promise.resolve();
	return (i) => {
		const answer = tail.then(() => new Promise<Reply>((resolve) => setTimeout(() => resolve({ ok: true }), i === stallAt ? stallMs : 1)));
		tail = answer;
		return answer;
	};
}

describe("runOpenLoop", () => {
	it("charges a stall to every request it delayed, which closed-loop service time does not", async () => {
		const [result] = await runOpenLoop(
			[{ name: "stalled", rate: 200, arrivals: "uniform", maxInFlight: 1, request: singleServer(100, 500) }],
			{ warmupS: 0, durationS: 2, drainS: 5, seed: 1 },
		);
		const ok = result!.ok.percentiles();
		const service = result!.service.percentiles();
		// About a quarter of the 400 requests arrived during the 500 ms stall and waited for it.
		expect(ok.count).toBe(400);
		expect(ok.p90Ms).toBeGreaterThan(100);
		expect(ok.maxMs).toBeGreaterThan(450);
		// Measured from its actual send, only the stalled request itself looks slow: a fraction of the open-loop
		// latency, with room for timers that fire late on a loaded machine.
		expect(service.p90Ms).toBeLessThan(ok.p90Ms / 4);
	});

	it("counts a request still open when the drain ends as a timeout, with its latency so far", async () => {
		const [result] = await runOpenLoop(
			[{ name: "hung", rate: 10, arrivals: "uniform", maxInFlight: 100, request: (i) => (i === 3 ? new Promise<Reply>(() => undefined) : Promise.resolve({ ok: true })) }],
			{ warmupS: 0, durationS: 1, drainS: 0.2, seed: 1 },
		);
		expect(result!.failures).toEqual({ timeout: 1 });
		expect(result!.failed.percentiles().maxMs).toBeGreaterThan(600);
	});

	it("does not record arrivals during the warm-up", async () => {
		const [result] = await runOpenLoop([{ name: "warm", rate: 100, arrivals: "uniform", maxInFlight: 100, request: () => Promise.resolve({ ok: true }) }], {
			warmupS: 0.5,
			durationS: 0.5,
			drainS: 1,
			seed: 1,
		});
		expect(result!.intended).toBe(50);
	});
});
