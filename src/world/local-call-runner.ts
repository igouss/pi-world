import type { Snapshot } from "quickjs-wasi";
import type { CallRunner, CallScope, DataAdmin, ExecuteResult, HeadRef } from "./call-runner.ts";
import type { DataRow, DataStore } from "./data-port.ts";
import type { Grants } from "./grants.ts";
import { OverlayDataPort } from "./overlay-data-port.ts";
import { NO_PEERS, type PeerPort } from "./peer-port.ts";
import { VmPool } from "./vm-pool.ts";
import { DEFAULT_LIMITS, WorldVm, type Mode, type Outcome, type VmLimits } from "./world-vm.ts";

export interface LocalCallRunnerDeps {
	readonly wasm: WebAssembly.Module;
	readonly limits?: VmLimits;
	readonly data: DataStore;
	/** A snapshot blob by its content hash. */
	readonly blob: (hash: string) => Promise<Uint8Array>;
	/** The other worlds, for a call that came through `chain`, as the world's grants let it reach them. */
	readonly peers?: (chain: readonly string[], grants: Grants) => PeerPort;
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

	/**
	 * A call is atomic: its data writes are recorded while it runs, which it reads back, and made in one transaction
	 * when it succeeds; a call that fails leaves no write. Other calls see its writes only once it has succeeded.
	 */
	async call(name: string, args: readonly unknown[], chain: readonly string[], scope: CallScope): Promise<Outcome> {
		const { outcome, writes } = await this.run(scope, chain, (vm, mode) => vm.invoke(name, args, mode));
		if (outcome.ok) writes.commit();
		return outcome;
	}

	/** A preview: its data writes are recorded and dropped, and named in the result. */
	async execute(expression: string, scope: CallScope): Promise<ExecuteResult> {
		const { outcome, writes } = await this.run(scope, [], (vm, mode) => vm.evaluate(expression, mode));
		return { ...outcome, rolledBack: writes.changes() };
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

	private async run(
		{ head, grants }: CallScope,
		chain: readonly string[],
		body: (vm: WorldVm, mode: Mode) => Promise<Outcome>,
	): Promise<{ outcome: Outcome; writes: OverlayDataPort }> {
		const writes = new OverlayDataPort(this.deps.data);
		const mode: Mode = { kind: "live", data: writes, peers: this.deps.peers?.(chain, grants) ?? NO_PEERS };
		const outcome = await this.pool.run({ revision: head.revision, snapshot: await this.snapshotOf(head) }, (vm) => body(vm, mode));
		return { outcome, writes };
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
