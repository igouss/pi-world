// Spike: a world's calls in a facet loaded through a Worker Loader (own isolate, own SQLite), and snapshots in R2.
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { QuickJS } from "quickjs-wasi";
import wasmModule from "quickjs-wasi/quickjs.wasm";
import runtimeSource from "./dist/runtime.txt";
import wasmBytes from "./dist/quickjs.bin";

interface Env {
	HOST: DurableObjectNamespace<Host>;
	LOADER: { get(id: string, code: () => unknown): { getDurableObjectClass(name: string): unknown } };
	SNAPSHOTS: R2Bucket;
}

/** What the host lends the facet: one method, run in the host's isolate. */
export class Cap extends WorkerEntrypoint<Env> {
	blob(n: number): Uint8Array {
		return new Uint8Array(n).fill(3);
	}
}

export class Host extends DurableObject<Env> {
	private runtime() {
		const worker = this.env.LOADER.get("runtime-v1", () => ({
			compatibilityDate: "2026-08-18",
			compatibilityFlags: ["js_rpc"],
			mainModule: "runtime.js",
			modules: { "runtime.js": runtimeSource, "quickjs.wasm": { wasm: wasmBytes } },
			env: { CAP: (this.ctx as unknown as { exports: { Cap(o: object): unknown } }).exports.Cap({ props: {} }) },
		}));
		const facets = (this.ctx as unknown as { facets: { get(name: string, f: () => object): any } }).facets;
		return facets.get("runtime", () => ({ class: worker.getDurableObjectClass("Runtime") }));
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const q = (k: string) => url.searchParams.get(k);
		const t0 = Date.now();
		const done = (value: unknown) => Response.json({ value, ms: Date.now() - t0 });
		try {
			switch (url.pathname) {
				case "/eval":
					return done(await this.runtime().evaluate(q("code") ?? "1 + 2"));
				case "/snapshot": {
					const vm = await QuickJS.create({ wasm: wasmModule });
					vm.evalCode(`globalThis.greet = (n) => "hi " + n;`).dispose();
					const bytes = QuickJS.serializeSnapshot(vm.snapshot());
					vm.dispose();
					return done(await this.runtime().snapshotRoundTrip(bytes));
				}
				case "/from-host":
					return done(await this.runtime().fetchFromHost(Number(q("n") ?? 1_500_000)));
				case "/facet-cpu":
					return done(await this.runtime().cpu(Number(q("n"))));
				case "/host-cpu": {
					let x = 0;
					for (let i = 0; i < Number(q("n")); i++) x = (x + i * 7) % 1000003;
					return done(x);
				}
				case "/cheap":
					return done("ok");
				case "/data": {
					const runtime = this.runtime();
					if (q("set")) await runtime.dataSet("k", q("set")!);
					return done(await runtime.dataGet("k"));
				}
				case "/r2": {
					const vm = await QuickJS.create({ wasm: wasmModule });
					vm.evalCode(`globalThis.greet = (n) => "hi " + n;`).dispose();
					const raw = QuickJS.serializeSnapshot(vm.snapshot());
					vm.dispose();
					const gz = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer());
					const t1 = Date.now();
					await this.env.SNAPSHOTS.put(`snapshots/spike-${raw.length}.gz`, gz);
					const t2 = Date.now();
					const got = await this.env.SNAPSHOTS.get(`snapshots/spike-${raw.length}.gz`);
					const back = new Uint8Array(await new Response(got!.body.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
					const t3 = Date.now();
					const same = back.length === raw.length && back.every((b, i) => b === raw[i]);
					const head = await this.env.SNAPSHOTS.head("snapshots/nope.gz");
					return done({ raw: raw.length, gz: gz.length, putMs: t2 - t1, getMs: t3 - t2, same, missingHead: head });
				}
				default:
					return new Response("iso", { status: 404 });
			}
		} catch (error) {
			return Response.json({ error: String((error as Error)?.stack ?? error) }, { status: 500 });
		}
	}
}

export default {
	fetch(request: Request, env: Env) {
		const url = new URL(request.url);
		const [, name, ...rest] = url.pathname.split("/");
		return env.HOST.getByName(name!).fetch(new Request(new URL("/" + rest.join("/") + url.search, url), request));
	},
};
