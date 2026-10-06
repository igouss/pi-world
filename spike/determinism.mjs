// Experiment: snapshot determinism and growth in quickjs-wasi.
// Checks: fixed WASI clock and random give byte-identical snapshots; restore then snapshot is identical;
// and how snapshot size grows with the number of definitions.
import { readFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { QuickJS } from "quickjs-wasi";
const wasmBytes = await readFile(new URL(import.meta.resolve("quickjs-wasi/quickjs.wasm")));
const module = await WebAssembly.compile(wasmBytes);
const fixed = (memory) => ({
  clock_time_get: (id, prec, out) => { new DataView(memory.buffer).setBigUint64(out, 1_700_000_000_000_000_000n, true); return 0; },
  random_get: (p, n) => { new Uint8Array(memory.buffer, p, n).fill(7); return 0; },
});
const opts = (det) => ({ wasm: module, memoryLimit: 64 << 20, timezoneOffset: 0, ...(det ? { wasi: fixed } : {}) });
const src = (n) => Array.from({ length: n }, (_, i) => `globalThis.f${i} = (x) => x + ${i} + Math.random(); globalThis.d${i} = { at: Date.now(), s: "item ${i}".repeat(10) };`).join("\n");
const sha = (b) => createHash("sha256").update(b).digest("hex").slice(0, 12);
const build = async (det, n) => { const vm = await QuickJS.create(opts(det)); vm.evalCode(src(n)).dispose(); vm.executePendingJobs(); const b = QuickJS.serializeSnapshot(vm.snapshot()); vm.dispose(); return b; };
for (const det of [false, true]) {
  const a = await build(det, 50), b = await build(det, 50);
  console.log(`deterministic wasi=${det}: identical=${sha(a) === sha(b)} ${sha(a)} ${sha(b)} size=${a.length}`);
}
for (const n of [0, 200, 2000]) {
  const b = await build(true, n);
  console.log(`world with ${n} defs: ${b.length} raw, ${gzipSync(b).length} gz`);
}
// restore then snapshot again: does the image stay identical (restore-idempotence)?
const base = await build(true, 50);
const vm = await QuickJS.restore(QuickJS.deserializeSnapshot(base), opts(true));
const again = QuickJS.serializeSnapshot(vm.snapshot()); vm.dispose();
console.log(`restore->snapshot identical=${sha(base) === sha(again)}`);
// Milestone 1's shape: restore the same base twice, evaluate the same source, compare.
const develop = async (source) => {
  const v = await QuickJS.restore(QuickJS.deserializeSnapshot(base), opts(true));
  v.evalCode(source).dispose(); v.executePendingJobs();
  const out = QuickJS.serializeSnapshot(v.snapshot()); v.dispose(); return out;
};
const r1 = await develop(src(5)), r2 = await develop(src(5));
console.log(`restore->develop twice identical=${sha(r1) === sha(r2)}`);
