import { QuickJS, type Snapshot } from "quickjs-wasi";
import type { DataPort } from "./data-port.ts";
import { PRELUDE } from "./prelude.ts";

/**
 * How the VM meets the outside world while code runs.
 * - `attempt`: a develop, a check or a counterexample. The clock is pinned and random is seeded, so the same source
 *   on the same base gives the same heap. Data is unreachable: touching it fails the evaluation as a host call.
 * - `live`: a direct call or an agent `execute`. Real clock, real random, the world's data store.
 */
export type Mode =
	| { readonly kind: "attempt"; readonly at: number; readonly seed: number }
	| { readonly kind: "live"; readonly data: DataPort };

export type Failure = "threw" | "budget" | "host-call" | "pending";

export type Outcome =
	| { readonly ok: true; readonly value: unknown }
	| { readonly ok: false; readonly failure: Failure; readonly error: string };

export interface CatalogueEntry {
	readonly name: string;
	readonly kind: "function" | "class";
	readonly version: number;
	readonly doc: string;
	readonly params: string;
	readonly source: string;
}

export interface StateEntry {
	readonly name: string;
	readonly version: number;
}

export interface VmLimits {
	/** Interrupt-handler ticks one evaluation may use. QuickJS polls about every 0.1 ms of execution. */
	readonly budget: number;
	readonly memoryBytes: number;
}

export const DEFAULT_LIMITS: VmLimits = { budget: 30_000, memoryBytes: 128 * 1024 * 1024 };

const INIT_TIME_NS: bigint = 1_700_000_000_000n * 1_000_000n;

/**
 * One QuickJS heap with the prelude installed. Synchronous from entry to return: an evaluation never yields, so a
 * caller holding the world's lock sees no interleaving.
 */
export class WorldVm {
	private vm: QuickJS;
	private mode: Mode = { kind: "attempt", at: 0, seed: 1 };
	private ticks: number = 0;
	private metering: boolean = false;
	private hostCalls: string[] = [];
	private rng: () => number = mulberry32(1);
	private clockNs: () => bigint = () => INIT_TIME_NS;

	private constructor(
		private readonly wasm: WebAssembly.Module,
		private readonly limits: VmLimits,
		vm: QuickJS | undefined,
	) {
		this.vm = vm as QuickJS;
	}

	/** A fresh world: the prelude at revision 0. */
	static async create(wasm: WebAssembly.Module, limits: VmLimits = DEFAULT_LIMITS): Promise<WorldVm> {
		const world = new WorldVm(wasm, limits, undefined);
		world.vm = await QuickJS.create(world.options());
		world.vm.newFunction("__hostData", world.hostData).consume((h) => world.vm.setProp(world.vm.global, "__hostData", h));
		world.vm.newFunction("__hostRandom", world.hostRandom).consume((h) => world.vm.setProp(world.vm.global, "__hostRandom", h));
		world.vm.evalCode(PRELUDE, "prelude.js").dispose();
		return world;
	}

	static async restore(snapshot: Snapshot, wasm: WebAssembly.Module, limits: VmLimits = DEFAULT_LIMITS): Promise<WorldVm> {
		const world = new WorldVm(wasm, limits, undefined);
		world.vm = await world.load(snapshot);
		return world;
	}

	static async fromBytes(bytes: Uint8Array, wasm: WebAssembly.Module, limits: VmLimits = DEFAULT_LIMITS): Promise<WorldVm> {
		return WorldVm.restore(QuickJS.deserializeSnapshot(bytes), wasm, limits);
	}

	/** Replace this heap with `snapshot`, in place, so holders of this object keep a valid VM. */
	async reset(snapshot: Snapshot): Promise<void> {
		const next = await this.load(snapshot);
		this.vm.dispose();
		this.vm = next;
	}

	private async load(snapshot: Snapshot): Promise<QuickJS> {
		const vm = await QuickJS.restore(snapshot, this.options());
		vm.registerHostCallback("__hostData", this.hostData);
		vm.registerHostCallback("__hostRandom", this.hostRandom);
		return vm;
	}

	snapshot(): Snapshot {
		this.vm.executePendingJobs();
		return this.vm.snapshot();
	}

	static serialize(snapshot: Snapshot): Uint8Array {
		return QuickJS.serializeSnapshot(snapshot);
	}

	static deserialize(bytes: Uint8Array): Snapshot {
		return QuickJS.deserializeSnapshot(bytes);
	}

	dispose(): void {
		this.vm.dispose();
	}

	/** Run a develop source as the body of a function, so its bindings stay local to this evaluation. */
	develop(source: string, mode: Mode & { kind: "attempt" }): Outcome {
		return this.run(mode, () => {
			this.vm.evalCode(`(() => {\n${source}\n})()`, "develop.js").dispose();
			return undefined;
		});
	}

