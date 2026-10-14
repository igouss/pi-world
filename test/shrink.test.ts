import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, it } from "vitest";
import { shrink, smaller, STOP } from "../src/check/shrink.ts";

/** A replay that fails while some choice is at least `threshold`, drawing exactly the choices it was given. */
const atLeast = (threshold: number) => async (choices: readonly number[]) => (choices.some((c) => c >= threshold) ? choices : undefined);

describe("shrink", () => {
	it("returns a sequence that still fails, is no larger than the start, and has no negative choice", () =>
		hegel.testAsync(async (tc) => {
			const threshold = tc.draw(gs.integers({ minValue: 0, maxValue: 1000 }));
			const start = [...tc.draw(gs.arrays(gs.integers({ minValue: 0, maxValue: 1000 }), { maxSize: 30 })), threshold];
			const result = await shrink(start, atLeast(threshold), 10_000);
			expect(await atLeast(threshold)(result)).toBeDefined();
			expect(smaller(start, result)).toBe(false);
			expect(result.every((choice) => choice >= 0)).toBe(true);
		}));

	it("finds the one smallest failing sequence when the budget allows", () =>
		hegel.testAsync(async (tc) => {
			const threshold = tc.draw(gs.integers({ minValue: 1, maxValue: 1000 }));
			const start = [...tc.draw(gs.arrays(gs.integers({ minValue: 0, maxValue: 1000 }), { maxSize: 30 })), threshold];
			expect(await shrink(start, atLeast(threshold), 10_000)).toEqual([threshold]);
		}));

	it("keeps the start when nothing smaller fails", async () => {
		expect(await shrink([], atLeast(0), 100)).toEqual([]);
	});

	it("replays no candidate twice", async () => {
		const replayed: string[] = [];
		const sumAtLeastFive = async (choices: readonly number[]) => {
			replayed.push(choices.join(","));
			return choices.reduce((a, b) => a + b, 0) >= 5 ? choices : undefined;
		};
		await shrink([4, 4, 4], sumAtLeastFive, 1000);
		expect(new Set(replayed).size).toBe(replayed.length);
	});

	it("tries no more replays than its budget", async () => {
		let replays = 0;
		const counted = async (choices: readonly number[]) => {
			replays++;
			return choices.length > 0 ? choices : undefined;
		};
		await shrink([5, 5, 5, 5, 5, 5, 5, 5, 5, 5], counted, 3);
		expect(replays).toBe(3);
	});

	it("stops at the smallest sequence found before a replay that says stop", async () => {
		let replays: number = 0;
		const stopsOnSecond = async (choices: readonly number[]) => (++replays === 1 ? choices : STOP);
		expect(await shrink([5, 5, 5, 5, 5, 5, 5, 5, 5, 5], stopsOnSecond, 100)).toEqual([5, 5]);
		expect(replays).toBe(2);
	});

	it("keeps what a replay drew, which may be fewer choices than it was given", async () => {
		const drawsTwo = async (choices: readonly number[]) => (choices[0] === 7 ? [7, choices[1] ?? 0] : undefined);
		expect(await shrink([7, 1, 1, 1], drawsTwo, 100)).toEqual([7, 0]);
	});
});

describe("shrink lowering", () => {
	it("lowers a choice all the way to 0 when only lowering helps", async () => {
		const padsWithThree = async (choices: readonly number[]) => {
			const drawn = [choices[0] ?? 0, choices[1] ?? 3];
			return drawn[0] === 7 && drawn[1]! <= 4 ? drawn : undefined;
		};
		expect(await shrink([7, 4], padsWithThree, 100)).toEqual([7, 0]);
	});
});

describe("smaller", () => {
	it("orders by length, then by the first differing choice", () => {
		expect(smaller([9], [0, 0])).toBe(true);
		expect(smaller([0, 1], [0, 2])).toBe(true);
		expect(smaller([0, 2], [0, 2])).toBe(false);
		expect(smaller([1, 0], [0, 9])).toBe(false);
	});
});
