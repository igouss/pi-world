import { createSession, MemoryStorage } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { MemoryBlobStore } from "../src/revision/blob-store.ts";
import { chainedPeers, type PeerTransport } from "../src/world/chained-peers.ts";
import { MemoryDataPort } from "../src/world/data-port.ts";
import { World } from "../src/world/world.ts";
import { wasm } from "./wasm.ts";

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

async function world(concurrentCalls?: number): Promise<World> {
	const opened = await World.open({
		session: createSession(new MemoryStorage()),
		blobs: new MemoryBlobStore(),
		data: new MemoryDataPort(),
		peers: (chain) => chainedPeers("a", chain, slowPeer),
		wasm,
		...(concurrentCalls ? { concurrentCalls } : {}),
	});
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

	it("keeps each call's heap changes to itself", async () => {
		const a = await world();
		await a.develop(`const s = state("s", () => ({ n: 0 })); define("bumpAfterWait", async () => { s.n++; await worlds.call("b", "x"); return s.n; });`, "bump", operator);
		expect(await Promise.all([a.call("bumpAfterWait", []), a.call("bumpAfterWait", [])])).toEqual([
			{ ok: true, value: 1 },
			{ ok: true, value: 1 },
		]);
	});
});
