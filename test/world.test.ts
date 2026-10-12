import { describe, expect, it } from "vitest";
import { World } from "../src/world/world.ts";
import { worldDeps } from "./world-deps.ts";

const operator = { by: "operator" } as const;
const fixture = () => worldDeps({ now: () => 1_750_000_000_000 });

describe("World", () => {
	it("starts at revision 0 with an empty catalogue", async () => {
		const world = await World.open(fixture());
		expect(world.head().revision).toBe(0);
		expect(world.catalogue()).toEqual([]);
	});

	it("accepts a develop as the next revision and reopens at it", async () => {
		const deps = fixture();
		const world = await World.open(deps);
		const result = await world.develop(`define("inc", (x) => x + 1);`, "add inc", operator);
		expect(result.status === "accepted" && result.revision.n).toBe(1);
		world.dispose();
		const reopened = await World.open(deps);
		expect(reopened.head().revision).toBe(1);
		expect(await reopened.call("inc", [1])).toEqual({ ok: true, value: 2 });
	});

	it("leaves the head where it was after a rejected develop", async () => {
		const world = await World.open(fixture());
		const result = await world.develop(`define("x", () => 1); throw new Error("no");`, "broken", operator);
		expect(result.status).toBe("rejected");
		expect(world.head().revision).toBe(0);
		expect(world.catalogue()).toEqual([]);
	});

	it("discards heap changes made by a call but keeps its data", async () => {
		const world = await World.open(fixture());
		await world.develop(`const s = state("s", () => ({ n: 0 })); define("bump", () => { data.set("n", ++s.n); return s.n; }); define("stored", () => data.get("n"));`, "counter", operator);
		expect(await world.call("bump", [])).toEqual({ ok: true, value: 1 });
		expect(await world.call("bump", [])).toEqual({ ok: true, value: 1 });
		expect(await world.call("stored", [])).toEqual({ ok: true, value: 1 });
	});

	it("returns the same revision when an agent's tool call reruns", async () => {
		const world = await World.open(fixture());
		const origin = { by: "agent", taskId: "t1", callId: "c1" } as const;
		await world.develop(`define("a", () => 1);`, "a", origin);
		const rerun = await world.develop(`define("a", () => 1);`, "a", origin);
		expect(rerun.status === "accepted" && rerun.replayed).toBe(true);
		expect(world.head().revision).toBe(1);
	});

	it("returns the same rollback when an agent's tool call reruns", async () => {
		const world = await World.open(fixture());
		const origin = { by: "agent", taskId: "t1", callId: "c1" } as const;
		await world.develop(`define("v", () => 1);`, "v1", operator);
		await world.develop(`define("v", () => 2);`, "v2", operator);
		const first = await world.rollback(1, "v2 was wrong", origin);
		const rerun = await world.rollback(1, "v2 was wrong", origin);
		expect(rerun).toEqual(first);
		expect(world.head().revision).toBe(3);
	});

	it("enrols checks with different names side by side", async () => {
		const world = await World.open(fixture());
		await world.develop(`define("one", () => 1); define("two", () => 2);`, "one, two", operator);
		await world.proposeCheck({ name: "one is 1", expression: "one() === 1", counterexample: `define("one", () => 0);` }, operator);
		const second = await world.proposeCheck({ name: "two is 2", expression: "two() === 2", counterexample: `define("two", () => 0);` }, operator);
		expect(second.status).toBe("enrolled");
		expect(world.checks().checks.map((check) => check.name)).toEqual(["one is 1", "two is 2"]);
	});

	it("refuses a check that reuses an enrolled name with another expression", async () => {
		const world = await World.open(fixture());
		await world.develop(`define("one", () => 1);`, "one", operator);
		await world.proposeCheck({ name: "one is 1", expression: "one() === 1", counterexample: `define("one", () => 0);` }, operator);
		const other = await world.proposeCheck({ name: "one is 1", expression: "one() > 0", counterexample: `define("one", () => 0);` }, operator);
		expect(other.status === "refused" && other.rejection.reason).toBe(`a different check named "one is 1" is already enrolled`);
	});

	it("refuses a check that reuses an enrolled name and expression with another counterexample", async () => {
		const world = await World.open(fixture());
		await world.develop(`define("one", () => 1);`, "one", operator);
		await world.proposeCheck({ name: "one is 1", expression: "one() === 1", counterexample: `define("one", () => 0);` }, operator);
		const other = await world.proposeCheck({ name: "one is 1", expression: "one() === 1", counterexample: `define("one", () => 2);` }, operator);
		expect(other.status).toBe("refused");
	});

	it("refuses to remove a check without a reason", async () => {
		const world = await World.open(fixture());
		await world.develop(`define("one", () => 1);`, "one", operator);
		await world.proposeCheck({ name: "one is 1", expression: "one() === 1", counterexample: `define("one", () => 0);` }, operator);
		await expect(world.removeCheck("one is 1", "  ")).rejects.toThrow("removing a check needs a reason");
	});

	it("tells subscribers when a check is enrolled", async () => {
		const world = await World.open(fixture());
		await world.develop(`define("one", () => 1);`, "one", operator);
		const seen: number[] = [];
		world.subscribe(() => seen.push(world.checks().checks.length));
		await world.proposeCheck({ name: "one is 1", expression: "one() === 1", counterexample: `define("one", () => 0);` }, operator);
		expect(seen).toEqual([1]);
	});

	it("refuses to roll back to the head", async () => {
		const world = await World.open(fixture());
		await world.develop(`define("v", () => 1);`, "v1", operator);
		await expect(world.rollback(1, "no change", operator)).rejects.toThrow("revision 1 is already the head");
	});

	it("turns top-level declarations into definitions and keeps the source as written", async () => {
		const world = await World.open(fixture());
		const written = `/** Adds one. */\nfunction inc(x) { return x + 1; }\nclass Box { constructor(v) { this.v = v; } }`;
		const result = await world.develop(written, "inc and Box", operator);
		expect(result.status === "accepted" && result.revision.changes.added).toEqual(["inc", "Box"]);
		expect(world.catalogue().find((entry) => entry.name === "inc")?.doc).toBe("Adds one.");
		expect(await world.call("inc", [1])).toEqual({ ok: true, value: 2 });
		const revision = await world.revision(1);
		expect(revision?.kind === "develop" && revision.written).toBe(written);
		expect(revision?.kind === "develop" && revision.source).toContain(`var inc = define("inc", inc, { doc: "Adds one." });`);
	});

	it("keeps no written copy when the rewrite changes nothing", async () => {
		const world = await World.open(fixture());
		await world.develop(`define("a", () => 1);`, "a", operator);
		const revision = await world.revision(1);
		expect(revision?.kind === "develop" && "written" in revision).toBe(false);
	});

	it("records the source as written in a rejection", async () => {
		const world = await World.open(fixture());
		const written = `function boom() { return 1; }\nthrow new Error("no");`;
		const result = await world.develop(written, "boom", operator);
		expect(result.status === "rejected" && result.rejection.written).toBe(written);
	});

	it("applies a counterexample written as a declaration", async () => {
		const world = await World.open(fixture());
		await world.develop(`function one() { return 1; }`, "one", operator);
		const result = await world.proposeCheck({ name: "one is 1", expression: "one() === 1", counterexample: `function one() { return 2; }` }, operator);
		expect(result.status === "enrolled" && result.check).toMatchObject({
			counterexample: `var one = define("one", one); function one() { return 2; }`,
			written: `function one() { return 2; }`,
		});
		const again = await world.proposeCheck({ name: "one is 1", expression: "one() === 1", counterexample: `function one() { return 2; }` }, operator);
		expect(again.status).toBe("enrolled");
	});

	it("keeps the call graph until the head changes", async () => {
		const world = await World.open(fixture());
		await world.develop(`function a() { return b(); }\nfunction b() { return 1; }`, "a, b", operator);
		const graph = world.callGraph();
		expect(graph.get("b")).toEqual({ calls: [], calledBy: ["a"] });
		expect(world.callGraph()).toBe(graph);
		await world.develop(`function c() { return b(); }`, "c", operator);
		expect(world.callGraph().get("b")).toEqual({ calls: [], calledBy: ["a", "c"] });
	});

	it("enrols a property check and rejects a develop that breaks it, naming the smallest input", async () => {
		const world = await World.open(fixture());
		await world.develop(`function total(xs) { return xs.reduce((a, b) => a + b, 0); }`, "total", operator);
		const proposal = { name: "total is not negative", expression: "total(input) >= 0", counterexample: `function total() { return -1; }`, generator: { array: { int: [0, 50] } } };
		const enrolled = await world.proposeCheck(proposal, operator);
		expect(enrolled.status === "enrolled" && enrolled.check.generator).toEqual({ array: { int: [0, 50] }, min: 0, max: 10 });
		const broken = await world.develop(`function total(xs) { return xs.length > 1 ? -1 : 0; }`, "break it", operator);
		expect(broken.status === "rejected" && broken.rejection.reason).toBe(`check "total is not negative" failed: on input [0,0]: returned false`);
	});

	it("refuses a bad generator even beside an enrolled check that matches the rest", async () => {
		const world = await World.open(fixture());
		await world.develop(`define("one", () => 1);`, "one", operator);
		const plainCheck = { name: "one is 1", expression: "one() === 1", counterexample: `define("one", () => 0);` };
		await world.proposeCheck(plainCheck, operator);
		const withBadGenerator = await world.proposeCheck({ ...plainCheck, generator: { bool: 1 } }, operator);
		expect(withBadGenerator.status).toBe("refused");
	});

	it("refuses a check whose generator does not parse, and records the generator", async () => {
		const world = await World.open(fixture());
		const proposal = { name: "bad", expression: "true", counterexample: `define("x", () => 1);`, generator: { int: [5, 1] } };
		const refused = await world.proposeCheck(proposal, operator);
		expect(refused.status === "refused" && refused.rejection).toMatchObject({ reason: expect.stringContaining("the generator is not valid: int takes"), generator: { int: [5, 1] } });
	});

	it("rolls back as a new revision", async () => {
		const world = await World.open(fixture());
		await world.develop(`define("v", () => 1);`, "v1", operator);
		await world.develop(`define("v", () => 2);`, "v2", operator);
		const revision = await world.rollback(1, "v2 was wrong", operator);
		expect(revision.n).toBe(3);
		expect(revision.kind === "rollback" && revision.changes).toEqual({ added: [], changed: ["v"], removed: [] });
		expect(await world.call("v", [])).toEqual({ ok: true, value: 1 });
		expect((await world.history(10)).map((r) => r.n)).toEqual([3, 2, 1, 0]);
	});

	it("rejects a develop that breaks an enrolled check, and keeps the check after a reopen", async () => {
		const deps = fixture();
		const world = await World.open(deps);
		await world.develop(`define("total", (xs) => xs.reduce((a, b) => a + b, 0));`, "total", operator);
		const enrolled = await world.proposeCheck({ name: "total of nothing is 0", expression: "total([]) === 0", counterexample: `define("total", () => -1);` }, operator);
		expect(enrolled.status).toBe("enrolled");
		world.dispose();
		const reopened = await World.open(deps);
		const result = await reopened.develop(`define("total", (xs) => xs.length ? xs.reduce((a, b) => a + b) : null);`, "break it", operator);
		expect(result.status === "rejected" && result.rejection.check).toBe("total of nothing is 0");
	});

	it("keeps the head and the heap when the commit fails", async () => {
		const world = await World.open(fixture());
		await world.develop(`define("keep", () => "old");`, "keep", operator);
		await expect(
			world.develop(`define("keep", () => "new");`, "doomed", operator, async () => {
				throw new Error("storage down");
			}),
		).rejects.toThrow("storage down");
		expect(world.head().revision).toBe(1);
		expect(await world.call("keep", [])).toEqual({ ok: true, value: "old" });
	});

	it("records a removed check with its reason", async () => {
		const world = await World.open(fixture());
		await world.develop(`define("one", () => 1);`, "one", operator);
		await world.proposeCheck({ name: "one is 1", expression: "one() === 1", counterexample: `define("one", () => 2);` }, operator);
		await world.removeCheck("one is 1", "requirement changed");
		const checks = world.checks();
		expect(checks.checks).toEqual([]);
		expect(checks.removed.map((r) => r.reason)).toEqual(["requirement changed"]);
	});

	it("returns the enrolled check when the same proposal reruns, and refuses a different check under that name", async () => {
		const world = await World.open(fixture());
		await world.develop(`define("one", () => 1);`, "one", operator);
		const first = await world.proposeCheck({ name: "one is 1", expression: "one() === 1", counterexample: `define("one", () => 2);` }, operator);
		const rerun = await world.proposeCheck({ name: "one is 1", expression: "one() === 1", counterexample: `define("one", () => 2);` }, operator);
		const other = await world.proposeCheck({ name: "one is 1", expression: "one() > 0", counterexample: `define("one", () => 0);` }, operator);
		expect(rerun).toEqual(first);
		expect(other.status).toBe("refused");
		expect(world.checks().checks).toHaveLength(1);
	});

	it("refuses a rollback or a check removal without a reason", async () => {
		const world = await World.open(fixture());
		await world.develop(`define("v", () => 1);`, "v1", operator);
		await expect(world.rollback(0, "  ", operator)).rejects.toThrow("needs a reason");
		await expect(world.removeCheck("x", "")).rejects.toThrow("needs a reason");
	});

	it("restores the head heap before the next operation after a call that changed it", async () => {
		const world = await World.open(fixture());
		await world.develop(`const s = state("s", () => ({ n: 0 })); define("bump", () => ++s.n); define("peek", () => s.n);`, "s", operator);
		await world.call("bump", []);
		expect(await world.call("peek", [])).toEqual({ ok: true, value: 0 });
		const result = await world.develop(`define("twice", () => 2 * peek());`, "twice", operator);
		expect(result.status).toBe("accepted");
		expect(await world.call("twice", [])).toEqual({ ok: true, value: 0 });
	});

	it("rolls back the data writes of an execute and reports them, while a call keeps its writes", async () => {
		const deps = fixture();
		const world = await World.open(deps);
		await world.develop(`define("add", (k) => { data.set(k, true); return data.list("").length; }); define("drop", (k) => data.delete(k));`, "data", operator);
		await world.call("add", ["kept"]);
		const preview = await world.execute(`[add("tried"), drop("kept"), data.list("").map((r) => r.key)]`);
		expect(preview).toEqual({ ok: true, value: [2, true, ["tried"]], rolledBack: { set: ["tried"], deleted: ["kept"] } });
		expect(deps.data.list("").map((row) => row.key)).toEqual(["kept"]);
	});
});

