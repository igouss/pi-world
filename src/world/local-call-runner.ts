import type { Snapshot } from "quickjs-wasi";
import type { CallRunner, ExecuteResult, HeadRef } from "./call-runner.ts";
import type { DataPort, DataRow } from "./data-port.ts";
import { OverlayDataPort } from "./overlay-data-port.ts";
import type { PeerPort } from "./peer-port.ts";
import { VmPool } from "./vm-pool.ts";
import { DEFAULT_LIMITS, WorldVm, type Outcome, type VmLimits } from "./world-vm.ts";

export interface LocalCallRunnerDeps {
	readonly wasm: WebAssembly.Module;
	readonly limits?: VmLimits;
	readonly data: DataPort;
	/** The other worlds, for a call that came through `chain`. */
	readonly peers: (chain: readonly string[]) => PeerPort;
	/** The snapshot of a head; asked once per head. */
	readonly snapshot: (head: HeadRef) => Promise<Snapshot>;
	/** How many calls run at once; more wait. Each running call holds a VM of about the snapshot's size. */
	readonly concurrentCalls?: number;
}

const CONCURRENT_CALLS: number = 8;
const WARM_VMS: number = 2;

/** Calls on pooled VMs in this isolate, over a data store in this isolate. */
export class LocalCallRunner implements CallRunner {
	private readonly pool: VmPool;
	private cached: { readonly blob: string; readonly snapshot: Promise<Snapshot> } | undefined;

	constructor(private readonly deps: LocalCallRunnerDeps) {
		const limits = deps.limits ?? DEFAULT_LIMITS;
		this.pool = new VmPool((snapshot) => WorldVm.fromSnapshot(snapshot, deps.wasm, limits), deps.concurrentCalls ?? CONCURRENT_CALLS, WARM_VMS);
	}

	async call(name: string, args: readonly unknown[], chain: readonly string[], head: HeadRef): Promise<Outcome> {
		const peers = this.deps.peers(chain);
		return this.pool.run({ revision: head.revision, snapshot: await this.snapshotOf(head) }, (vm) =>
			vm.invoke(name, args, { kind: "live", data: this.deps.data, peers }),
		);
	}

	async execute(expression: string, chain: readonly string[], head: HeadRef): Promise<ExecuteResult> {
		const overlay = new OverlayDataPort(this.deps.data);
		const peers = this.deps.peers(chain);
		const outcome = await this.pool.run({ revision: head.revision, snapshot: await this.snapshotOf(head) }, (vm) =>
			vm.evaluate(expression, { kind: "live", data: overlay, peers }),
		);
		return { ...outcome, rolledBack: overlay.changes() };
	}

	async dataList(prefix: string): Promise<readonly DataRow[]> {
		return this.deps.data.list(prefix);
	}

	async dataDelete(key: string): Promise<boolean> {
		return this.deps.data.delete(key);
	}

	dispose(): void {
		this.pool.dispose();
	}

	/** The newest head's snapshot is kept; a call at an older head, still running elsewhere, asks for its own. */
	private snapshotOf(head: HeadRef): Promise<Snapshot> {
		if (this.cached?.blob === head.blob) return this.cached.snapshot;
		const snapshot = this.deps.snapshot(head);
		this.cached = { blob: head.blob, snapshot };
		snapshot.catch(() => {
			if (this.cached?.snapshot === snapshot) this.cached = undefined;
		});
		return snapshot;
	}
}
