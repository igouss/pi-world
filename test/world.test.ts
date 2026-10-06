import { createSession, MemoryStorage, type Session } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { MemoryBlobStore } from "../src/revision/blob-store.ts";
import { MemoryDataPort } from "../src/world/data-port.ts";
import { World, type WorldDeps } from "../src/world/world.ts";
import { wasm } from "./wasm.ts";

const operator = { by: "operator" } as const;
const fixture = (): WorldDeps & { session: Session } => ({
	session: createSession(new MemoryStorage()),
	blobs: new MemoryBlobStore(),
	data: new MemoryDataPort(),
	wasm,
	now: () => 1_750_000_000_000,
});

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
		const enrolled = await world.proposeCheck("total of nothing is 0", "total([]) === 0", `define("total", () => -1);`);
		expect(enrolled.status).toBe("enrolled");
		world.dispose();
		const reopened = await World.open(deps);
		const result = await reopened.develop(`define("total", (xs) => xs.length ? xs.reduce((a, b) => a + b) : null);`, "break it", operator);
		expect(result.status === "rejected" && result.check).toBe("total of nothing is 0");
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
		await world.proposeCheck("one is 1", "one() === 1", `define("one", () => 2);`);
		await world.removeCheck("one is 1", "requirement changed");
		const checks = await world.checks();
		expect(checks.checks).toEqual([]);
		expect(checks.removed.map((r) => r.reason)).toEqual(["requirement changed"]);
	});

	it("returns the enrolled check when the same proposal reruns, and refuses a different check under that name", async () => {
		const world = await World.open(fixture());
		await world.develop(`define("one", () => 1);`, "one", operator);
		const first = await world.proposeCheck("one is 1", "one() === 1", `define("one", () => 2);`);
		const rerun = await world.proposeCheck("one is 1", "one() === 1", `define("one", () => 2);`);
		const other = await world.proposeCheck("one is 1", "one() > 0", `define("one", () => 0);`);
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
});
