import { describe, expect, it } from "vitest";
import { chainedPeers, type PeerTransport } from "../src/world/chained-peers.ts";
import { World } from "../src/world/world.ts";
import { worldDeps } from "./world-deps.ts";

const operator = { by: "operator" } as const;
const DELAY_MS: number = 300;

/** A peer that answers every call after `DELAY_MS`, as a slow world would. */
const slowPeer: PeerTransport = {
	call: async (_id, name) => {
		await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
		return { ok: true, value: name };
	},
	list: async () => [],
	functions: async () => [],
};

async function world(concurrentCalls?: number, maxWaitMs?: number): Promise<World> {
	const opened = await World.open(worldDeps({ peers: (chain) => chainedPeers("a", chain, slowPeer), ...(concurrentCalls ? { concurrentCalls } : {}), ...(maxWaitMs ? { maxWaitMs } : {}) }));
	await opened.develop(
		`define("version", () => 1); define("viaSlow", async () => { await worlds.call("b", "x"); return version(); }); define("quick", () => "quick");`,
		"setup",
		operator,
	);
	return opened;
}

const timed = async <T>(work: Promise<T>): Promise<{ value: T; ms: number }> => {
	const started = Date.now();
	const value = await work;
	return { value, ms: Date.now() - started };
};

describe("concurrent calls to one world", () => {
	it("answers a quick call while another call awaits a slow world", async () => {
		const a = await world();
		const slow = timed(a.call("viaSlow", []));
		const quick = await timed(a.call("quick", []));
		expect(quick.value).toEqual({ ok: true, value: "quick" });
		expect(quick.ms).toBeLessThan(DELAY_MS / 2);
		expect((await slow).value).toEqual({ ok: true, value: 1 });
	});

	it("accepts a develop while a call awaits, and the call finishes on the revision it started at", async () => {
		const a = await world();
		const waiting = a.call("viaSlow", []);
		const developed = await timed(a.develop(`define("version", () => 2);`, "v2", operator));
		expect(developed.value.status).toBe("accepted");
		expect(developed.ms).toBeLessThan(DELAY_MS / 2);
		expect(await waiting).toEqual({ ok: true, value: 1 });
		expect(await a.call("version", [])).toEqual({ ok: true, value: 2 });
	});

	it("runs as many calls at once as it has VMs, and queues the rest", async () => {
		const a = await world(2);
		const three = await timed(Promise.all([a.call("viaSlow", []), a.call("viaSlow", []), a.call("viaSlow", [])]));
		expect(three.value.every((outcome) => outcome.ok)).toBe(true);
		expect(three.ms).toBeGreaterThanOrEqual(2 * DELAY_MS - 20);
		expect(three.ms).toBeLessThan(3 * DELAY_MS);
	});

	it("refuses a call as busy, recording no incident, once every VM is taken past the wait", async () => {
		const a = await world(1, 50);
		const holding = a.call("viaSlow", []);
		expect(await a.call("quick", [])).toMatchObject({ ok: false, failure: "busy" });
		expect((await holding).ok).toBe(true);
		expect(a.incidents.openCount()).toBe(0);
	});

	it("keeps each call's heap changes to itself", async () => {
		const a = await world();
		await a.develop(`const s = state("s", () => ({ n: 0 })); define("bumpAfterWait", async () => { s.n++; await worlds.call("b", "x"); return s.n; });`, "bump", operator);
		expect(await Promise.all([a.call("bumpAfterWait", []), a.call("bumpAfterWait", [])])).toEqual([
			{ ok: true, value: 1 },
			{ ok: true, value: 1 },
		]);
	});

	it("does not show a call's writes to another call until the first has succeeded", async () => {
		const a = await world();
		await a.develop(`define("writeThenWait", async () => { data.set("x", 1); await worlds.call("b", "x"); return data.get("x"); }); define("read", () => data.get("x") ?? null);`, "rw", operator);
		const writing = a.call("writeThenWait", []);
		await new Promise((resolve) => setTimeout(resolve, DELAY_MS / 3));
		expect(await a.call("read", [])).toEqual({ ok: true, value: null });
		expect(await writing).toEqual({ ok: true, value: 1 });
		expect(await a.call("read", [])).toEqual({ ok: true, value: 1 });
	});
});

