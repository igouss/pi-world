import { describe, expect, it } from "vitest";
import { chainedPeers, type PeerTransport } from "../src/world/chained-peers.ts";
import { World } from "../src/world/world.ts";
import { worldDeps } from "./world-deps.ts";

const operator = { by: "operator" } as const;

/** Worlds in one process, wired the way cells are: each call carries its chain. */
async function fleet(...ids: string[]) {
	const worlds = new Map<string, World>();
	const transport: PeerTransport = {
		call: async (id, name, args, chain) => {
			const world = worlds.get(id);
			if (!world) return { ok: false, failure: "threw", error: `no world ${id}` };
			return world.call(name, args, chain);
		},
		list: async () => [...worlds.keys()].map((id) => ({ id, name: id })),
		functions: async (id) => worlds.get(id)?.catalogue() ?? [],
	};
	for (const id of ids) {
		worlds.set(id, await World.open(worldDeps({ peers: (chain) => chainedPeers(id, chain, transport) })));
	}
	return (id: string) => worlds.get(id)!;
}

describe("grants", () => {
	it("let a world call any world until its owner restricts it", async () => {
		const world = await fleet("a", "b");
		expect(world("a").grants()).toEqual({ calls: "any" });
		await world("b").develop(`define("hi", () => "hi");`, "hi", operator);
		await world("a").develop(`define("ask", async () => worlds.call("b", "hi"));`, "ask", operator);
		expect(await world("a").call("ask", [])).toEqual({ ok: true, value: "hi" });
	});

	it("let a world call only the worlds it is granted, list only those, and preview under the same rule", async () => {
		const world = await fleet("a", "b", "c");
		await world("b").develop(`define("hi", () => "b");`, "hi", operator);
		await world("c").develop(`define("hi", () => "c");`, "hi", operator);
		await world("a").develop(`define("ask", async (id) => { try { return await worlds.call(id, "hi"); } catch (e) { return e.message; } });`, "ask", operator);
		await world("a").setGrants({ calls: ["b"] });
		expect(await world("a").call("ask", ["b"])).toEqual({ ok: true, value: "b" });
		expect(await world("a").call("ask", ["c"])).toEqual({ ok: true, value: "c.hi: this world may not call c: its owner has not granted it" });
		expect(await world("a").execute(`worlds.list()`)).toMatchObject({ ok: true, value: [{ id: "b", name: "b" }] });
	});

	it("bind a world's own calls, not the calls other worlds make to it", async () => {
		const world = await fleet("a", "b");
		await world("b").develop(`define("hi", () => "b");`, "hi", operator);
		await world("a").develop(`define("ask", async () => worlds.call("b", "hi"));`, "ask", operator);
		await world("b").setGrants({ calls: [] });
		expect(await world("a").call("ask", [])).toEqual({ ok: true, value: "b" });
	});
});

describe("calls between worlds", () => {
	it("calls a definition of another world and uses its result", async () => {
		const world = await fleet("rates", "shop");
		await world("rates").develop(`define("convert", (amount, to) => Math.round(amount * ({ EUR: 0.9, JPY: 150 })[to] * 100) / 100);`, "rates", operator);
		await world("shop").develop(`define("priceIn", async (usd, to) => ({ usd, [to]: await worlds.call("rates", "convert", usd, to) }));`, "prices", operator);
		expect(await world("shop").call("priceIn", [10, "JPY"])).toEqual({ ok: true, value: { usd: 10, JPY: 1500 } });
	});

	it("passes the other world's error to the caller as a rejection", async () => {
		const world = await fleet("a", "b");
		await world("b").develop(`define("fail", () => { throw new Error("no stock"); });`, "fail", operator);
		await world("a").develop(`define("ask", async () => { try { return await worlds.call("b", "fail"); } catch (e) { return "caught: " + e.message; } });`, "ask", operator);
		const outcome = await world("a").call("ask", []);
		expect(outcome.ok && outcome.value).toMatch(/^caught: b\.fail: Error: no stock/);
	});

	it("refuses a call that would come back to a world on the chain", async () => {
		const world = await fleet("a", "b");
		await world("a").develop(`define("ping", async () => worlds.call("b", "pong")); define("here", () => "a");`, "ping", operator);
		await world("b").develop(`define("pong", async () => worlds.call("a", "here"));`, "pong", operator);
		const outcome = await world("a").call("ping", []);
		expect(outcome.ok === false && outcome.error).toContain("cycle: a → b → a");
	});

	it("rejects a develop that calls another world", async () => {
		const world = await fleet("a", "b");
		const result = await world("a").develop(`worlds.list();`, "peek", operator);
		expect(result.status === "rejected" && result.rejection.failure).toBe("host-call");
	});

	it("lists the other worlds and their functions", async () => {
		const world = await fleet("a", "b");
		await world("b").develop(`define("hello", (n) => "hi " + n, { doc: "Greets" });`, "hello", operator);
		expect(await world("a").execute(`worlds.list()`)).toMatchObject({ ok: true, value: [{ id: "b", name: "b" }] });
		expect(await world("a").execute(`worlds.functions("b")`)).toMatchObject({ ok: true, value: [{ name: "hello", kind: "function", doc: "Greets", params: "n" }] });
	});

	it("runs two calls awaited together at the same time", async () => {
		const slow: PeerTransport = {
			call: async (_id, name) => {
				await new Promise((resolve) => setTimeout(resolve, 200));
				return { ok: true, value: name };
			},
			list: async () => [],
			functions: async () => [],
		};
		const world = await World.open(worldDeps({ peers: (chain) => chainedPeers("a", chain, slow) }));
		await world.develop(`define("both", () => Promise.all([worlds.call("b", "x"), worlds.call("c", "y")]));`, "both", operator);
		const started = Date.now();
		expect(await world.call("both", [])).toEqual({ ok: true, value: ["x", "y"] });
		expect(Date.now() - started).toBeLessThan(380);
	});
});

