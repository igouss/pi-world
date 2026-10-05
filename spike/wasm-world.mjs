// Experiment: a jiti-style live world in quickjs-wasi.
// Checks: develop + execute, checkpoint/restore on a failed invariant, a pause (pending promise)
// that survives snapshot -> serialize -> dispose -> restore in a fresh instance, and an interrupt budget.
import { readFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { QuickJS } from "quickjs-wasi";

const wasmBytes = await readFile(new URL(import.meta.resolve("quickjs-wasi/quickjs.wasm")));
const module = await WebAssembly.compile(wasmBytes);

let budget = 0;
const options = () => ({ wasm: module, memoryLimit: 32 * 1024 * 1024, interruptHandler: () => --budget < 0 });
const run = (vm, code) => {
	budget = 5_000_000;
	return vm.evalCode(code).consume((h) => (h.isUndefined ? undefined : h.toString()));
};
const pauses = [];
const registerHost = (vm, fresh) => {
	const fn = (idHandle, questionHandle) => {
		pauses.push({ id: idHandle.toString(), question: questionHandle.toString() });
		return vm.undefined;
	};
	if (fresh) vm.newFunction("hostPause", fn).consume((h) => vm.setProp(vm.global, "hostPause", h));
	else vm.registerHostCallback("hostPause", fn);
};

// 1. Create the world and develop functions.
let vm = await QuickJS.create(options());
registerHost(vm, true);
run(vm, `
	globalThis.__pending = {};
	globalThis.restart = (id, question, options) =>
		new Promise((resolve) => { __pending[id] = resolve; hostPause(id, question); });
	globalThis.rows = [{ email: "a@x" }, { email: "a@x" }, { email: "b@x" }];
	globalThis.countDuplicates = () => rows.length - new Set(rows.map((r) => r.email)).size;
`);
console.log("develop: countDuplicates() =", run(vm, "String(countDuplicates())"));

// 2. A rejected attempt: checkpoint, break an invariant, restore.
const checkpoint = vm.snapshot();
run(vm, "globalThis.countDuplicates = null;");
const invariantHolds = run(vm, "String(typeof countDuplicates === 'function')");
console.log("attempt broke invariant:", invariantHolds === "false");
vm.dispose();
vm = await QuickJS.restore(checkpoint, options());
registerHost(vm, false);
console.log("after restore: countDuplicates() =", run(vm, "String(countDuplicates())"));

// 3. An async job that pauses for a decision.
run(vm, `
	globalThis.job = (async () => {
		const n = countDuplicates();
		const choice = await restart("p1", n + " duplicate emails", ["merge", "skip"]);
		globalThis.result = choice + " " + n;
	})();
`);
vm.executePendingJobs();
console.log("paused:", JSON.stringify(pauses), "result =", run(vm, "String(globalThis.result)"));

// 4. Snapshot, serialize, dispose ("eviction").
let t = performance.now();
const bytes = QuickJS.serializeSnapshot(vm.snapshot());
const snapshotMs = performance.now() - t;
vm.dispose();
console.log(`snapshot: ${bytes.length} bytes raw, ${gzipSync(bytes).length} gzipped, ${snapshotMs.toFixed(1)} ms`);

// 5. Restore in a fresh instance, answer the pause, continue.
t = performance.now();
vm = await QuickJS.restore(QuickJS.deserializeSnapshot(bytes), options());
registerHost(vm, false);
const restoreMs = performance.now() - t;
run(vm, `__pending["p1"]("merge")`);
vm.executePendingJobs();
console.log(`restored in ${restoreMs.toFixed(1)} ms; result =`, run(vm, "String(globalThis.result)"));

// 6. Budget: a runaway loop is interrupted and the VM stays usable.
try {
	budget = 100_000;
	vm.evalCode("while (true) {}").dispose();
	console.log("budget: NOT interrupted");
} catch (error) {
	console.log("budget: interrupted;", "VM still usable:", run(vm, "String(1 + 2)"));
	error.dispose?.();
}
vm.dispose();
