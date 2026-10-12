import { describe, expect, it } from "vitest";
import { World } from "../src/world/world.ts";
import { worldDeps } from "./world-deps.ts";

const operator = { by: "operator" } as const;
const agent = { by: "agent", taskId: "t1", callId: "c1" } as const;
const fixture = () => worldDeps({ now: () => 1_750_000_000_000 });

describe("rejections", () => {
	it("are empty while every attempt is accepted", async () => {
		const world = await World.open(fixture());
		await world.develop(`define("a", () => 1);`, "a", operator);
		expect(world.rejectionCount()).toBe(0);
		expect(await world.rejections(10)).toEqual([]);
	});

	it("record a rejected develop with its source, failure, reason and base revision", async () => {
		const world = await World.open(fixture());
		const result = await world.develop(`throw new Error("no");`, "broken", operator);
		expect(result).toMatchObject({ status: "rejected", rejection: { n: 0, failure: "threw" } });
		expect(await world.rejection(0)).toMatchObject({
			n: 0,
			kind: "develop",
			source: `throw new Error("no");`,
			summary: "broken",
			failure: "threw",
			base: 0,
			origin: operator,
		});
		expect((await world.rejection(0))?.reason).toContain("no");
		expect(world.head().revision).toBe(0);
	});

	it("name the check a develop broke", async () => {
		const world = await World.open(fixture());
		await world.develop(`define("one", () => 1);`, "one", operator);
		await world.proposeCheck({ name: "one is 1", expression: "one() === 1", counterexample: `define("one", () => 2);` }, operator);
		const result = await world.develop(`define("one", () => 3);`, "three", operator);
		expect(result).toMatchObject({ status: "rejected", rejection: { n: 0, failure: "check", check: "one is 1" } });
		expect(await world.rejection(0)).toMatchObject({ kind: "develop", failure: "check", check: "one is 1", base: 1 });
	});

	it("record a refused check with its expression and counterexample", async () => {
		const world = await World.open(fixture());
		await world.develop(`define("one", () => 1);`, "one", operator);
		const result = await world.proposeCheck({ name: "vacuous", expression: "true", counterexample: `define("one", () => 2);` }, operator);
		expect(result).toMatchObject({ status: "refused", rejection: { n: 0 } });
		expect(await world.rejection(0)).toMatchObject({
			kind: "check",
			name: "vacuous",
			expression: "true",
			counterexample: `define("one", () => 2);`,
			summary: `check "vacuous"`,
		});
	});

	it("number several rejections in order and list them newest first, a page at a time", async () => {
		const world = await World.open(fixture());
		await world.develop(`throw new Error("first");`, "first", operator);
		await world.develop(`throw new Error("second");`, "second", operator);
		await world.develop(`throw new Error("third");`, "third", operator);
		expect(world.rejectionCount()).toBe(3);
		expect((await world.rejections(10)).map((r) => r.summary)).toEqual(["third", "second", "first"]);
		expect((await world.rejections(1, 2)).map((r) => r.summary)).toEqual(["second"]);
	});

	it("return the same rejection when an agent's tool call reruns, without recording another", async () => {
		const world = await World.open(fixture());
		const first = await world.develop(`throw new Error("no");`, "broken", agent);
		const rerun = await world.develop(`throw new Error("no");`, "broken", agent);
		expect(rerun).toEqual(first);
		expect(world.rejectionCount()).toBe(1);
	});

	it("return the same refusal when an agent's propose_check reruns, without recording another", async () => {
		const world = await World.open(fixture());
		const first = await world.proposeCheck({ name: "vacuous", expression: "true", counterexample: `define("x", () => 1);` }, agent);
		const rerun = await world.proposeCheck({ name: "vacuous", expression: "true", counterexample: `define("x", () => 1);` }, agent);
		expect(rerun).toEqual(first);
		expect(first).toMatchObject({ status: "refused", rejection: { n: 0 } });
		expect(world.rejectionCount()).toBe(1);
	});

	it("tell the world's subscribers", async () => {
		const world = await World.open(fixture());
		const seen: number[] = [];
		world.subscribe(() => seen.push(world.rejectionCount()));
		await world.develop(`throw new Error("no");`, "broken", operator);
		expect(seen).toEqual([1]);
	});

	it("survive reopening the world", async () => {
		const deps = fixture();
		const world = await World.open(deps);
		await world.develop(`throw new Error("no");`, "broken", operator);
		world.dispose();
		const reopened = await World.open(deps);
		expect(reopened.rejectionCount()).toBe(1);
		expect((await reopened.rejections(10)).map((r) => r.summary)).toEqual(["broken"]);
	});
});
