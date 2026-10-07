import type { Snapshot } from "quickjs-wasi";
import type { CallRunner, DataAdmin, ExecuteResult, HeadRef } from "./call-runner.ts";
import type { DataPort, DataRow } from "./data-port.ts";
import { OverlayDataPort } from "./overlay-data-port.ts";
import { NO_PEERS, type PeerPort } from "./peer-port.ts";
import { VmPool } from "./vm-pool.ts";
import { DEFAULT_LIMITS, WorldVm, type Mode, type Outcome, type VmLimits } from "./world-vm.ts";

export interface LocalCallRunnerDeps {
	readonly wasm: WebAssembly.Module;
	readonly limits?: VmLimits;
	readonly data: DataPort;
	/** A snapshot blob by its content hash. */
	readonly blob: (hash: string) => Promise<Uint8Array>;
	/** The other worlds, for a call that came through `chain`. */
	readonly peers?: (chain: readonly string[]) => PeerPort;
	/** How many calls run at once; more wait. Each running call holds a VM of about the snapshot's size. */
	readonly concurrentCalls?: number;
}

const CONCURRENT_CALLS: number = 8;
const WARM_VMS: number = 2;

/** Calls on pooled VMs in this isolate, over a data store in this isolate. */
export class LocalCallRunner implements CallRunner, DataAdmin {
	private readonly pool: VmPool;
	/** The snapshot of the newest head asked for; an older head's snapshot is fetched without replacing it. */
	private newest: { readonly head: HeadRef; readonly snapshot: Promise<Snapshot> } | undefined;

	constructor(private readonly deps: LocalCallRunnerDeps) {
		const limits = deps.limits ?? DEFAULT_LIMITS;
		this.pool = new VmPool((snapshot) => WorldVm.fromSnapshot(snapshot, deps.wasm, limits), deps.concurrentCalls ?? CONCURRENT_CALLS, WARM_VMS);
	}

	call(name: string, args: readonly unknown[], chain: readonly string[], head: HeadRef): Promise<Outcome> {
		return this.run(head, this.deps.data, chain, (vm, mode) => vm.invoke(name, args, mode));
	}

	async execute(expression: string, head: HeadRef): Promise<ExecuteResult> {
		const overlay = new OverlayDataPort(this.deps.data);
		const outcome = await this.run(head, overlay, [], (vm, mode) => vm.evaluate(expression, mode));
		return { ...outcome, rolledBack: overlay.changes() };
	}

	async list(prefix: string): Promise<readonly DataRow[]> {
		return this.deps.data.list(prefix);
	}

	async delete(key: string): Promise<boolean> {
		return this.deps.data.delete(key);
	}

	dispose(): void {
		this.pool.dispose();
	}

	private async run(head: HeadRef, data: DataPort, chain: readonly string[], body: (vm: WorldVm, mode: Mode) => Promise<Outcome>): Promise<Outcome> {
		const mode: Mode = { kind: "live", data, peers: (this.deps.peers ?? (() => NO_PEERS))(chain) };
		return this.pool.run({ revision: head.revision, snapshot: await this.snapshotOf(head) }, (vm) => body(vm, mode));
	}

	private snapshotOf(head: HeadRef): Promise<Snapshot> {
		if (this.newest?.head.blob === head.blob) return this.newest.snapshot;
		const snapshot = this.deps.blob(head.blob).then(WorldVm.deserialize);
		if (!this.newest || head.revision >= this.newest.head.revision) {
			const entry = { head, snapshot };
			this.newest = entry;
			snapshot.catch(() => {
				if (this.newest === entry) this.newest = undefined;
			});
		}
		return snapshot;
	}
}
