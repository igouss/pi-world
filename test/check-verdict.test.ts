import { describe, expect, it } from "vitest";
import { checkVerdict } from "../src/world/check-verdict.ts";
import { WorldVm, type AttemptMode } from "../src/world/world-vm.ts";
import { wasm } from "./wasm.ts";

const mode: AttemptMode = { kind: "attempt", at: 1_750_000_000_000, seed: 3 };

async function world(source: string): Promise<WorldVm> {
	const vm = await WorldVm.create(wasm);
	const developed = vm.develop(source, mode);
	if (!developed.ok) throw new Error(developed.error);
	return vm;
}

describe("checkVerdict", () => {
	it("holds for a plain check that returns true", async () => {
		const vm = await world(`define("one", () => 1);`);
		expect(await checkVerdict(vm, { expression: "one() === 1" }, mode)).toBe(true);
	});

	it("says what a plain check returned", async () => {
		const vm = await world(`define("one", () => 1);`);
		expect(await checkVerdict(vm, { expression: "one()" }, mode)).toBe("returned 1");
	});

	it("gives a check a scratch data store, empty on every run", async () => {
		const vm = await world(`define("remember", (x) => { data.set("x", x); return data.get("x"); });`);
		expect(await checkVerdict(vm, { expression: `data.get("x") === undefined && remember(2) === 2` }, mode)).toBe(true);
		expect(await checkVerdict(vm, { expression: `data.get("x") === undefined` }, mode)).toBe(true);
	});

	it("holds for a property that every generated input satisfies", async () => {
		const vm = await world(`define("double", (x) => 2 * x);`);
		expect(await checkVerdict(vm, { expression: "double(input) % 2 === 0", generator: { int: [-1000, 1000] } }, mode)).toBe(true);
	});

	it("reports the smallest input it shrinks a failure to", async () => {
		const vm = await world(`define("shortList", (xs) => xs.length < 3);`);
		expect(await checkVerdict(vm, { expression: "shortList(input)", generator: { array: { int: [0, 100] }, min: 0, max: 10 } }, mode)).toBe("on input [0,0,0]: returned false");
	});

	it("tries more inputs after one that passes", async () => {
		const vm = await world(`define("notThree", (n) => n !== 3);`);
		expect(await checkVerdict(vm, { expression: "notThree(input)", generator: { int: [0, 100] } }, mode)).toBe("on input 3: returned false");
	});

	it("shrinks a failing integer toward 0", async () => {
		const vm = await world(`define("small", (n) => Math.abs(n) < 17);`);
		expect(await checkVerdict(vm, { expression: "small(input)", generator: { int: [-1000, 1000] } }, mode)).toBe("on input 17: returned false");
	});

	it("gives every generated input its own scratch store", async () => {
		const vm = await world(`define("count", () => { const n = (data.get("n") ?? 0) + 1; data.set("n", n); return n; });`);
		expect(await checkVerdict(vm, { expression: "count() === 1", generator: { bool: true } }, mode)).toBe(true);
	});

	it("reports how a property threw", async () => {
		const vm = await world(`define("boom", (n) => { if (n > 5) throw new Error("too big"); return true; });`);
		expect(await checkVerdict(vm, { expression: "boom(input)", generator: { int: [0, 100] } }, mode)).toBe("on input 6: threw: Error: too big");
	});
});
