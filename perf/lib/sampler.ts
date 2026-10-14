import { spawn, type ChildProcess } from "node:child_process";

/** Where the celld process runs: this machine, or a host reached over ssh. */
export interface Host {
	/** `undefined` for this machine. */
	readonly ssh: string | undefined;
	/** An extended regular expression, anchored, that matches the celld server's command line (not `celld dev`'s supervisor, nor the sampler's own grep). */
	readonly process: string;
	/** The internal listener, whose `/state` reports cells, isolates and admission queues. */
	readonly internal: string | undefined;
	/** Run commands through `sudo -n` on the host (the node's celld runs as another user in a container). */
	readonly sudo: boolean;
}

export interface Sample {
	readonly at: number;
	/** CPU of the whole process, in percent of one core. */
	readonly cpuPct: number;
	/** The busiest threads, in percent of one core: a JavaScript isolate runs on one thread at a time, so a thread near 100 % is a saturated isolate. */
	readonly topThreadsPct: readonly number[];
	readonly rssMb: number;
	readonly state: StateSample | undefined;
}

/** The fields of celld's `/state` that say whether cells or isolates are queueing. */
export interface StateSample {
	readonly residentCells: number;
	readonly capacityWaiting: number;
	readonly activationWaiting: number;
	readonly restoring: number;
	readonly cellIsolates: number;
	readonly cellIsolateHeapMb: number;
	readonly shedding: unknown;
}

export interface Utilization {
	readonly samples: number;
	readonly cpuMeanPct: number;
	readonly cpuMaxPct: number;
	readonly busiestThreadMeanPct: number;
	readonly busiestThreadMaxPct: number;
	readonly rssMaxMb: number;
	readonly capacityWaitingMax: number;
	readonly activationWaitingMax: number;
	readonly cellIsolatesMax: number;
}

const CLOCK_TICKS: number = 100;

/**
 * Samples celld once a second while a run goes: CPU per thread and in total, resident memory, and `/state`. The
 * sampling loop is a shell loop on the host, so the same code reads this machine and the node.
 */
export class Sampler {
	private child: ChildProcess | undefined;
	private buffer: string = "";
	private readonly samples: Sample[] = [];
	private previous: { at: number; total: number; threads: Map<string, number> } | undefined;

	private readonly host: Host;

	constructor(host: Host) {
		this.host = host;
	}

	start(): void {
		const sudo = this.host.sudo ? "sudo -n " : "";
		const url = `http://${this.host.internal}/state`;
		const state = this.host.internal
			? `if command -v curl >/dev/null; then ${sudo}curl -s -m 1 ${url}; else node -e 'fetch("${url}").then(r => r.text()).then(t => process.stdout.write(t), () => {})'; fi | tr -d '\\n'`
			: "echo";
		// Only POSIX sh, awk and /proc, so the loop runs on a host with no procps, such as a node container with --pid host.
		const script = [
			`pid=""; for d in /proc/[0-9]*; do if ${sudo}tr '\\0' ' ' < $d/cmdline 2>/dev/null | grep -qE -- ${JSON.stringify(this.host.process)}; then pid=\${d#/proc/}; break; fi; done`,
			`[ -n "$pid" ] || { echo "no process matches ${this.host.process}" >&2; exit 1; }`,
			"while :; do",
			`  echo "S $(date +%s%3N) $(${sudo}awk '/VmRSS/{print $2}' /proc/$pid/status)"`,
			`  ${sudo}awk '{print "T", $1, $14+$15}' /proc/$pid/task/*/stat 2>/dev/null`,
			`  echo "J $(${state})"`,
			"  echo E",
			"  sleep 1",
			"done",
		].join("\n");
		this.child = this.host.ssh ? spawn("ssh", ["-o", "BatchMode=yes", this.host.ssh, "sh", "-s"], { stdio: ["pipe", "pipe", "inherit"] }) : spawn("sh", ["-s"], { stdio: ["pipe", "pipe", "inherit"] });
		this.child.stdin!.end(script);
		this.child.stdout!.setEncoding("utf8");
		this.child.stdout!.on("data", (chunk: string) => this.read(chunk));
	}

