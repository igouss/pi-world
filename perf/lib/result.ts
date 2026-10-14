import type { ObjectiveId } from "../objectives.ts";
import type { Percentiles } from "./histogram.ts";
import type { StreamResult } from "./open-loop.ts";
import type { Sample, Utilization } from "./sampler.ts";

/** One stream of one phase, as a result file keeps it: percentiles to read, encoded histograms to re-analyse. */
export interface StreamRecord {
	readonly name: string;
	readonly rate: number;
	readonly arrivals: string;
	readonly intended: number;
	readonly ok: Percentiles;
	readonly failed: Percentiles;
	readonly service: Percentiles;
	readonly sendLag: Percentiles;
	readonly failures: Readonly<Record<string, number>>;
	readonly maxInFlight: number;
	readonly histograms: { readonly ok: string; readonly failed: string; readonly service: string };
}

export interface PhaseRecord {
	readonly name: string;
	readonly warmupS: number;
	readonly durationS: number;
	readonly streams: readonly StreamRecord[];
	readonly utilization: Utilization | undefined;
	readonly samples: readonly Sample[];
	/** The client host's 1-minute load average at the start and end of the phase, and its cores. */
	readonly clientLoad: { readonly start: number; readonly end: number; readonly cores: number };
}

/** A judgement of one objective: what was measured, the limit, and whether it held. `undefined` limits are notes. */
export interface Verdict {
	readonly objective: ObjectiveId | "correctness";
	readonly metric: string;
	readonly measured: number;
	readonly limit: number;
	readonly holds: boolean;
	/** Why the verdict cannot judge (the target adds network, the generator fell behind): the verdict is reported, not counted. */
	readonly invalid?: string;
}

export interface RunRecord {
	readonly scenario: string;
	readonly title: string;
	readonly target: { readonly base: string; readonly kind: "dev" | "node" | "other"; readonly loopback: boolean };
	readonly startedAt: string;
	readonly git: string;
	readonly host: string;
	/** For a run against the operator's node: the approval it ran under, verbatim. */
	readonly approval: string | undefined;
	readonly params: Readonly<Record<string, unknown>>;
	readonly phases: readonly PhaseRecord[];
	readonly verdicts: readonly Verdict[];
	readonly notes: readonly string[];
}

export function streamRecord(result: StreamResult): StreamRecord {
	return {
		name: result.name,
		rate: result.rate,
		arrivals: result.arrivals,
		intended: result.intended,
		ok: result.ok.percentiles(),
		failed: result.failed.percentiles(),
		service: result.service.percentiles(),
		sendLag: result.sendLag.percentiles(),
		failures: result.failures,
		maxInFlight: result.maxInFlight,
		histograms: { ok: result.ok.encode(), failed: result.failed.encode(), service: result.service.encode() },
	};
}

/** The generator lagged its own schedule: its p99 send lag above this means the client, not the server, limited the run. */
export const MAX_SEND_LAG_P99_MS: number = 5;
