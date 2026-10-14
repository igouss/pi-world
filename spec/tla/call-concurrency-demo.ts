// Concurrent calls on the real World and LocalCallRunner, the class the runtime facet runs calls with, in this
// process. Each scenario prints what it observed; README.md, "Findings", says what each line shows.
import { createSession, MemoryStorage } from "@earendil-works/pi-durable";
import { MemoryBlobStore } from "../../src/revision/blob-store.ts";
import { MemoryDataPort } from "../../src/world/data-port.ts";
import { LocalCallRunner } from "../../src/world/local-call-runner.ts";
import { LocalWorkbench } from "../../src/world/local-workbench.ts";
import type { PeerPort } from "../../src/world/peer-port.ts";
import { World } from "../../src/world/world.ts";
import { wasm } from "../../test/wasm.ts";

const SOURCE: string = `
define("inc", () => { const n = data.get("n") ?? 0; data.set("n", n + 1); return n + 1; });
define("incViaPeer", async () => { const n = data.get("n") ?? 0; await worlds.call("b", "fast"); data.set("n", n + 1); return n + 1; });
define("hold", async () => { await worlds.call("b", "slow"); return "held"; });
define("pair", async () => { const a = data.get("a") ?? 0; await worlds.call("b", "fast"); const b = data.get("b") ?? 0; return [a, b]; });
define("bump", () => { data.set("a", 1); data.set("b", 1); return "bumped"; });`;

/** Another world: "slow" answers after 300 ms, anything else after 20 ms. */
const peer: PeerPort = {
	call: async (_id, name) => {
		await new Promise((resolve) => setTimeout(resolve, name === "slow" ? 300 : 20));
		return { ok: true, value: null };
	},
	list: async () => [],
	functions: async () => [],
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const nextTask = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

interface Opened {
	readonly world: World;
	readonly data: MemoryDataPort;
}

async function open(options: { blobDelayMs?: number; concurrentCalls?: number } = {}): Promise<Opened> {
	const blobs = new MemoryBlobStore();
	const data = new MemoryDataPort();
	const blob = async (hash: string): Promise<Uint8Array> => {
		if (options.blobDelayMs) await sleep(options.blobDelayMs);
		return (await blobs.get(hash))!;
	};
	const calls = new LocalCallRunner({ wasm, data, blob, peers: () => peer, ...(options.concurrentCalls ? { concurrentCalls: options.concurrentCalls } : {}) });
	const world = await World.open({ session: createSession(new MemoryStorage()), blobs, calls, workbench: new LocalWorkbench({ wasm, blob }) });
	await world.develop(SOURCE, "demo", { by: "operator" });
	return { world, data };
}

type Shown = string | unknown;
const show = (outcome: { ok: boolean; value?: unknown; failure?: string }): Shown => (outcome.ok ? outcome.value : outcome.failure);

/** Three increments, each started in its own task, as separate RPCs arrive in the facet. */
async function increments(label: string, name: string, blobDelayMs: number): Promise<void> {
	const { world, data } = await open({ blobDelayMs });
	const started: Promise<{ ok: boolean; value?: unknown; failure?: string }>[] = [];
	for (let i = 0; i < 3; i++) {
		started.push(world.call(name, []));
		await nextTask();
	}
	const outcomes = await Promise.all(started);
	console.log(`${label}: ${JSON.stringify(outcomes.map(show))}, n = ${data.get("n")}`);
}

/** A read-only call that reads a, awaits a peer, then reads b, while another call sets both. */
async function readOnlySkew(): Promise<void> {
	const { world, data } = await open();
	const reader = world.call("pair", []);
	await sleep(10);
	const writer = await world.call("bump", []);
	console.log(`read-only skew: bump ${JSON.stringify(show(writer))}, pair ${JSON.stringify(show(await reader))}, rows a = ${data.get("a")}, b = ${data.get("b")}`);
}

/** Two colliding increments on a pool of two, with two long calls queued, so the stale one's rerun has to wait. */
async function rerunWaits(): Promise<void> {
	const { world, data } = await open({ concurrentCalls: 2 });
	const outcomes = await Promise.all([world.call("incViaPeer", []), world.call("incViaPeer", []), world.call("hold", []), world.call("hold", [])]);
	console.log(`rerun waits for a VM: ${JSON.stringify(outcomes.map(show))}, n = ${data.get("n")}`);
}

await increments("inc, cold snapshot cache", "inc", 50);
await increments("inc, warm snapshot cache", "inc", 0);
await increments("incViaPeer", "incViaPeer", 0);
await readOnlySkew();
await rerunWaits();