	stop(): readonly Sample[] {
		this.child?.kill();
		return this.samples;
	}

	static summarize(samples: readonly Sample[]): Utilization {
		const mean = (values: number[]): number => (values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length);
		const max = (values: number[]): number => values.reduce((a, b) => Math.max(a, b), 0);
		const busiest = samples.map((s) => s.topThreadsPct[0] ?? 0);
		return {
			samples: samples.length,
			cpuMeanPct: round(mean(samples.map((s) => s.cpuPct))),
			cpuMaxPct: round(max(samples.map((s) => s.cpuPct))),
			busiestThreadMeanPct: round(mean(busiest)),
			busiestThreadMaxPct: round(max(busiest)),
			rssMaxMb: round(max(samples.map((s) => s.rssMb))),
			capacityWaitingMax: max(samples.map((s) => s.state?.capacityWaiting ?? 0)),
			activationWaitingMax: max(samples.map((s) => s.state?.activationWaiting ?? 0)),
			cellIsolatesMax: max(samples.map((s) => s.state?.cellIsolates ?? 0)),
		};
	}

	private read(chunk: string): void {
		this.buffer += chunk;
		for (;;) {
			const end = this.buffer.indexOf("\nE\n");
			if (end < 0) return;
			const block = this.buffer.slice(0, end);
			this.buffer = this.buffer.slice(end + 3);
			this.parse(block.split("\n"));
		}
	}

	private parse(lines: readonly string[]): void {
		let at = 0;
		let rssKb = 0;
		let state: StateSample | undefined;
		const threads = new Map<string, number>();
		for (const line of lines) {
			const [tag, ...rest] = line.split(" ");
			if (tag === "S") {
				at = Number(rest[0]);
				rssKb = Number(rest[1]);
			} else if (tag === "T") threads.set(rest[0]!, Number(rest[1]));
			else if (tag === "J") state = parseState(rest.join(" "));
		}
		const total = [...threads.values()].reduce((a, b) => a + b, 0);
		const previous = this.previous;
		this.previous = { at, total, threads };
		if (!previous || at <= previous.at) return;
		const seconds = (at - previous.at) / 1000;
		const pct = (ticks: number): number => round((ticks / CLOCK_TICKS / seconds) * 100);
		const perThread = [...threads].map(([tid, ticks]) => pct(ticks - (previous.threads.get(tid) ?? ticks))).sort((a, b) => b - a);
		this.samples.push({ at, cpuPct: pct(total - previous.total), topThreadsPct: perThread.slice(0, 4), rssMb: round(rssKb / 1024), state });
	}
}

function parseState(text: string): StateSample | undefined {
	try {
		const s = JSON.parse(text) as {
			residents?: unknown[];
			capacity_waiting?: number;
			activation_waiting?: number;
			restoring?: number;
			shedding?: unknown;
			deployment?: { isolates?: { cells?: Record<string, { live?: number; heap_bytes?: number }> } };
		};
		const cells = Object.values(s.deployment?.isolates?.cells ?? {});
		return {
			residentCells: s.residents?.length ?? 0,
			capacityWaiting: s.capacity_waiting ?? 0,
			activationWaiting: s.activation_waiting ?? 0,
			restoring: s.restoring ?? 0,
			cellIsolates: cells.reduce((n, c) => n + (c.live ?? 0), 0),
			cellIsolateHeapMb: round(cells.reduce((n, c) => n + (c.heap_bytes ?? 0), 0) / 1048576),
			shedding: s.shedding,
		};
	} catch {
		return undefined;
	}
}

function round(n: number): number {
	return Math.round(n * 10) / 10;
}
