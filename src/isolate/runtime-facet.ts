import { DurableObject } from "cloudflare:workers";
// Supplied by the loader's module map as { wasm: bytes }: the loaded isolate compiles its own copy.
import wasm from "./quickjs.wasm";
import { sqlDataPort } from "../cell/sql-data-port.ts";
import type { ExecuteResult, HeadRef } from "../world/call-runner.ts";
import { chainedPeers } from "../world/chained-peers.ts";
import type { DataRow } from "../world/data-port.ts";
import { LocalCallRunner } from "../world/local-call-runner.ts";
import { WorldVm, type Outcome } from "../world/world-vm.ts";
import type { DataRecord, HostApi } from "./host-api.ts";

const IMPORTED: string = "__imported";

/**
 * A world's calls and data, in an isolate of the world's own: a facet of the world's cell, loaded through a Worker
 * Loader. CPU work here does not hold up other worlds. It keeps the world's data in its own SQLite, asks the host for
 * snapshots by hash, and reaches other worlds through the host.
 */
export class RuntimeFacet extends DurableObject<{ HOST: HostApi }> {
	private runner: LocalCallRunner | undefined;

	call(self: string, name: string, args: unknown[], chain: string[], head: HeadRef): Promise<Outcome> {
		return this.runnerFor(self).call(name, args, chain, head);
	}

	execute(self: string, expression: string, chain: string[], head: HeadRef): Promise<ExecuteResult> {
		return this.runnerFor(self).execute(expression, chain, head);
	}

	dataList(prefix: string): readonly DataRow[] {
		return sqlDataPort(this.ctx.storage.sql).list(prefix);
	}

	dataDelete(key: string): boolean {
		return sqlDataPort(this.ctx.storage.sql).delete(key);
	}

	/** Take over the rows the world kept before its runtime had storage of its own; done once. */
	importData(records: DataRecord[]): number {
		const data = sqlDataPort(this.ctx.storage.sql);
		if (this.ctx.storage.kv.get(IMPORTED)) return 0;
		this.ctx.storage.transactionSync(() => {
			for (const { key, json } of records) data.set(key, json);
			this.ctx.storage.kv.put(IMPORTED, true);
		});
		return records.length;
	}

	private runnerFor(self: string): LocalCallRunner {
		this.runner ??= new LocalCallRunner({
			wasm,
			data: sqlDataPort(this.ctx.storage.sql),
			peers: (chain) =>
				chainedPeers(self, chain, {
					call: (id, name, args, path) => this.env.HOST.peerCall(id, name, [...args], [...path]),
					list: () => this.env.HOST.peerList(),
					functions: (id) => this.env.HOST.peerFunctions(id),
				}),
			snapshot: async (head) => WorldVm.deserialize(await this.env.HOST.blob(head.blob)),
		});
		return this.runner;
	}
}