describe("serializable calls", () => {
	it("count every one of concurrent increments that read, await another world, then write", async () => {
		const a = await world();
		await a.develop(`define("bump", async () => { const n = data.get("n") ?? 0; await worlds.call("b", "x"); data.set("n", n + 1); return n + 1; }); define("n", () => data.get("n") ?? 0);`, "bump", operator);
		const outcomes = await Promise.all(Array.from({ length: 4 }, () => a.call("bump", [])));
		expect(outcomes.every((o) => o.ok)).toBe(true);
		expect(await a.call("n", [])).toEqual({ ok: true, value: 4 });
		expect(outcomes.map((o) => (o.ok ? o.value : null)).sort()).toEqual([1, 2, 3, 4]);
	});

	it("give up with a conflict, writing nothing, when what a call reads changes under every run", async () => {
		const deps = worldDeps();
		const a = await World.open(deps);
		await a.develop(`define("copy", () => { data.set("copy", data.get("x") ?? null); return true; });`, "copy", operator);
		let reads = 0;
		const get = deps.data.get.bind(deps.data);
		// Another writer changes x between every read of a run and its commit.
		deps.data.get = (key) => (key === "x" ? String(reads++) : get(key));
		const outcome = await a.call("copy", []);
		expect(outcome).toMatchObject({ ok: false, failure: "conflict" });
		expect(deps.data.get("copy")).toBeUndefined();
	});
});

describe("atomic calls", () => {
	it("open no transaction when they write nothing", async () => {
		const deps = worldDeps();
		let transactions = 0;
		deps.data.transaction = () => {
			transactions++;
		};
		const a = await World.open(deps);
		await a.develop(`define("read", () => data.get("x") ?? null);`, "r", operator);
		expect(await a.call("read", [])).toEqual({ ok: true, value: null });
		expect(transactions).toBe(0);
	});

	it("leave the owner's own data administration unaffected: listing and deleting rows", async () => {
		const deps = worldDeps();
		deps.data.set("todo:1", "1");
		deps.data.set("todo:2", "2");
		expect((await deps.calls.list("todo:")).map((row) => row.key)).toEqual(["todo:1", "todo:2"]);
		expect(await deps.calls.delete("todo:1")).toBe(true);
		expect(await deps.calls.delete("todo:1")).toBe(false);
		expect((await deps.calls.list("")).map((row) => row.key)).toEqual(["todo:2"]);
	});

	it("leave no write when they fail", async () => {
		const a = await world();
		await a.develop(`define("writeThenThrow", () => { data.set("x", 1); data.set("y", 2); throw new Error("no"); }); define("read", () => [data.get("x") ?? null, data.get("y") ?? null]);`, "w", operator);
		expect((await a.call("writeThenThrow", [])).ok).toBe(false);
		expect(await a.call("read", [])).toEqual({ ok: true, value: [null, null] });
	});

	it("make every write of a call that succeeds, in one transaction of the store", async () => {
		const transactions: number[] = [];
		const deps = worldDeps();
		const transaction = deps.data.transaction.bind(deps.data);
		deps.data.transaction = (writes) => {
			transactions.push(deps.data.list("").length);
			transaction(writes);
		};
		const a = await World.open(deps);
		await a.develop(`define("writeTwo", () => { data.set("x", 1); data.delete("gone"); data.set("y", 2); return data.list("").length; });`, "w", operator);
		deps.data.set("gone", "0");
		expect(await a.call("writeTwo", [])).toEqual({ ok: true, value: 2 });
		expect(transactions).toEqual([1]);
		expect(deps.data.list("").map((row) => row.key)).toEqual(["x", "y"]);
	});
});
