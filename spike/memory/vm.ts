// Measure one world VM: snapshot size, QuickJS heap, and the time to snapshot, restore and evaluate, for worlds of
// 10, 100 and 400 definitions. Run with `npm run spike:memory`.
import { readFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { WorldVm } from "../../src/world/world-vm.ts";

const wasm: WebAssembly.Module = await WebAssembly.compile(await readFile(new URL(import.meta.resolve("quickjs-wasi/quickjs.wasm"))));
const attempt = { kind: "attempt", at: 1_750_000_000_000, seed: 1 } as const;
const RUNS: number = 20;

/** `count` definitions shaped like an agent's: small functions with docs, one class, one state per ten. */
function source(count: number): string {
	const lines: string[] = [];
	for (let i = 0; i < count; i++) {
		if (i % 10 === 0) lines.push(`const cache${i} = state("cache${i}", () => ({ hits: 0, table: {} }));`);
		if (i % 25 === 0) lines.push(`define("Thing${i}", class { constructor(a) { this.a = a; } twice() { return this.a * 2; } }, { doc: "A thing" });`);
		lines.push(`define("fn${i}", (xs = []) => xs.filter((x) => x > ${i}).map((x) => ({ x, y: x * ${i} })).reduce((a, b) => a + b.y, 0), { doc: "Sums the products above ${i}" });`);
	}
	return lines.join("\n");
}

async function time(body: () => unknown | Promise<unknown>): Promise<number> {
	const start = performance.now();
	for (let i = 0; i < RUNS; i++) await body();
	return (performance.now() - start) / RUNS;
}

const kb = (bytes: number): string => `${(bytes / 1024).toFixed(0)} KB`;
const ms = (value: number): string => `${value.toFixed(2)} ms`;

console.log("definitions | snapshot | gzipped | QuickJS heap | snapshot() | restore | evaluate | reset");
for (const count of [10, 100, 400]) {
	const vm = await WorldVm.create(wasm);
	const developed = vm.develop(source(count), attempt);
	if (!developed.ok) throw new Error(developed.error);
	const snapshot = vm.snapshot();
	const bytes = WorldVm.serialize(snapshot);
	const heap = (vm as unknown as { vm: { getMemoryUsage(): { memoryUsedSize: number } } }).vm.getMemoryUsage().memoryUsedSize;
	const snap = await time(() => vm.snapshot());
	const restore = await time(async () => (await WorldVm.fromSnapshot(snapshot, wasm)).dispose());
	const evaluate = await time(() => vm.evaluate(`fn1([1, 2, 3])`, attempt));
	const reset = await time(() => vm.reset(snapshot));
	console.log(`${count} | ${kb(bytes.length)} | ${kb(gzipSync(bytes).length)} | ${kb(heap)} | ${ms(snap)} | ${ms(restore)} | ${ms(evaluate)} | ${ms(reset)}`);
	vm.dispose();
}
