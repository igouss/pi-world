// How much of a world's snapshot changes from one revision to the next, by fixed-size page: the bytes a revision would
// write if snapshots were stored as content-addressed pages instead of one blob. Develops the node's own Demo todos
// and Currency sources, then 20 redefinitions. Run with `npm run bench:snapshot-pages`.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { CURRENCY, TODOS } from "../lib/fixtures.ts";
import { WorldVm } from "../../src/world/world-vm.ts";

const wasm: WebAssembly.Module = await WebAssembly.compile(await readFile(new URL(import.meta.resolve("quickjs-wasi/quickjs.wasm"))));
const PAGES: readonly number[] = [4096, 16384, 65536];

function pages(memory: Uint8Array, size: number): string[] {
	const out: string[] = [];
	for (let at = 0; at < memory.length; at += size) out.push(createHash("sha256").update(memory.subarray(at, at + size)).digest("hex"));
	return out;
}

const vm = await WorldVm.create(wasm);
const sources: string[] = [TODOS, CURRENCY];
for (let i = 0; i < 20; i++) sources.push(`define("stats", () => { const todos = listTodos(); const done = todos.filter(t => t.done).length; return { open: todos.length - done, done, total: todos.length, rev: ${i} }; });`);
let previous = vm.snapshot().memory;
const seen = new Map<number, Set<string>>(PAGES.map((p) => [p, new Set(pages(previous, p))]));
const totals = new Map<number, { changed: number; fresh: number }>(PAGES.map((p) => [p, { changed: 0, fresh: 0 }]));
let gzipTotal = 0;
for (const [i, source] of sources.entries()) {
	const outcome = vm.develop(source, { kind: "attempt", at: 1_750_000_000_000 + i, seed: i + 1 });
	if (!outcome.ok) throw new Error(outcome.error);
	const memory = vm.snapshot().memory;
	gzipTotal += gzipSync(memory).length;
	for (const size of PAGES) {
		const before = pages(previous, size);
		const after = pages(memory, size);
		const changed = after.filter((h, k) => h !== before[k]).length;
		const store = seen.get(size)!;
		const fresh = after.filter((h) => !store.has(h) && store.add(h)).length;
		const t = totals.get(size)!;
		t.changed += changed;
		t.fresh += fresh;
	}
	previous = memory;
}
const n = sources.length;
console.log(`${n} revisions, snapshot ${(previous.length / 1024).toFixed(0)} KB each (${((previous.length * n) / 1048576).toFixed(1)} MB as whole blobs; ${(gzipTotal / 1024 / n).toFixed(0)} KB gzipped per revision)`);
for (const size of PAGES) {
	const t = totals.get(size)!;
	console.log(`page ${String(size / 1024).padStart(2)} KB: ${(t.changed / n).toFixed(1)} pages changed per revision (${((t.changed * size) / n / 1024).toFixed(0)} KB), ${((t.fresh * size) / n / 1024).toFixed(0)} KB of pages never stored before`);
}
vm.dispose();
