import { DurableObject } from "cloudflare:workers";
// Supplied by the loader's module map as { wasm: bytes }: the loaded isolate compiles its own copy.
import wasm from "./quickjs.wasm";
import type { CallScope, ExecuteResult } from "../../world/call-runner.ts";
import { chainedPeers } from "../../world/chained-peers.ts";
import { grantedPeers } from "../../world/grants.ts";
import type { DataRow, DataStore } from "../../world/data-port.ts";
import { LocalCallRunner } from "../../world/local-call-runner.ts";
import { LocalWorkbench } from "../../world/local-workbench.ts";
import type { Candidate, Developed, Heap } from "../../world/workbench.ts";
import type { Enrolment } from "../../world/attempt.ts";
import type { Check } from "../../check/check.ts";
import type { AttemptMode, CatalogueEntry, Outcome } from "../../world/world-vm.ts";
import type { DataRecord, HostApi } from "../host-api.ts";
import { sqlDataPort } from "./sql-data-port.ts";

/** Set in the same transaction as the imported rows, so an import happens once. */
const IMPORTED: string = "__imported";

interface RuntimeEnv {
	readonly HOST: HostApi;
	readonly WORLD_ID: string;
}

/**
 * A world's VM work and data, in an isolate of the world's own: a facet of the world's cell, loaded through a Worker
 * Loader. Its calls, previews, develops, checks, rollbacks and upgrades run here, so their CPU does not hold up other
 * worlds. The world's data lives in the facet's own SQLite; snapshots come from the host by content hash, and other
 * worlds are reached through the host.
 */
export class RuntimeFacet extends DurableObject<RuntimeEnv> {
	private readonly data: DataStore = sqlDataPort(this.ctx.storage);
	private readonly runner: LocalCallRunner = new LocalCallRunner({
		wasm,
		data: this.data,
		blob: (hash) => this.env.HOST.blob(hash),
		peers: (chain, grants) => grantedPeers(chainedPeers(this.env.WORLD_ID, chain, this.env.HOST), grants),
	});

	private readonly workbench: LocalWorkbench = new LocalWorkbench({ wasm, blob: (hash) => this.env.HOST.blob(hash) });

	workbenchGenesis(): Promise<Heap> {
		return this.workbench.genesis();
	}

	workbenchOpen(head: string, prelude: number): Promise<{ catalogue: readonly CatalogueEntry[]; upgraded: Heap | undefined }> {
		return this.workbench.open(head, prelude);
	}

	workbenchDevelop(head: string, source: string, checks: Check[], mode: AttemptMode): Promise<Developed> {
		return this.workbench.develop(head, source, checks, mode);
	}

	workbenchEnrol(head: string, candidate: Candidate, mode: AttemptMode): Promise<Enrolment> {
		return this.workbench.enrol(head, candidate, mode);
	}

	workbenchRollback(target: string, prelude: number): Promise<Heap> {
		return this.workbench.rollback(target, prelude);
	}

	call(name: string, args: unknown[], chain: string[], scope: CallScope): Promise<Outcome> {
		return this.runner.call(name, args, chain, scope);
	}

	execute(expression: string, scope: CallScope): Promise<ExecuteResult> {
		return this.runner.execute(expression, scope);
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
