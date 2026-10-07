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

/**
 * VMs for calls, so a world answers several calls at once. Each call gets a VM at the head it names and keeps it until
 * it settles, awaits on other worlds included; the VM then returns to the newest head seen, in the background. At
 * most `max` VMs exist at a time; further calls wait for one. Up to `warm` idle VMs are kept ready.
 */
export class VmPool {
	private readonly idle: Idle[] = [];
	private readonly waiting: (() => void)[] = [];
	private active: number = 0;
	private newest: PoolHead | undefined;

	constructor(
		private readonly open: (snapshot: Snapshot) => Promise<WorldVm>,
		private readonly max: number,
		private readonly warm: number,
	) {}

	async run<T>(head: PoolHead, body: (vm: WorldVm) => Promise<T>): Promise<T> {
		const newest = !this.newest || head.revision >= this.newest.revision ? head : this.newest;
		this.newest = newest;
		await this.slot();
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

	/** Return a used VM to the newest head, or drop it when enough are warm. */
	private async recycle(vm: WorldVm): Promise<void> {
		try {
			const head = this.newest!;
			if (this.idle.length >= this.warm) {
				vm.dispose();
				return;
			}
			await vm.reset(head.snapshot);
			this.idle.push({ vm, revision: head.revision });
		} catch {
			vm.dispose();
		} finally {
			this.free();
		}
	}

	private async slot(): Promise<void> {
		if (this.active < this.max) {
			this.active++;
			return;
		}
		await new Promise<void>((resolve) => this.waiting.push(resolve));
	}

	/** A freed slot passes straight to the next waiting call. */
	private free(): void {
		const next = this.waiting.shift();
		if (next) next();
		else this.active--;
	}
}
