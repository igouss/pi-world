import { QuickJS, type Deferred, type Snapshot } from "quickjs-wasi";
import type { DataPort } from "./data-port.ts";
import type { PeerPort } from "./peer-port.ts";
import { PRELUDE, PRELUDE_VERSION } from "./prelude.ts";
import { PRELUDE_UPGRADES } from "./prelude-upgrades.ts";

/**
 * How the VM meets the outside world while code runs.
 * - `attempt`: a develop, a check or a counterexample. The clock is pinned and random is seeded, so the same source
 *   on the same base gives the same heap. Data is unreachable: touching it fails the evaluation as a host call.
 * - `live`: a direct call or an agent `execute`. Real clock, real random, the world's data store and the other worlds.
 */
export type Mode =
	| { readonly kind: "attempt"; readonly at: number; readonly seed: number }
	| { readonly kind: "live"; readonly data: DataPort; readonly peers: PeerPort };

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

export interface VmLimits {
	/** Interrupt-handler ticks one evaluation may use. QuickJS polls about every 0.1 ms of execution. */
	readonly budget: number;
	readonly memoryBytes: number;
}

export const DEFAULT_LIMITS: VmLimits = { budget: 30_000, memoryBytes: 128 * 1024 * 1024 };

const INIT_TIME_NS: bigint = 1_700_000_000_000n * 1_000_000n;

/** How long a live evaluation may wait on other worlds in total. */
const PEER_DEADLINE_MS: number = 30_000;

const HOST_FUNCTIONS: readonly string[] = ["__hostData", "__hostRandom", ...PRELUDE_UPGRADES.flatMap((u) => u.hostFunctions)];

/** A request to another world that world code is awaiting. */
interface PeerRequest {
	readonly deferred: Deferred;
	readonly done: Promise<{ readonly ok: boolean; readonly text: string }>;
}

/**
 * One QuickJS heap with the prelude installed. Each step of an evaluation is synchronous; a live evaluation that
 * awaits another world yields between steps, and its caller holds the world's lock throughout.
 */
export class WorldVm {
	private vm!: QuickJS;
	private mode: Mode = { kind: "attempt", at: 0, seed: 1 };
	private ticks: number = 0;
	private metering: boolean = false;
	private hostCalls: string[] = [];
	private rng: () => number = mulberry32(1);
	private clockNs: () => bigint = () => INIT_TIME_NS;
	private requests: PeerRequest[] = [];

	private constructor(
		private readonly wasm: WebAssembly.Module,
		private readonly limits: VmLimits,
	) {}

	/** A fresh world: the prelude at revision 0, at `prelude` (the newest version unless an older one is asked for). */
	static async create(wasm: WebAssembly.Module, limits: VmLimits = DEFAULT_LIMITS, prelude: number = PRELUDE_VERSION): Promise<WorldVm> {
		const world = new WorldVm(wasm, limits);
		world.vm = await QuickJS.create(world.options());
		world.installHostFunctions(["__hostData", "__hostRandom"]);
		world.vm.evalCode(PRELUDE, "prelude.js").dispose();
		world.upgrade(1, prelude);
		return world;
	}

	/**
	 * Apply the prelude upgrades after version `from`, in order. A heap built by an older prelude needs them before it
	 * can use what they add; the caller records the result as a revision.
	 */
	upgrade(from: number, to: number = PRELUDE_VERSION): void {
		for (const step of PRELUDE_UPGRADES.filter((u) => u.version > from && u.version <= to)) {
			this.installHostFunctions(step.hostFunctions);
			this.vm.evalCode(step.source, `prelude-${step.version}.js`).dispose();
		}
	}

	static readonly preludeVersion: number = PRELUDE_VERSION;

	/** A restored heap already has every host callback registered by name; a new function of that name replaces it. */
	private installHostFunctions(names: readonly string[]): void {
		for (const name of names) {
			this.vm.unregisterHostCallback(name);
			this.vm.newFunction(name, this.hostFunction(name)).consume((h) => this.vm.setProp(this.vm.global, name, h));
		}
	}

	private hostFunction(name: string) {
		const functions: Record<string, (...args: never[]) => unknown> = { __hostData: this.hostData, __hostRandom: this.hostRandom, __hostPeer: this.hostPeer };
		const fn = functions[name];
		if (!fn) throw new Error(`no host function ${name}`);
		return fn as Parameters<QuickJS["newFunction"]>[1];
	}

	static async fromBytes(bytes: Uint8Array, wasm: WebAssembly.Module, limits: VmLimits = DEFAULT_LIMITS): Promise<WorldVm> {
		return WorldVm.fromSnapshot(QuickJS.deserializeSnapshot(bytes), wasm, limits);
	}

