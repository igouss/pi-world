import runtimeHash from "../../../dist/runtime/world-runtime-hash.txt";
import runtimeSource from "../../../dist/runtime/world-runtime.txt";
import wasmBytes from "../../../dist/runtime/quickjs.bin";
import type { HostApi } from "../host-api.ts";
import type { RuntimeFacet } from "../runtime/runtime-facet.ts";

export type RuntimeFacetStub = Fetcher<RuntimeFacet>;

/**
 * The world's runtime facet, in an isolate of the world's own: loaded code with one loader id shares one isolate, so
 * the id names the world, and it names the bundle's hash so a node never reuses an older compiled runtime.
 */
export function runtimeFacet(loader: WorkerLoader, facets: DurableObjectFacets, worldId: string, host: Fetcher<HostApi & Rpc.WorkerEntrypointBranded>): RuntimeFacetStub {
	const worker = loader.get(`world-runtime-${runtimeHash.trim()}-${worldId}`, () => ({
		compatibilityDate: "2026-08-18",
		compatibilityFlags: ["js_rpc"],
		mainModule: "world-runtime.js",
		modules: { "world-runtime.js": runtimeSource, "quickjs.wasm": { wasm: wasmBytes } },
		env: { HOST: host, WORLD_ID: worldId },
	}));
	return facets.get<RuntimeFacet>("runtime", () => ({ class: worker.getDurableObjectClass<RuntimeFacet>("RuntimeFacet") }));
}
