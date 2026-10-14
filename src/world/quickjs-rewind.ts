import { QuickJS, type Snapshot } from "quickjs-wasi";

/**
 * What a QuickJS VM keeps outside its linear memory, as quickjs-wasi 3.6.2 lays it out (the version is pinned in
 * package.json). Its compiled module has one mutable global, the exported `__stack_pointer`, and no extension is loaded,
 * so the instance's state is its linear memory, that global and the fields below.
 */
interface Internals {
	readonly exports: {
		readonly memory: WebAssembly.Memory;
		readonly __stack_pointer: WebAssembly.Global;
		qjs_set_runtime_and_context(runtime: number, context: number): void;
	};
	readonly hostCallbacks: Map<string, unknown>;
	readonly _ownedHandles: Set<unknown>;
	readonly loadedExtensions: readonly unknown[];
	nextInternalId: number;
	_global: unknown;
	_versions: unknown;
	_undefined: unknown;
	_null: unknown;
	_true: unknown;
	_false: unknown;
	_activeScope: unknown;
}

type Options = Parameters<typeof QuickJS.restore>[1];

const applyLimits = (QuickJS as unknown as { applyLimits(vm: QuickJS, options: Options): void }).applyLimits;

/**
 * Put `vm` back at `snapshot` in place, as `QuickJS.restore` would build it, without a new WebAssembly instance: copy
 * the snapshot's memory over the instance's, set the stack pointer and the runtime and context pointers, apply the
 * limits again, and drop every handle and callback the wrapper held into the old heap (they point into memory that no
 * longer holds them, so they are dropped, never freed). Answers false, changing nothing, when it cannot: the memory
 * grew past the snapshot's and cannot shrink, or the snapshot carries extensions. The caller registers its host
 * callbacks again, as after a restore.
 */
export function rewindInPlace(vm: QuickJS, snapshot: Snapshot, options: Options): boolean {
	const internals = vm as unknown as Internals;
	const memory = internals.exports.memory;
	if (memory.buffer.byteLength !== snapshot.memory.byteLength) return false;
	if (snapshot.extensions.length > 0 || internals.loadedExtensions.length > 0) return false;
	new Uint8Array(memory.buffer).set(snapshot.memory);
	internals.exports.qjs_set_runtime_and_context(snapshot.runtimePtr, snapshot.contextPtr);
	internals.exports.__stack_pointer.value = snapshot.stackPointer;
	internals.hostCallbacks.clear();
	internals._ownedHandles.clear();
	internals.nextInternalId = 1;
	internals._global = null;
	internals._versions = null;
	internals._undefined = null;
	internals._null = null;
	internals._true = null;
	internals._false = null;
	internals._activeScope = null;
	applyLimits(vm, options);
	return true;
}
