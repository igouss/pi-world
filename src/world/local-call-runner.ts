import type { Snapshot } from "quickjs-wasi";
import { BUSY_REFUSAL, isRefused, type CallRunner, type CallScope, type DataAdmin, type ExecuteResult, type HeadRef, type Refused } from "./call-runner.ts";
import type { DataRow, DataStore } from "./data-port.ts";
import type { Grants } from "./grants.ts";
import { OverlayDataPort } from "./overlay-data-port.ts";
import { NO_PEERS, type PeerPort } from "./peer-port.ts";
import { Mutex } from "./mutex.ts";
import { BUSY, VmPool } from "./vm-pool.ts";
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
	/** The clock calls' start deadlines are read on; the world's. */
	readonly now?: () => number;
}

const CONCURRENT_CALLS: number = 8;
const WARM_VMS: number = 2;
/** How many times a call runs again in the rerun lane before it gives up committing over data other calls keep changing. */
const RUNS: number = 5;
/** A run whose reads went stale before it could commit. */
const STALE: unique symbol = Symbol("stale");

/** Calls on pooled VMs in this isolate, over a data store in this isolate. */
export class LocalCallRunner implements CallRunner, DataAdmin {
	private readonly pool: VmPool;
	/** Calls whose reads went stale run again here, one at a time. */
	private readonly reruns: Mutex = new Mutex();
	/** The snapshot of the newest head asked for; an older head's snapshot is fetched without replacing it. */
	private newest: { readonly head: HeadRef; readonly snapshot: Promise<Snapshot> } | undefined;

	constructor(private readonly deps: LocalCallRunnerDeps) {
		const limits = deps.limits ?? DEFAULT_LIMITS;
		this.pool = new VmPool((snapshot) => WorldVm.fromSnapshot(snapshot, deps.wasm, limits), deps.concurrentCalls ?? CONCURRENT_CALLS, WARM_VMS);
	}

	/**
	 * A call is atomic and serializable: its data writes are recorded while it runs, which it reads back, and made in
	 * one transaction when it succeeds, if nothing it read was changed meanwhile by another call. A call whose reads
	 * went stale runs again from the start, in the world's rerun lane, one rerun at a time, so calls that collide on
	 * one key make progress instead of colliding again; after `RUNS` runs in the lane it fails as a conflict. A rerun
	 * repeats the calls it makes to other worlds. A call that fails leaves no write. Other calls see its writes only
	 * once it has committed.
	 */
	async call(name: string, args: readonly unknown[], chain: readonly string[], scope: CallScope): Promise<Outcome | Refused> {
		const attempt = async (scope: CallScope): Promise<Outcome | Refused | typeof STALE> => {
			const ran = await this.run(scope, chain, (vm, mode) => vm.invoke(name, args, mode));
			if (isRefused(ran)) return ran;
			const { outcome, writes } = ran;
			return !outcome.ok || writes.commitIfUnchanged() ? outcome : STALE;
		};
		const first = await attempt(scope);
		if (first !== STALE) return first;
		// The call was admitted; its start deadline does not apply to its reruns, which the lane and RUNS bound.
		const admitted = { ...scope, startBy: Number.POSITIVE_INFINITY };
		return this.reruns.run(async () => {
			for (let run = 0; run < RUNS; run++) {
				const outcome = await attempt(admitted);
				if (outcome !== STALE) return outcome;
			}
			return { ok: false, failure: "conflict", error: `data this call read kept changing under it; it ran ${RUNS + 1} times and never committed` };
		});
	}

	/** A preview: its data writes are recorded and dropped, and named in the result. */
	async execute(expression: string, scope: CallScope): Promise<ExecuteResult | Refused> {
		const ran = await this.run(scope, [], (vm, mode) => vm.evaluate(expression, mode));
		if (isRefused(ran)) return ran;
		return { ...ran.outcome, rolledBack: ran.writes.changes() };
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

	/** Run one evaluation on a pooled VM, if it can start before the call's deadline; a call that cannot is refused. */
	private async run(
		{ head, grants, startBy }: CallScope,
		chain: readonly string[],
		body: (vm: WorldVm, mode: Mode) => Promise<Outcome>,
	): Promise<{ outcome: Outcome; writes: OverlayDataPort } | Refused> {
		const snapshot = await this.snapshotOf(head);
		const left = startBy - (this.deps.now ?? Date.now)();
		if (left <= 0) return BUSY_REFUSAL;
		const writes = new OverlayDataPort(this.deps.data);
		const mode: Mode = { kind: "live", data: writes, peers: awaitsNoted(this.deps.peers?.(chain, grants) ?? NO_PEERS, writes) };
		const ran = await this.pool.run({ revision: head.revision, snapshot }, (vm) => body(vm, mode), left);
		return ran === BUSY ? BUSY_REFUSAL : { outcome: ran, writes };
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

/** The other worlds, telling the overlay whenever world code awaits one of them: the only way a live evaluation yields. */
function awaitsNoted(peers: PeerPort, writes: OverlayDataPort): PeerPort {
	return {
		call: (worldId, name, args) => (writes.crossedAwait(), peers.call(worldId, name, args)),
		list: () => (writes.crossedAwait(), peers.list()),
		functions: (worldId) => (writes.crossedAwait(), peers.functions(worldId)),
	};
}
