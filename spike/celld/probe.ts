// Spike: does the stack load and run inside a celld cell?
// /vm: QuickJS create, develop, snapshot into the cell's SQLite, restore.
// /harness: pi-durable over the cell's SQLite, one input answered by Claude (token from the request header).
import { DurableObject } from "cloudflare:workers";
import { QuickJS } from "quickjs-wasi";
import wasm from "quickjs-wasi/quickjs.wasm";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { AssistantEntry, createRegistry, Harness } from "@earendil-works/pi-durable";
import { SqliteStorage, type SqliteDatabase, type SqliteExecutor, type SqliteValue } from "@earendil-works/pi-durable/storage/sqlite";

function executor(sql: SqlStorage): SqliteExecutor {
	const rows = (q: string, p: SqliteValue[]) => sql.exec(q, ...(p as any[])).toArray() as any[];
	return {
		exec: async (q) => { sql.exec(q); },
		run: async (q, ...p) => { rows(q, p); },
		get: async (q, ...p) => rows(q, p)[0],
		all: async (q, ...p) => rows(q, p),
	};
}
function database(storage: DurableObjectStorage): SqliteDatabase {
	const inner = executor(storage.sql);
	let tail: Promise<unknown> = Promise.resolve();
	const queue = <T>(f: () => Promise<T>): Promise<T> => { const r = tail.then(f); tail = r.catch(() => {}); return r; };
	return {
		exec: (q) => queue(() => inner.exec(q)),
		run: (q, ...p) => queue(() => inner.run(q, ...p)),
		get: (q, ...p) => queue(() => inner.get(q, ...p)),
		all: (q, ...p) => queue(() => inner.all(q, ...p)),
		transaction: (cb) => queue(() => storage.transaction(() => cb(inner))),
		close: async () => {},
	};
}

export class Probe extends DurableObject {
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const t0 = Date.now();
		try {
			if (url.pathname === "/vm") {
				let vm = await QuickJS.create({ wasm, memoryLimit: 64 << 20 });
				vm.evalCode(`globalThis.f = (s) => s.toUpperCase();`).dispose();
				const bytes = QuickJS.serializeSnapshot(vm.snapshot());
				vm.dispose();
				this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS blob (id INTEGER PRIMARY KEY, bytes BLOB)");
				this.ctx.storage.sql.exec("INSERT OR REPLACE INTO blob VALUES (1, ?)", bytes);
				const back = new Uint8Array(this.ctx.storage.sql.exec("SELECT bytes FROM blob WHERE id = 1").one().bytes as ArrayBuffer);
				vm = await QuickJS.restore(QuickJS.deserializeSnapshot(back), { wasm, memoryLimit: 64 << 20 });
				const out = vm.evalCode(`f("hello")`).consume((h) => h.toString());
				vm.dispose();
				return Response.json({ out, bytes: bytes.length, ms: Date.now() - t0 });
			}
			if (url.pathname === "/harness") {
				const token = request.headers.get("x-token") ?? "";
				const models = createModels({ authContext: { env: async (n) => (n === "ANTHROPIC_OAUTH_TOKEN" ? token : undefined), fileExists: async () => false } });
				models.setProvider(anthropicProvider());
				const storage = await SqliteStorage.open(database(this.ctx.storage));
				const harness = await Harness.open(storage, { models, registry: createRegistry(), settings: { progress: { partialIntervalMs: 1000, outputIntervalMs: 1000 } } }, BACKGROUND_CONTEXT);
				const root = await harness.root(BACKGROUND_CONTEXT, { agent: { model: { provider: "anthropic", modelId: url.searchParams.get("model") ?? "claude-haiku-4-5" } } });
				const sub = await root.submit({ type: "input", content: "Reply with exactly: pong" }, BACKGROUND_CONTEXT);
				const settled = await sub.wait(BACKGROUND_CONTEXT);
				await harness.close(BACKGROUND_CONTEXT);
				return Response.json({ settled, ms: Date.now() - t0 });
			}
			return new Response("probe", { status: 404 });
		} catch (error) {
			return Response.json({ error: String((error as Error)?.stack ?? error) }, { status: 500 });
		}
	}
}

export default {
	fetch(request: Request, env: { PROBE: DurableObjectNamespace<Probe> }) {
		return env.PROBE.getByName("probe").fetch(request);
	},
};