	static async fromSnapshot(snapshot: Snapshot, wasm: WebAssembly.Module, limits: VmLimits = DEFAULT_LIMITS): Promise<WorldVm> {
		const world = new WorldVm(wasm, limits);
		world.vm = await world.load(snapshot);
		return world;
	}

	/** Replace this heap with `snapshot`, in place, so holders of this object keep a valid VM. */
	async reset(snapshot: Snapshot): Promise<void> {
		const next = await this.load(snapshot);
		this.vm.dispose();
		this.vm = next;
	}

	private async load(snapshot: Snapshot): Promise<QuickJS> {
		const vm = await QuickJS.restore(snapshot, this.options());
		for (const name of HOST_FUNCTIONS) vm.registerHostCallback(name, this.hostFunction(name));
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
	evaluate(expression: string, mode: Mode): Promise<Outcome> {
		return this.settle(mode, () => {
			this.vm.evalCode(`__world.evaluate(() => (\n${expression}\n))`, "execute.js").dispose();
		});
	}

	/** Call a definition with JSON arguments. */
	invoke(name: string, args: readonly unknown[], mode: Mode): Promise<Outcome> {
		return this.settle(mode, () => {
			this.vm
				.evalCode(`__world.invoke(${JSON.stringify(name)}, ${JSON.stringify(JSON.stringify(args))})`, "call.js")
				.dispose();
		});
	}

	catalogue(): readonly CatalogueEntry[] {
		return this.read<CatalogueEntry[]>("__world.catalogue()");
	}

	/**
	 * Start an evaluation, then run its jobs until it settles. While world code awaits other worlds, wait for their
	 * answers, hand them to the waiting promises and run the jobs again, until nothing is outstanding or the deadline
	 * passes.
	 */
	private async settle(mode: Mode, start: () => void): Promise<Outcome> {
		this.requests = [];
		const started = this.run(mode, start);
		if (!started.ok) return started;
		const deadline = Date.now() + PEER_DEADLINE_MS;
		for (;;) {
			const stepped = this.run(mode, () => this.vm.executePendingJobs());
			if (!stepped.ok) return stepped;
			if (this.requests.length === 0) break;
			const outstanding = this.requests;
			this.requests = [];
			const answers = await Promise.race([
				Promise.all(outstanding.map((request) => request.done)),
				new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), Math.max(0, deadline - Date.now()))),
			]);
			if (!answers) return { ok: false, failure: "pending", error: `other worlds did not answer within ${PEER_DEADLINE_MS / 1000} s` };
			outstanding.forEach((request, i) => {
				const answer = answers[i]!;
				this.vm.newString(answer.text).consume((h) => (answer.ok ? request.deferred.resolve(h) : request.deferred.reject(h)));
			});
		}
		const taken = this.run(mode, () => this.read<{ status: string; value?: unknown; error?: string }>("__world.take()"));
		if (!taken.ok) return taken;
		const box = taken.value as { status: string; value?: unknown; error?: string };
		if (box.status === "ok") return { ok: true, value: box.value ?? null };
		if (box.status === "pending") return { ok: false, failure: "pending", error: "the promise did not settle; world code can await only world code and other worlds" };
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
			error: `a develop must not reach the outside world, but it called ${[...new Set(this.hostCalls)].join(", ")}. Data and other worlds are for calls; give state(...) an init instead.`,
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

	/** `worlds.call/list/functions`: answers a promise that `settle` resolves once the other world replies. */
	private readonly hostPeer = (
		opHandle: { toString(): string },
		idHandle: { toString(): string },
		nameHandle: { toString(): string },
		argsHandle: { toString(): string },
	) => {
		const op = opHandle.toString();
		if (this.mode.kind !== "live") {
			this.hostCalls.push(`worlds.${op}`);
			throw new Error(`worlds.${op} is not available here`);
		}
		const peers = this.mode.peers;
		const id = idHandle.toString();
		const name = nameHandle.toString();
		const args = JSON.parse(argsHandle.toString()) as unknown[];
		const answer = async (): Promise<unknown> => {
			if (op === "list") return peers.list();
			if (op === "functions") return (await peers.functions(id)).map(({ name, kind, doc, params }) => ({ name, kind, doc, params }));
			if (op !== "call") throw new Error(`unknown worlds operation ${op}`);
			const outcome = await peers.call(id, name, args);
			if (!outcome.ok) throw new Error(`${id}.${name}: ${outcome.error.split("\n")[0]}`);
			return outcome.value;
		};
		const deferred = this.vm.newPromise();
		const done = answer().then(
			(value) => ({ ok: true, text: JSON.stringify(value ?? null) }),
			(error: unknown) => ({ ok: false, text: error instanceof Error ? error.message : String(error) }),
		);
		this.requests.push({ deferred, done });
		return deferred.handle;
	};
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
