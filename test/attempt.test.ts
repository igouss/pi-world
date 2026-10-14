import { describe, expect, it } from "vitest";
import type { Check } from "../src/check/check.ts";
import { attemptDevelop, attemptEnrolment } from "../src/world/attempt.ts";
import { MemoryDataPort } from "../src/world/data-port.ts";
import { NO_PEERS } from "../src/world/peer-port.ts";
import { WorldVm, type AttemptMode } from "../src/world/world-vm.ts";
import { wasm } from "./wasm.ts";

const mode: AttemptMode = { kind: "attempt", at: 1_750_000_000_000, seed: 7 };
const live = { kind: "live", data: new MemoryDataPort(), peers: NO_PEERS } as const;
const positive: Check = {
	name: "double stays positive",
	expression: "double(2) === 4",
	counterexample: `define("double", (x) => -x);`,
	enrolledAt: 0,
};

describe("attemptDevelop", () => {
	it("accepts a source and reports what it added", async () => {
		const vm = await WorldVm.create(wasm);
		const attempt = await attemptDevelop(vm, `define("double", (x) => 2 * x);`, [], mode);
		expect(attempt.accepted && attempt.changes).toEqual({ added: ["double"], changed: [], removed: [] });
	});

	it("restores the checkpoint when a check fails", async () => {
		const vm = await WorldVm.create(wasm);
		await attemptDevelop(vm, `define("double", (x) => 2 * x);`, [], mode);
		const attempt = await attemptDevelop(vm, `define("double", (x) => -x);`, [positive], mode);
		expect(attempt.accepted === false && attempt.check).toBe("double stays positive");
		expect(await vm.invoke("double", [3], live)).toEqual({ ok: true, value: 6 });
	});

	it("keeps no heap change a check makes", async () => {
		const vm = await WorldVm.create(wasm);
		await attemptDevelop(vm, `const s = state("s", () => ({ n: 0 })); define("bump", () => ++s.n); define("count", () => s.n);`, [], mode);
		const bumping: Check = { name: "bump counts", expression: "bump() > 0", counterexample: `define("bump", () => 0);`, enrolledAt: 0 };
		const attempt = await attemptDevelop(vm, `define("other", () => 1);`, [bumping], mode);
		expect(attempt.accepted).toBe(true);
		expect(await vm.invoke("count", [], live)).toEqual({ ok: true, value: 0 });
		const restored = await WorldVm.fromSnapshot(attempt.accepted ? attempt.snapshot : vm.snapshot(), wasm);
		expect(await restored.invoke("count", [], live)).toEqual({ ok: true, value: 0 });
	});

	it("rejects a change after which a check no longer fails on its counterexample", async () => {
		const vm = await WorldVm.create(wasm);
		await attemptDevelop(vm, `define("base", () => 1); define("ok", () => base() === 1);`, [], mode);
		const guarded: Check = { name: "ok holds", expression: "ok()", counterexample: `define("base", () => 2);`, enrolledAt: 0 };
		const attempt = await attemptDevelop(vm, `define("ok", () => true);`, [guarded], mode);
		expect(attempt.accepted === false && attempt.check).toBe("ok holds");
		expect(attempt.accepted === false && attempt.reason).toContain("no longer fails on its counterexample");
		expect(await vm.invoke("ok", [], live)).toEqual({ ok: true, value: true });
		expect(vm.catalogue().find((entry) => entry.name === "ok")?.source).toBe("() => base() === 1");
	});

	it("names how a check failed, on its first line only", async () => {
		const vm = await WorldVm.create(wasm);
		await attemptDevelop(vm, `define("double", (x) => 2 * x);`, [], mode);
		const throwing: Check = { name: "throws", expression: `(() => { throw new Error("boom"); })()`, counterexample: "", enrolledAt: 0 };
		const thrown = await attemptDevelop(vm, `define("other", () => 1);`, [throwing], mode);
		expect(thrown.accepted === false && thrown.reason).toBe(`check "throws" failed: threw: Error: boom`);
		const returning: Check = { name: "returns", expression: "double(2)", counterexample: "", enrolledAt: 0 };
		const returned = await attemptDevelop(vm, `define("other", () => 1);`, [returning], mode);
		expect(returned.accepted === false && returned.reason).toBe(`check "returns" failed: returned 4`);
	});

	it("rejects a change after which a check's counterexample no longer applies", async () => {
		const vm = await WorldVm.create(wasm);
		await attemptDevelop(vm, `define("base", () => 1); define("ok", () => base() === 1);`, [], mode);
		const guarded: Check = { name: "ok holds", expression: "ok()", counterexample: `base.tweak();`, enrolledAt: 0 };
		const attempt = await attemptDevelop(vm, `define("other", () => 1);`, [guarded], mode);
		expect(attempt.accepted === false && attempt.reason).toContain("(the counterexample did not apply (threw): TypeError: not a function)");
	});

	it("accepts a change after which every check still fails on its counterexample", async () => {
		const vm = await WorldVm.create(wasm);
		await attemptDevelop(vm, `define("double", (x) => 2 * x);`, [], mode);
		const attempt = await attemptDevelop(vm, `define("double", (x) => x + x);`, [positive], mode);
		expect(attempt.accepted).toBe(true);
	});

	it("restores the checkpoint when the source throws halfway", async () => {
		const vm = await WorldVm.create(wasm);
		const attempt = await attemptDevelop(vm, `define("half", (x) => x / 2); throw new Error("stop");`, [], mode);
		expect(attempt.accepted).toBe(false);
		expect(vm.catalogue()).toEqual([]);
	});

	it("reports a changed and an unchanged definition", async () => {
		const vm = await WorldVm.create(wasm);
		await attemptDevelop(vm, `define("a", () => 1); define("b", () => 2);`, [], mode);
		const attempt = await attemptDevelop(vm, `define("a", () => 1); define("b", () => 3); undefine("a");`, [], mode);
		expect(attempt.accepted && attempt.changes).toEqual({ added: [], changed: ["b"], removed: ["a"] });
	});
});

