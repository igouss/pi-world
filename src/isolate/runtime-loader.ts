import runtimeSource from "../../dist/runtime/world-runtime.txt";
import wasmBytes from "../../dist/runtime/quickjs.bin";
import type { RuntimeFacet } from "./runtime-facet.ts";

interface WorkerLoader {
	get(id: string, code: () => object): { getDurableObjectClass(name: string): unknown };
}

interface Facets {
	get(name: string, start: () => { class: unknown }): Rpc.DurableObjectBranded & RuntimeFacet;
}

/** Changes whenever the runtime bundle changes, so a node never reuses a compiled older runtime. */
const RUNTIME_HASH: string = fnv1a(runtimeSource);

/**
 * The world's runtime facet, in an isolate of the world's own: the loader id names the world, because loaded code
 * with one id shares one isolate.
 */
export function runtimeFacet(loader: WorkerLoader, facets: Facets, worldId: string, host: unknown): Rpc.DurableObjectBranded & RuntimeFacet {
	const worker = loader.get(`world-runtime-${RUNTIME_HASH}-${worldId}`, () => ({
		compatibilityDate: "2026-08-18",
		compatibilityFlags: ["js_rpc"],
		mainModule: "world-runtime.js",
		modules: { "world-runtime.js": runtimeSource, "quickjs.wasm": { wasm: wasmBytes } },
		env: { HOST: host },
	}));
	return facets.get("runtime", () => ({ class: worker.getDurableObjectClass("RuntimeFacet") }));
}

function fnv1a(text: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash.toString(16).padStart(8, "0");
}
