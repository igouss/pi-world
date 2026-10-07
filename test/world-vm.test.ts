import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MemoryDataPort } from "../src/world/data-port.ts";
import { NO_PEERS } from "../src/world/peer-port.ts";
import { WorldVm, type Mode } from "../src/world/world-vm.ts";
import { wasm } from "./wasm.ts";

const attempt: Mode & { kind: "attempt" } = { kind: "attempt", at: 1_750_000_000_000, seed: 42 };
const live = (): Mode => ({ kind: "live", data: new MemoryDataPort(), peers: NO_PEERS });
const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

describe("WorldVm", () => {
	it("calls a defined function with JSON arguments", async () => {
		const vm = await WorldVm.create(wasm);
		expect(vm.develop(`define("shout", (s) => s.toUpperCase() + "!");`, attempt)).toEqual({ ok: true, value: undefined });
		expect(await vm.invoke("shout", ["hi"], live())).toEqual({ ok: true, value: "HI!" });
	});

	it("routes a captured reference to the newest definition", async () => {
		const vm = await WorldVm.create(wasm);
		vm.develop(`define("greet", (n) => "hi " + n); define("twice", (n) => greet(n) + greet(n));`, attempt);
		vm.develop(`define("greet", (n) => "yo " + n);`, attempt);
		expect(await vm.invoke("twice", ["a"], live())).toEqual({ ok: true, value: "yo ayo a" });
	});

	it("keeps state across re-evaluation of the same source", async () => {
		const vm = await WorldVm.create(wasm);
		const source = `const s = state("counter", () => ({ n: 0 })); define("bump", () => ++s.n);`;
		vm.develop(source, attempt);
		vm.develop(`bump(); bump();`, attempt);
		vm.develop(source, attempt);
		expect(await vm.invoke("bump", [], live())).toEqual({ ok: true, value: 3 });
	});

	it("reports a throw with its message", async () => {
		const vm = await WorldVm.create(wasm);
		const outcome = vm.develop(`throw new Error("nope");`, attempt);
		expect(outcome.ok).toBe(false);
		expect(outcome.ok === false && outcome.failure).toBe("threw");
		expect(outcome.ok === false && outcome.error).toContain("nope");
	});

	it("stops an endless loop and stays usable", async () => {
		const vm = await WorldVm.create(wasm, { budget: 2_000, memoryBytes: 64 << 20 });
		const outcome = vm.develop(`while (true) {}`, attempt);
		expect(outcome.ok === false && outcome.failure).toBe("budget");
		expect(await vm.evaluate("1 + 2", live())).toEqual({ ok: true, value: 3 });
	});

	it("fails a develop that touches data, even when the source catches the error", async () => {
		const vm = await WorldVm.create(wasm);
		const outcome = vm.develop(`try { data.set("k", 1); } catch {}`, attempt);
		expect(outcome.ok === false && outcome.failure).toBe("host-call");
	});

	it("reads and writes data in a live call", async () => {
		const vm = await WorldVm.create(wasm);
		vm.develop(`define("add", (t) => data.set("todo:" + t, { t, done: false })); define("all", () => data.list("todo:"));`, attempt);
		const mode = live();
		await vm.invoke("add", ["milk"], mode);
		await vm.invoke("add", ["eggs"], mode);
		expect(await vm.invoke("all", [], mode)).toEqual({
			ok: true,
			value: [
				{ key: "todo:eggs", value: { t: "eggs", done: false } },
				{ key: "todo:milk", value: { t: "milk", done: false } },
			],
		});
	});

	it("settles an async definition", async () => {
		const vm = await WorldVm.create(wasm);
		vm.develop(`define("later", async (x) => { await null; return x * 2; });`, attempt);
		expect(await vm.invoke("later", [21], live())).toEqual({ ok: true, value: 42 });
	});

	it("gives byte-identical snapshots for the same source on the same base", async () => {
		const build = async (): Promise<string> => {
			const vm = await WorldVm.create(wasm);
			vm.develop(`const s = state("x", () => ({ at: Date.now(), r: Math.random() })); define("f", () => s);`, attempt);
			const bytes = WorldVm.serialize(vm.snapshot());
			vm.dispose();
			return sha(bytes);
		};
		expect(await build()).toBe(await build());
	});

	it("pins the clock during an attempt", async () => {
		const vm = await WorldVm.create(wasm);
		expect(await vm.evaluate("Date.now()", attempt)).toEqual({ ok: true, value: attempt.at });
	});

	it("restores a snapshot from bytes into a working world", async () => {
		const vm = await WorldVm.create(wasm);
		vm.develop(`define("id", (x) => x);`, attempt);
		const bytes = WorldVm.serialize(vm.snapshot());
		vm.dispose();
		const back = await WorldVm.fromBytes(bytes, wasm);
		expect(await back.invoke("id", [7], live())).toEqual({ ok: true, value: 7 });
		expect((await back.invoke("missing", [], live())).ok).toBe(false);
	});

	it("lists the catalogue with docs and parameters", async () => {
		const vm = await WorldVm.create(wasm);
		vm.develop(`define("area", (w, h) => w * h, { doc: "Rectangle area" }); define("Box", class { constructor(w) { this.w = w; } });`, attempt);
		expect(vm.catalogue().map(({ name, kind, doc, params }) => ({ name, kind, doc, params }))).toEqual([
			{ name: "area", kind: "function", doc: "Rectangle area", params: "w, h" },
			{ name: "Box", kind: "class", doc: "", params: "w" },
		]);
	});

	it("hides an undefined name from the catalogue and its callers", async () => {
		const vm = await WorldVm.create(wasm);
		vm.develop(`define("gone", () => 1); undefine("gone");`, attempt);
		expect(vm.catalogue()).toEqual([]);
		expect((await vm.evaluate("gone()", live())).ok).toBe(false);
	});

	it("ignores tampering with a frozen built-in", async () => {
		const vm = await WorldVm.create(wasm);
		vm.develop(`Array.prototype.every = () => true;`, attempt);
		expect(await vm.evaluate("[1, 2].every((x) => x > 1)", live())).toEqual({ ok: true, value: false });
	});

	it("upgrades a restored heap built by an older prelude", async () => {
		const old = await WorldVm.create(wasm, undefined, 1);
		old.develop(`define("kept", () => "yes");`, attempt);
		expect(await old.evaluate("typeof worlds", live())).toEqual({ ok: true, value: "undefined" });
		const restored = await WorldVm.fromBytes(WorldVm.serialize(old.snapshot()), wasm);
		restored.upgrade(1);
		expect(await restored.evaluate("typeof worlds", live())).toEqual({ ok: true, value: "object" });
		expect(await restored.invoke("kept", [], live())).toEqual({ ok: true, value: "yes" });
		const again = await WorldVm.fromBytes(WorldVm.serialize(restored.snapshot()), wasm);
		expect(await again.evaluate("worlds.list()", live())).toEqual({ ok: true, value: [] });
	});
});