describe("attemptEnrolment", () => {
	it("keeps no heap change the proposed check makes", async () => {
		const vm = await WorldVm.create(wasm);
		await attemptDevelop(vm, `const s = state("s", () => ({ n: 0 })); define("bump", () => ++s.n); define("count", () => s.n);`, [], mode);
		const bumping = { expression: "bump() > 0", counterexample: `define("bump", () => 0);` };
		expect(await attemptEnrolment(vm, bumping, mode)).toEqual({ enrolled: true });
		expect(await vm.invoke("count", [], live)).toEqual({ ok: true, value: 0 });
	});

	it("enrols a check seen failing on its counterexample, and leaves the world as it was", async () => {
		const vm = await WorldVm.create(wasm);
		await attemptDevelop(vm, `define("double", (x) => 2 * x);`, [], mode);
		expect(await attemptEnrolment(vm, positive, mode)).toEqual({ enrolled: true });
		expect(await vm.invoke("double", [3], live)).toEqual({ ok: true, value: 6 });
	});

	it("refuses a check that passes on its own counterexample", async () => {
		const vm = await WorldVm.create(wasm);
		await attemptDevelop(vm, `define("double", (x) => 2 * x);`, [], mode);
		const enrolment = await attemptEnrolment(vm, { expression: "true", counterexample: positive.counterexample }, mode);
		expect(enrolment.enrolled).toBe(false);
	});

	it("enrols a property check that fails on some input once its counterexample is applied", async () => {
		const vm = await WorldVm.create(wasm);
		await attemptDevelop(vm, `define("double", (x) => 2 * x);`, [], mode);
		const property = { expression: "double(input) % 2 === 0", counterexample: `define("double", (x) => (x > 50 ? x : 2 * x));`, generator: { int: [0, 100] as const } };
		expect(await attemptEnrolment(vm, property, mode)).toEqual({ enrolled: true });
	});

	it("refuses a property check that holds for every input after its counterexample", async () => {
		const vm = await WorldVm.create(wasm);
		await attemptDevelop(vm, `define("double", (x) => 2 * x);`, [], mode);
		const property = { expression: "double(input) % 2 === 0", counterexample: `define("double", (x) => 4 * x);`, generator: { int: [0, 100] as const } };
		const enrolment = await attemptEnrolment(vm, property, mode);
		expect(enrolment.enrolled === false && enrolment.reason).toContain("never seen failing");
	});

	it("refuses a check that fails on the current world", async () => {
		const vm = await WorldVm.create(wasm);
		const enrolment = await attemptEnrolment(vm, { expression: "typeof double === 'function'", counterexample: `define("x", () => 0);` }, mode);
		expect(enrolment.enrolled === false && enrolment.reason).toContain("does not hold on the current world");
	});
});
