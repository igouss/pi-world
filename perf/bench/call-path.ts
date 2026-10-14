// The CPU of one direct call inside a world's runtime isolate, in parts: restoring a VM from the head snapshot,
// copying the snapshot's memory alone, evaluating the call, and the whole LocalCallRunner call. Under Node, so it
// measures pi-world's and quickjs-wasi's code, not celld's. Run with `npm run bench:call-path`.
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { Latencies } from "../lib/histogram.ts";
import { CURRENCY } from "../lib/fixtures.ts";
import { LocalCallRunner } from "../../src/world/local-call-runner.ts";
import { WorldVm } from "../../src/world/world-vm.ts";
import { ANY_WORLD } from "../../src/world/grants.ts";
import type { DataRow, DataStore } from "../../src/world/data-port.ts";

const RUNS: number = Number(process.env.RUNS ?? 2000);
const wasm: WebAssembly.Module = await WebAssembly.compile(await readFile(new URL(import.meta.resolve("quickjs-wasi/quickjs.wasm"))));
const attempt = { kind: "attempt", at: 1_750_000_000_000, seed: 1 } as const;

function memoryStore(): DataStore {
	const rows = new Map<string, string>();
	return {
		get: (key) => rows.get(key),
		set: (key, json) => void rows.set(key, json),
		delete: (key) => rows.delete(key),
		list: (prefix): readonly DataRow[] => [...rows].filter(([k]) => k.startsWith(prefix)).map(([key, v]) => ({ key, value: JSON.parse(v) as unknown })),
		transaction: (writes) => writes(),
	};
}

async function measure(name: string, body: () => unknown | Promise<unknown>): Promise<void> {
	for (let i = 0; i < Math.min(200, RUNS); i++) await body();
	const latencies = new Latencies();
	for (let i = 0; i < RUNS; i++) {
		const start = performance.now();
		await body();
		latencies.recordMs(performance.now() - start);
	}
	const p = latencies.percentiles();
	console.log(`${name.padEnd(44)} p50 ${p.p50Ms.toFixed(3)}  p99 ${p.p99Ms.toFixed(3)}  mean ${p.meanMs.toFixed(3)} ms`);
}

const vm = await WorldVm.create(wasm);
const developed = vm.develop(CURRENCY, attempt);
if (!developed.ok) throw new Error(developed.error);
const snapshot = vm.snapshot();
const bytes = WorldVm.serialize(snapshot);
console.log(`Currency's snapshot: ${(bytes.length / 1024).toFixed(0)} KB, ${RUNS} runs each`);

const target = new Uint8Array(snapshot.memory.byteLength);
await measure("copy the snapshot's memory (memcpy only)", () => target.set(snapshot.memory));
await measure("restore a VM from the snapshot, dispose it", async () => (await WorldVm.fromSnapshot(snapshot, wasm)).dispose());
await measure("reset a VM to the snapshot (VmPool.recycle)", () => vm.reset(snapshot));
const live = { kind: "live", data: memoryStore(), peers: { list: async () => [], functions: async () => [], call: async () => ({ ok: false, failure: "threw", error: "no peers" }) as const } } as const;
await measure("evaluate convert on a warm VM", () => vm.invoke("convert", [100, "USD", "JPY"], live));

const runner = new LocalCallRunner({ wasm, data: memoryStore(), blob: async () => bytes });
const scope = { head: { revision: 1, blob: "h" }, grants: ANY_WORLD, startBy: Number.POSITIVE_INFINITY };
await measure("LocalCallRunner.call convert, one at a time", () => runner.call("convert", [100, "USD", "JPY"], [], scope));
await measure("LocalCallRunner.call, 8 at once (per call)", async () => {
	await Promise.all(Array.from({ length: 8 }, () => runner.call("convert", [100, "USD", "JPY"], [], scope)));
});
runner.dispose();
vm.dispose();
