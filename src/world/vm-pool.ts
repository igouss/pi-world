import type { Snapshot } from "quickjs-wasi";
import type { WorldVm } from "./world-vm.ts";

/** The head a call starts from: its revision and its snapshot. */
export interface PoolHead {
	readonly revision: number;
	readonly snapshot: Snapshot;
}

interface Idle {
	readonly vm: WorldVm;
	readonly revision: number;
}

/** What `VmPool.run` answers when no VM came free within the pool's wait: the call did not run. */
export const BUSY: unique symbol = Symbol("busy");

interface Waiter {
	readonly grant: (granted: boolean) => void;
	readonly timer: ReturnType<typeof setTimeout> | undefined;
}

/**
 * VMs for calls, so a world answers several calls at once. Each call gets a VM at the head it names and keeps it until
 * it settles, awaits on other worlds included; the VM then returns to the newest head seen, in the background. At
 * most `max` VMs exist at a time; further calls wait for one, for at most `maxWaitMs`, and are then refused with
 * `BUSY`, so an overloaded world refuses work instead of queueing it without bound. Up to `warm` idle VMs are kept
 * ready.
 */
export class VmPool {
	private readonly idle: Idle[] = [];
	private readonly waiting: Waiter[] = [];
	private active: number = 0;
	/** VMs returning to the newest head, which count as warm while they reset. */
	private resetting: number = 0;
	private newest: PoolHead | undefined;

	constructor(
		private readonly open: (snapshot: Snapshot) => Promise<WorldVm>,
		private readonly max: number,
		private readonly warm: number,
		/** How long a call waits for a VM before it is refused; `undefined` waits as long as it takes. */
		private readonly maxWaitMs?: number,
	) {}

	async run<T>(head: PoolHead, body: (vm: WorldVm) => Promise<T>): Promise<T | typeof BUSY> {
		const newest = !this.newest || head.revision >= this.newest.revision ? head : this.newest;
		this.newest = newest;
		if (!(await this.slot())) return BUSY;
		let vm: WorldVm | undefined;
		try {
			vm = this.takeIdle(head.revision) ?? (await this.open(head.snapshot));
			return await body(vm);
		} finally {
			if (vm) void this.recycle(vm);
			else this.free();
		}
	}

	dispose(): void {
		for (const { vm } of this.idle.splice(0)) vm.dispose();
	}

	private takeIdle(revision: number): WorldVm | undefined {
		for (;;) {
			const next = this.idle.pop();
			if (!next) return undefined;
			if (next.revision === revision) return next.vm;
			next.vm.dispose();
		}
	}

	/** Return a used VM to the newest head, or drop it when enough are warm or resetting toward it. */
	private async recycle(vm: WorldVm): Promise<void> {
		if (this.idle.length + this.resetting >= this.warm) {
			vm.dispose();
			this.free();
			return;
		}
		this.resetting++;
		try {
			const head = this.newest!;
			await vm.rewind(head.snapshot);
			this.idle.push({ vm, revision: head.revision });
		} catch {
			vm.dispose();
		} finally {
			this.resetting--;
			this.free();
		}
	}

	/** A slot for one call: at once if one is free, else the next freed one, unless the wait runs out first. */
	private slot(): Promise<boolean> {
		if (this.active < this.max) {
			this.active++;
			return Promise.resolve(true);
		}
		return new Promise<boolean>((grant) => {
			const waiter: Waiter = {
				grant,
				timer:
					this.maxWaitMs === undefined
						? undefined
						: setTimeout(() => {
								this.waiting.splice(this.waiting.indexOf(waiter), 1);
								grant(false);
							}, this.maxWaitMs),
			};
			this.waiting.push(waiter);
		});
	}

	/** A freed slot passes straight to the next waiting call. */
	private free(): void {
		const next = this.waiting.shift();
		if (!next) {
			this.active--;
			return;
		}
		clearTimeout(next.timer);
		next.grant(true);
	}
}
