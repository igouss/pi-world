import { describe, expect, it } from "vitest";
import { ANY_WORLD, grantedPeers, mayCall, parseGrants } from "../src/world/grants.ts";
import type { PeerPort } from "../src/world/peer-port.ts";

const peers: PeerPort = {
	call: async (worldId, name) => ({ ok: true, value: `${worldId}.${name}` }),
	list: async () => [
		{ id: "a", name: "A" },
		{ id: "b", name: "B" },
		{ id: "c", name: "C" },
	],
	functions: async () => [],
};

describe("grants", () => {
	it("let any world be called by default", async () => {
		expect(grantedPeers(peers, ANY_WORLD)).toBe(peers);
		expect(mayCall(ANY_WORLD, "z")).toBe(true);
	});

	it("allow no world when none is granted", async () => {
		const none = grantedPeers(peers, { calls: [] });
		expect(await none.list()).toEqual([]);
		expect(await none.call("a", "f", [])).toEqual({ ok: false, failure: "threw", error: "this world may not call a: its owner has not granted it" });
		await expect(none.functions("a")).rejects.toThrow("this world may not call a");
	});

	it("allow exactly the one world granted", async () => {
		const one = grantedPeers(peers, { calls: ["b"] });
		expect(await one.list()).toEqual([{ id: "b", name: "B" }]);
		expect(await one.call("b", "f", [])).toEqual({ ok: true, value: "b.f" });
		expect((await one.call("c", "f", [])).ok).toBe(false);
		expect(await one.functions("b")).toEqual([]);
	});

	it("allow several granted worlds and refuse the rest", async () => {
		const two = grantedPeers(peers, { calls: ["a", "c"] });
		expect((await two.list()).map((world) => world.id)).toEqual(["a", "c"]);
		expect((await two.call("b", "f", [])).ok).toBe(false);
	});
});

describe("parseGrants", () => {
	it("accepts any world, no world, one world and several, sorted without repeats", () => {
		expect(parseGrants({ calls: "any" })).toEqual({ grants: { calls: "any" } });
		expect(parseGrants({ calls: [] })).toEqual({ grants: { calls: [] } });
		expect(parseGrants({ calls: ["b-1"] })).toEqual({ grants: { calls: ["b-1"] } });
		expect(parseGrants({ calls: ["c", "a", "c"] })).toEqual({ grants: { calls: ["a", "c"] } });
	});

	it("refuses anything else, saying why", () => {
		expect(parseGrants(null)).toEqual({ error: `calls is "any" or a list of world ids; got undefined` });
		expect(parseGrants({ calls: "all" })).toEqual({ error: `calls is "any" or a list of world ids; got "all"` });
		expect(parseGrants({ calls: ["Bad Id"] })).toEqual({ error: `not a world id: "Bad Id"` });
		expect(parseGrants({ calls: ["ok but not"] })).toEqual({ error: `not a world id: "ok but not"` });
		expect(parseGrants({ calls: [7] })).toEqual({ error: "not a world id: 7" });
		expect(parseGrants({ calls: Array.from({ length: 101 }, (_, i) => `w${i}`) })).toEqual({ error: "a grant names at most 100 worlds" });
		expect(parseGrants({ calls: Array.from({ length: 100 }, (_, i) => `w${i}`) })).toMatchObject({ grants: expect.anything() });
	});
});
