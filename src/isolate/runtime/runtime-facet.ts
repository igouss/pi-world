import { DurableObject } from "cloudflare:workers";
// Supplied by the loader's module map as { wasm: bytes }: the loaded isolate compiles its own copy.
import wasm from "./quickjs.wasm";
import type { ExecuteResult, HeadRef } from "../../world/call-runner.ts";
import { chainedPeers } from "../../world/chained-peers.ts";
import type { DataPort, DataRow } from "../../world/data-port.ts";
import { LocalCallRunner } from "../../world/local-call-runner.ts";
import type { Outcome } from "../../world/world-vm.ts";
import type { DataRecord, HostApi } from "../host-api.ts";
import { sqlDataPort } from "./sql-data-port.ts";

/** Set in the same transaction as the imported rows, so an import happens once. */
const IMPORTED: string = "__imported";

interface RuntimeEnv {
	readonly HOST: HostApi;
	readonly WORLD_ID: string;
}

/**
 * A world's calls and data, in an isolate of the world's own: a facet of the world's cell, loaded through a Worker
 * Loader. CPU work here does not hold up other worlds. The world's data lives in the facet's own SQLite; snapshots
 * come from the host by content hash, and other worlds are reached through the host.
 */
export class RuntimeFacet extends DurableObject<RuntimeEnv> {
	private readonly data: DataPort = sqlDataPort(this.ctx.storage.sql);
	private readonly runner: LocalCallRunner = new LocalCallRunner({
		wasm,
		data: this.data,
		blob: (hash) => this.env.HOST.blob(hash),
		peers: (chain) => chainedPeers(this.env.WORLD_ID, chain, this.env.HOST),
	});

	call(name: string, args: unknown[], chain: string[], head: HeadRef): Promise<Outcome> {
		return this.runner.call(name, args, chain, head);
	}

	execute(expression: string, head: HeadRef): Promise<ExecuteResult> {
		return this.runner.execute(expression, head);
	}

	dataList(prefix: string): readonly DataRow[] {
		return this.data.list(prefix);
	}

	dataDelete(key: string): boolean {
		return this.data.delete(key);
	}

	/** Take over rows the world's cell held in its own data table; a second import does nothing. */
	importData(records: DataRecord[]): void {
		if (this.ctx.storage.kv.get(IMPORTED)) return;
		this.ctx.storage.transactionSync(() => {
			for (const { key, json } of records) this.data.set(key, json);
			this.ctx.storage.kv.put(IMPORTED, true);
		});
	}
}
