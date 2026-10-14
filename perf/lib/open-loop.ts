import { performance } from "node:perf_hooks";
import { Latencies } from "./histogram.ts";

/** What one request came back with. `kind` names a failure, so failures can be told apart in a result. */
export type Reply = { readonly ok: true } | { readonly ok: false; readonly kind: string };

export type Arrivals = "uniform" | "poisson";

/** One stream of requests at a fixed arrival rate, independent of how fast the server answers. */
export interface Stream {
	readonly name: string;
	/** Arrivals per second. */
	readonly rate: number;
	readonly arrivals: Arrivals;
	/** Requests the client keeps open at once; an arrival past it waits on the client, and its latency still counts from its intended start. */
	readonly maxInFlight: number;
	readonly request: (i: number) => Promise<Reply>;
}

export interface Window {
	/** Arrivals before this are sent but not recorded. */
	readonly warmupS: number;
	readonly durationS: number;
	/** How long to wait for outstanding requests after the last arrival; a request still open then counts as timed out. */
	readonly drainS: number;
	readonly seed: number;
}

export interface StreamResult {
	readonly name: string;
	readonly rate: number;
	readonly arrivals: Arrivals;
	readonly intended: number;
	/** Intended start to answer, for answers that succeeded. Safe against coordinated omission. */
	readonly ok: Latencies;
	/** Intended start to answer, for failures and timeouts. */
	readonly failed: Latencies;
	/** Actual send to answer: what a closed-loop tool would report. Kept to show the difference. */
	readonly service: Latencies;
	/** Intended start to actual send: the generator's own lag. Large values mean the client, not the server, fell behind. */
	readonly sendLag: Latencies;
	readonly failures: Readonly<Record<string, number>>;
	readonly maxInFlight: number;
}

interface Pending {
	readonly intendedAt: number;
	readonly recorded: boolean;
	readonly i: number;
}

/**
 * Run streams together, open loop: every request has an intended start fixed in advance by its arrival rate, and its
 * latency is measured from that intended start, so a server that stalls is charged for every request it delayed.
 */
export async function runOpenLoop(streams: readonly Stream[], window: Window): Promise<StreamResult[]> {
	const start = performance.now() + 50;
	const end = start + (window.warmupS + window.durationS) * 1000;
	const recordFrom = start + window.warmupS * 1000;
	const runs = streams.map((stream, index) => new StreamRun(stream, schedule(stream, start, end, window.seed + index), recordFrom));
	await Promise.all(runs.map((run) => run.drive()));
	const deadline = performance.now() + window.drainS * 1000;
	await Promise.race([Promise.all(runs.map((run) => run.settled())), sleepUntil(deadline)]);
	return runs.map((run) => run.result(performance.now()));
}

/** Intended start times, in performance.now() milliseconds. Poisson gaps come from a seeded generator, so a run repeats. */
function schedule(stream: Stream, start: number, end: number, seed: number): number[] {
	const times: number[] = [];
	const gapMs = 1000 / stream.rate;
	const random = mulberry32(seed);
	for (let t = start; t < end; ) {
		times.push(t);
		t += stream.arrivals === "uniform" ? gapMs : -Math.log(1 - random()) * gapMs;
	}
	return times;
}

class StreamRun {
	private readonly ok: Latencies = new Latencies();
	private readonly failed: Latencies = new Latencies();
	private readonly service: Latencies = new Latencies();
	private readonly sendLag: Latencies = new Latencies();
	private readonly failures: Map<string, number> = new Map();
	private readonly open: Set<Pending> = new Set();
	private readonly queued: Pending[] = [];
	private readonly done: Promise<void>[] = [];
	private inFlight: number = 0;
	private maxInFlight: number = 0;
	private intended: number = 0;

	private readonly stream: Stream;
	private readonly times: readonly number[];
	private readonly recordFrom: number;

	constructor(stream: Stream, times: readonly number[], recordFrom: number) {
		this.stream = stream;
		this.times = times;
		this.recordFrom = recordFrom;
	}

	/** Release each arrival at its intended time; the timer wakes at least every millisecond. */
	async drive(): Promise<void> {
		let next = 0;
		while (next < this.times.length) {
			const now = performance.now();
			while (next < this.times.length && this.times[next]! <= now) {
				const intendedAt = this.times[next]!;
				const pending: Pending = { intendedAt, recorded: intendedAt >= this.recordFrom, i: next };
				if (pending.recorded) this.intended++;
				this.open.add(pending);
				this.queued.push(pending);
				next++;
			}
			this.pump();
			const wait = next < this.times.length ? Math.max(0, Math.min(1, this.times[next]! - performance.now())) : 0;
			await sleep(wait);
		}
	}

	settled(): Promise<void> {
		return Promise.all(this.done).then(() => undefined);
	}

	result(now: number): StreamResult {
		for (const pending of this.open) {
			if (!pending.recorded) continue;
			this.failed.recordMs(now - pending.intendedAt);
			this.count("timeout");
		}
		return {
			name: this.stream.name,
			rate: this.stream.rate,
			arrivals: this.stream.arrivals,
			intended: this.intended,
			ok: this.ok,
			failed: this.failed,
			service: this.service,
			sendLag: this.sendLag,
			failures: Object.fromEntries(this.failures),
			maxInFlight: this.maxInFlight,
		};
	}

	private pump(): void {
		while (this.queued.length > 0 && this.inFlight < this.stream.maxInFlight) this.send(this.queued.shift()!);
	}

	private send(pending: Pending): void {
		this.inFlight++;
		this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
		const sentAt = performance.now();
		const settle = (reply: Reply): void => {
			const doneAt = performance.now();
			this.inFlight--;
			this.open.delete(pending);
			if (pending.recorded) {
				this.sendLag.recordMs(sentAt - pending.intendedAt);
				this.service.recordMs(doneAt - sentAt);
				if (reply.ok) this.ok.recordMs(doneAt - pending.intendedAt);
				else {
					this.failed.recordMs(doneAt - pending.intendedAt);
					this.count(reply.kind);
				}
			}
			this.pump();
		};
		this.done.push(
			this.stream.request(pending.i).then(settle, (error: unknown) => settle({ ok: false, kind: `client: ${error instanceof Error ? error.message : String(error)}` })),
		);
	}

	private count(kind: string): void {
		this.failures.set(kind, (this.failures.get(kind) ?? 0) + 1);
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function sleepUntil(at: number): Promise<void> {
	return sleep(Math.max(0, at - performance.now()));
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
