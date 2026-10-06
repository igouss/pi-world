import { describe, expect, it } from "vitest";
import type { Check } from "../src/check/check.ts";
import { attemptDevelop, attemptEnrolment, type AttemptMode } from "../src/world/attempt.ts";
import { MemoryDataPort } from "../src/world/data-port.ts";
import { WorldVm } from "../src/world/world-vm.ts";
import { wasm } from "./wasm.ts";

const mode: AttemptMode = { kind: "attempt", at: 1_750_000_000_000, seed: 7 };
const live = { kind: "live", data: new MemoryDataPort() } as const;
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
		expect(vm.invoke("double", [3], live)).toEqual({ ok: true, value: 6 });
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
	it("enrols a check seen failing on its counterexample, and leaves the world as it was", async () => {
		const vm = await WorldVm.create(wasm);
		await attemptDevelop(vm, `define("double", (x) => 2 * x);`, [], mode);
		expect(await attemptEnrolment(vm, positive.expression, positive.counterexample, mode)).toEqual({ enrolled: true });
		expect(vm.invoke("double", [3], live)).toEqual({ ok: true, value: 6 });
	});

	it("refuses a check that passes on its own counterexample", async () => {
		const vm = await WorldVm.create(wasm);
		await attemptDevelop(vm, `define("double", (x) => 2 * x);`, [], mode);
		const enrolment = await attemptEnrolment(vm, "true", positive.counterexample, mode);
		expect(enrolment.enrolled).toBe(false);
	});

	it("refuses a check that fails on the current world", async () => {
		const vm = await WorldVm.create(wasm);
		const enrolment = await attemptEnrolment(vm, "typeof double === 'function'", `define("x", () => 0);`, mode);
		expect(enrolment.enrolled === false && enrolment.reason).toContain("does not hold on the current world");
	});
});
