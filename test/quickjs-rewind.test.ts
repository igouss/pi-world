import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MemoryDataPort } from "../src/world/data-port.ts";
import { NO_PEERS } from "../src/world/peer-port.ts";
import { WorldVm, type Mode } from "../src/world/world-vm.ts";
import { wasm } from "./wasm.ts";

const attempt: Mode & { kind: "attempt" } = { kind: "attempt", at: 1_750_000_000_000, seed: 7 };
const live = (): Mode => ({ kind: "live", data: new MemoryDataPort(), peers: NO_PEERS });
const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** A world with state, a class with live instances, and functions that change each of them when called. */
const WORLD: string = `
const counter = state("counter", () => ({ n: 0, log: [] }));
define("Box", class { constructor(v) { this.v = v; } get() { return this.v; } });
const boxes = state("boxes", () => ({ list: [new Box(1), new Box(2)] }));
define("bump", (k) => { counter.n += k; counter.log.push(k); return counter.n; });
define("grow", (n) => { const a = []; for (let i = 0; i < n; i++) a.push({ i, s: "x".repeat(16) }); counter.big = a; return a.length; });
define("leak", (name) => { globalThis[name] = { at: counter.n }; return name; });
define("redefine", () => { define("bump", () => -1); return "redefined"; });
define("pend", () => { globalThis.pending = new Promise(() => {}); return "pending"; });
define("boom", () => { counter.n = 999; throw new Error("boom"); });
define("box", (v) => { boxes.list.push(new Box(v)); return boxes.list.length; });
define("probe", () => JSON.stringify({ n: counter.n, log: counter.log, big: counter.big ? counter.big.length : null, boxes: boxes.list.map((b) => b.get()), globals: Object.keys(globalThis).sort(), bump: bump(0) }));
`;

/** One call a request might make; `grow` with a large n grows the VM's memory, which a rewind cannot undo in place. */
const call = gs.composite((tc) => {
	const name = tc.draw(gs.sampledFrom(["bump", "grow", "leak", "redefine", "pend", "boom", "box"] as const));
	if (name === "bump" || name === "box") return { name, args: [tc.draw(gs.integers({ minValue: -50, maxValue: 50 }))] };
	if (name === "grow") return { name, args: [tc.draw(gs.sampledFrom([0, 10, 1000, 60_000]))] };
	if (name === "leak") return { name, args: [tc.draw(gs.fromRegex("g_[a-z]{1,5}"))] };
	return { name, args: [] as number[] };
});

async function head(): Promise<{ snapshot: ReturnType<WorldVm["snapshot"]>; probe: unknown }> {
	const vm = await WorldVm.create(wasm);
	const developed = vm.develop(WORLD, attempt);
	if (!developed.ok) throw new Error(developed.error);
	const snapshot = vm.snapshot();
	const probe = await vm.invoke("probe", [], live());
	vm.dispose();
	return { snapshot, probe };
}

describe("WorldVm.rewind", () => {
	it("answers like a freshly restored VM, whatever calls ran on it before", () =>
		hegel.testAsync(
			async (tc) => {
				const { snapshot, probe } = await head();
				const vm = await WorldVm.fromSnapshot(snapshot, wasm);
				const rounds = tc.draw(gs.arrays(gs.arrays(call, { maxSize: 6 }), { minSize: 1, maxSize: 3 }));
				for (const calls of rounds) {
					for (const { name, args } of calls) await vm.invoke(name, args, live());
					await vm.rewind(snapshot);
					expect(await vm.invoke("probe", [], live())).toEqual(probe);
					expect(await vm.invoke("bump", [3], live())).toEqual({ ok: true, value: 3 });
					expect(await vm.invoke("boom", [], live())).toMatchObject({ ok: false, failure: "threw" });
					await vm.rewind(snapshot);
				}
				const fresh = await WorldVm.fromSnapshot(snapshot, wasm);
				expect(await vm.invoke("probe", [], live())).toEqual(await fresh.invoke("probe", [], live()));
				fresh.dispose();
				vm.dispose();
			},
			{ testCases: 40 },
		), 60_000);

	it("leaves exactly the snapshot's memory when the memory did not grow", async () => {
		const { snapshot } = await head();
		const vm = await WorldVm.fromSnapshot(snapshot, wasm);
		await vm.invoke("bump", [5], live());
		await vm.invoke("grow", [10], live());
		await vm.rewind(snapshot);
		const after = (vm as unknown as { vm: { exports: { memory: WebAssembly.Memory } } }).vm.exports.memory;
		expect(sha(new Uint8Array(after.buffer))).toBe(sha(snapshot.memory));
		vm.dispose();
	});

	it("restores afresh when a call grew the memory", async () => {
		const { snapshot, probe } = await head();
		const vm = await WorldVm.fromSnapshot(snapshot, wasm);
		const memoryOf = (): WebAssembly.Memory => (vm as unknown as { vm: { exports: { memory: WebAssembly.Memory } } }).vm.exports.memory;
		const before = memoryOf();
		await vm.invoke("grow", [60_000], live());
		expect(memoryOf().buffer.byteLength).toBeGreaterThan(snapshot.memory.byteLength);
		await vm.rewind(snapshot);
		expect(memoryOf()).not.toBe(before);
		expect(memoryOf().buffer.byteLength).toBe(snapshot.memory.byteLength);
		expect(await vm.invoke("probe", [], live())).toEqual(probe);
		vm.dispose();
	});

	it("leaves the wrapper as a fresh restore leaves it: no handle or callback of the old heap survives", async () => {
		const { snapshot } = await head();
		const wrapper = (vm: WorldVm) => {
			const q = (vm as unknown as { vm: { hostCallbacks: Map<string, unknown>; _ownedHandles: Set<unknown>; _global: unknown; nextInternalId: number } }).vm;
			return { callbacks: [...q.hostCallbacks.keys()].sort(), owned: q._ownedHandles.size, global: q._global, next: q.nextInternalId };
		};
		const fresh = await WorldVm.fromSnapshot(snapshot, wasm);
		const vm = await WorldVm.fromSnapshot(snapshot, wasm);
		await vm.invoke("pend", [], live());
		await vm.invoke("leak", ["g_a"], live());
		await vm.evaluate("(globalThis.p = Promise.resolve(1).then((x) => x + 1), 1)", live());
		// What a call left waiting on another world past its deadline leaves behind: an unsettled deferred and its settle callback.
		const q = (vm as unknown as { vm: { global: unknown; newPromise(): { settled: Promise<void> } } }).vm;
		void q.newPromise().settled;
		void q.global;
		await vm.rewind(snapshot);
		expect(wrapper(vm)).toEqual(wrapper(fresh));
		fresh.dispose();
		vm.dispose();
	});

	it("keeps the time budget after a rewind", async () => {
		const { snapshot } = await head();
		const vm = await WorldVm.fromSnapshot(snapshot, wasm, { budget: 200, memoryBytes: 128 * 1024 * 1024 });
		await vm.rewind(snapshot);
		expect(await vm.evaluate("(() => { for (;;) {} })()", live())).toMatchObject({ ok: false, failure: "budget" });
		vm.dispose();
	});
});
