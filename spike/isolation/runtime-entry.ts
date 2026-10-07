// The code a world's facet runs in its own isolate: QuickJS, the facet's own SQLite, and a capability back to the host.
import { DurableObject } from "cloudflare:workers";
import { QuickJS } from "quickjs-wasi";
// @ts-expect-error provided by the loader's module map as { wasm: bytes }
import wasm from "./quickjs.wasm";

export class Runtime extends DurableObject<{ CAP: { blob(n: number): Promise<Uint8Array> } }> {
	async evaluate(code: string): Promise<string> {
		const vm = await QuickJS.create({ wasm });
		try {
			return vm.evalCode(code).consume((h) => h.toString());
		} finally {
			vm.dispose();
		}
	}

	async snapshotRoundTrip(bytes: Uint8Array): Promise<{ received: number; restored: string }> {
		const vm = await QuickJS.restore(QuickJS.deserializeSnapshot(bytes), { wasm });
		try {
			return { received: bytes.length, restored: vm.evalCode("typeof greet === 'function' ? greet('facet') : 'missing'").consume((h) => h.toString()) };
		} finally {
			vm.dispose();
		}
	}

	async fetchFromHost(n: number): Promise<number> {
		return (await this.env.CAP.blob(n)).length;
	}

	cpu(n: number): number {
		let x = 0;
		for (let i = 0; i < n; i++) x = (x + i * 7) % 1000003;
		return x;
	}

	dataSet(key: string, value: string): void {
		this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS d (k TEXT PRIMARY KEY, v TEXT)");
		this.ctx.storage.sql.exec("INSERT OR REPLACE INTO d VALUES (?, ?)", key, value);
	}

	dataGet(key: string): string | null {
		this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS d (k TEXT PRIMARY KEY, v TEXT)");
		return (this.ctx.storage.sql.exec<{ v: string }>("SELECT v FROM d WHERE k = ?", key).toArray()[0]?.v) ?? null;
	}
}
