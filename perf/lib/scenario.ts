import type { ObjectiveId } from "../objectives.ts";
import type { Api } from "./api.ts";
import type { Fixture } from "./fixtures.ts";
import { runOpenLoop, type Stream, type Window } from "./open-loop.ts";
import { MAX_SEND_LAG_P99_MS, streamRecord, type PhaseRecord, type StreamRecord, type Verdict } from "./result.ts";
import { Operator } from "./operator.ts";
import { Sampler, type Host } from "./sampler.ts";

/** What a scenario is given: the API, its fixture, a way to run load phases, and a place for verdicts and notes. */
export class Context {
	readonly phases: PhaseRecord[] = [];
	readonly verdicts: Verdict[] = [];
	readonly notes: string[] = [];
	/** celld's operator routes, when the target's internal listener is known. */
	readonly operator: Operator | undefined;

	readonly api: Api;
	readonly fixture: Fixture;
	readonly params: Readonly<Record<string, number>>;
	/** The client is on the celld host itself, so latency adds no network. */
	readonly loopback: boolean;
	private readonly host: Host | undefined;
	private readonly log: (line: string) => void;

	constructor(api: Api, fixture: Fixture, params: Readonly<Record<string, number>>, host: Host | undefined, loopback: boolean, log: (line: string) => void) {
		this.api = api;
		this.fixture = fixture;
		this.params = params;
		this.host = host;
		this.loopback = loopback;
		this.log = log;
		this.operator = host?.internal ? new Operator(host) : undefined;
	}

	/** A numeric parameter: `--set name=value` on the command line, or the scenario's default. */
	param(name: string, fallback: number): number {
		return this.params[name] ?? fallback;
	}

	say(line: string): void {
		this.log(line);
	}

	note(line: string): void {
		this.notes.push(line);
		this.log(`note: ${line}`);
	}

	/** Run streams together as one phase, sampling celld throughout. */
	async load(name: string, streams: readonly Stream[], window: Omit<Window, "seed" | "drainS"> & { drainS?: number }): Promise<readonly StreamRecord[]> {
		this.log(`phase ${name}: ${streams.map((s) => `${s.name} @ ${s.rate}/s`).join(", ")} for ${window.durationS} s after ${window.warmupS} s warm-up`);
		const sampler = this.host ? new Sampler(this.host) : undefined;
		sampler?.start();
		const results = await runOpenLoop(streams, { drainS: 30, seed: 1, ...window });
		const samples = sampler?.stop() ?? [];
		const records = results.map(streamRecord);
		this.phases.push({ name, warmupS: window.warmupS, durationS: window.durationS, streams: records, utilization: sampler ? Sampler.summarize(samples) : undefined, samples });
		for (const r of records) {
			const failures = Object.entries(r.failures).map(([k, v]) => `${v}× ${k}`).join(", ");
			this.log(`  ${r.name}: n=${r.ok.count}/${r.intended} p50=${r.ok.p50Ms} p99=${r.ok.p99Ms} p99.9=${r.ok.p999Ms} max=${r.ok.maxMs} ms; service p99=${r.service.p99Ms}; lag p99=${r.sendLag.p99Ms}${failures ? `; failures: ${failures}` : ""}`);
		}
		const u = this.phases.at(-1)!.utilization;
		if (u) this.log(`  celld: cpu mean ${u.cpuMeanPct}% max ${u.cpuMaxPct}%, busiest thread mean ${u.busiestThreadMeanPct}% max ${u.busiestThreadMaxPct}%, rss max ${u.rssMaxMb} MB, capacity waiting max ${u.capacityWaitingMax}`);
		return records;
	}

	/** Judge a stream's successful latencies against an objective's p50 and p99, and its failures against O7. */
	judgeLatency(objective: ObjectiveId, stream: StreamRecord, limits: { p50Ms?: number; p99Ms?: number }): void {
		const invalid = this.invalidity(stream, true);
		if (limits.p50Ms !== undefined) this.verdict({ objective, metric: `${stream.name} p50 ms`, measured: stream.ok.p50Ms, limit: limits.p50Ms, holds: stream.ok.p50Ms <= limits.p50Ms, ...invalid });
		if (limits.p99Ms !== undefined) this.verdict({ objective, metric: `${stream.name} p99 ms`, measured: stream.ok.p99Ms, limit: limits.p99Ms, holds: stream.ok.p99Ms <= limits.p99Ms, ...invalid });
	}

	judgeFailures(objective: ObjectiveId, stream: StreamRecord, max: number): void {
		const failures = stream.intended - stream.ok.count;
		this.verdict({ objective, metric: `${stream.name} failed or timed out`, measured: failures, limit: max, holds: failures <= max, ...this.invalidity(stream, false) });
	}

	verdict(verdict: Verdict): void {
		this.verdicts.push(verdict);
		const mark = verdict.invalid ? "n/a " : verdict.holds ? "PASS" : "FAIL";
		this.log(`  ${mark} ${verdict.objective} ${verdict.metric}: ${verdict.measured} (limit ${verdict.limit})${verdict.invalid ? ` — ${verdict.invalid}` : ""}`);
	}

	private invalidity(stream: StreamRecord, latency: boolean): { invalid?: string } {
		if (stream.intended === 0) return { invalid: "no requests were measured" };
		if (stream.sendLag.p99Ms > MAX_SEND_LAG_P99_MS) return { invalid: `the generator lagged its schedule (send lag p99 ${stream.sendLag.p99Ms} ms)` };
		if (latency && !this.loopback) return { invalid: "the client is not on the celld host, so latency includes the network" };
		return {};
	}
}

export interface Scenario {
	readonly id: string;
	readonly title: string;
	readonly objectives: readonly (ObjectiveId | "correctness")[];
	/** Parameters `--set` may change, with their defaults, so `perf list` can show them. */
	readonly params: Readonly<Record<string, number>>;
	run(ctx: Context): Promise<void>;
}