	/** Evaluate an expression and return its JSON value; a promise is settled by running pending jobs. */
	evaluate(expression: string, mode: Mode): Outcome {
		return this.settle(mode, () => {
			this.vm.evalCode(`__world.evaluate(() => (\n${expression}\n))`, "execute.js").dispose();
		});
	}

	/** Call a definition with JSON arguments. */
	invoke(name: string, args: readonly unknown[], mode: Mode): Outcome {
		return this.settle(mode, () => {
			this.vm
				.evalCode(`__world.invoke(${JSON.stringify(name)}, ${JSON.stringify(JSON.stringify(args))})`, "call.js")
				.dispose();
		});
	}

	catalogue(): readonly CatalogueEntry[] {
		return this.read<CatalogueEntry[]>("__world.catalogue()");
	}

	states(): readonly StateEntry[] {
		return this.read<StateEntry[]>("__world.states()");
	}

	private settle(mode: Mode, start: () => void): Outcome {
		const started = this.run(mode, start);
		if (!started.ok) return started;
		const taken = this.run(mode, () => {
			this.vm.executePendingJobs();
			return this.read<{ status: string; value?: unknown; error?: string }>("__world.take()");
		});
		if (!taken.ok) return taken;
		const box = taken.value as { status: string; value?: unknown; error?: string };
		if (box.status === "ok") return { ok: true, value: box.value ?? null };
		if (box.status === "pending") return { ok: false, failure: "pending", error: "the promise did not settle; awaiting anything but world code is not supported" };
		return { ok: false, failure: "threw", error: box.error ?? "unknown error" };
	}

	private run(mode: Mode, body: () => unknown): Outcome {
		this.enter(mode);
		this.metering = true;
		try {
			const value = body();
			if (this.hostCalls.length > 0) return this.hostCallFailure();
			return { ok: true, value };
		} catch (error) {
			if (this.hostCalls.length > 0) return this.hostCallFailure();
			if (this.ticks <= 0) return { ok: false, failure: "budget", error: `ran out of budget (${this.limits.budget} ticks); is there an endless loop?` };
			return { ok: false, failure: "threw", error: describe(error) };
		} finally {
			this.metering = false;
			this.mode = { kind: "attempt", at: 0, seed: 1 };
		}
	}

	private hostCallFailure(): Outcome {
		return {
			ok: false,
			failure: "host-call",
			error: `a develop must not reach the outside world, but it called ${[...new Set(this.hostCalls)].join(", ")}. Data is for calls; give state(...) an init instead.`,
		};
	}

	private enter(mode: Mode): void {
		this.mode = mode;
		this.ticks = this.limits.budget;
		this.hostCalls = [];
		if (mode.kind === "attempt") {
			this.rng = mulberry32(mode.seed);
			const pinned = BigInt(mode.at) * 1_000_000n;
			this.clockNs = () => pinned;
		} else {
			this.rng = () => crypto.getRandomValues(new Uint32Array(1))[0]! / 2 ** 32;
			this.clockNs = () => BigInt(Date.now()) * 1_000_000n;
		}
	}

	private read<T>(expression: string): T {
		const text = this.vm.evalCode(expression, "host.js").consume((h) => h.toString());
		return JSON.parse(text) as T;
	}

	private options() {
		return {
			wasm: this.wasm,
			memoryLimit: this.limits.memoryBytes,
			timezoneOffset: 0,
			interruptHandler: () => this.metering && --this.ticks < 0,
			wasi: (memory: WebAssembly.Memory) => ({
				clock_time_get: (_id: number, _precision: bigint, out: number) => {
					new DataView(memory.buffer).setBigUint64(out, this.clockNs(), true);
					return 0;
				},
				random_get: (pointer: number, length: number) => {
					new Uint8Array(memory.buffer, pointer, length).fill(7);
					return 0;
				},
			}),
		};
	}

	private readonly hostData = (opHandle: { toString(): string }, keyHandle: { toString(): string }, jsonHandle: { isNull?: boolean; toString(): string }) => {
		const op = opHandle.toString();
		const key = keyHandle.toString();
		if (this.mode.kind !== "live") {
			this.hostCalls.push(`data.${op}`);
			throw new Error(`data.${op} is not available here`);
		}
		const data = this.mode.data;
		const result = (() => {
			switch (op) {
				case "get":
					return data.get(key) ?? null;
				case "set":
					data.set(key, jsonHandle.toString());
					return null;
				case "delete":
					return JSON.stringify(data.delete(key));
				case "list":
					return JSON.stringify(data.list(key));
				default:
					throw new Error(`unknown data operation ${op}`);
			}
		})();
		return result === null ? this.vm.null : this.vm.newString(result);
	};

	private readonly hostRandom = () => this.vm.newNumber(this.rng());
}

function describe(error: unknown): string {
	const e = error as { name?: string; message?: string; stack?: string; dispose?: () => void };
	const text = e?.message !== undefined ? `${e.name ?? "Error"}: ${e.message}${e.stack ? `\n${e.stack}` : ""}` : String(error);
	e?.dispose?.();
	return text.trim();
}

function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
