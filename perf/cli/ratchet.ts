import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { advance, compare, type Baselines } from "../lib/ratchet.ts";
import type { RunRecord } from "../lib/result.ts";
import { PERF } from "./paths.ts";

const BASELINES: string = join(PERF, "baselines.json");

/** Compare results with the best-ever of each metric; answers how many regressed. With `update`, move the pegs to every improvement. */
export function ratchet(records: readonly RunRecord[], update: boolean): number {
	const baselines = load();
	const comparisons = compare(records, baselines);
	for (const c of comparisons.filter((c) => c.regressed || c.improved))
		console.log(`${c.regressed ? "REGRESSED" : c.best === undefined ? "new      " : "improved "} ${c.key}: ${c.measured}${c.best === undefined ? "" : ` (best ${c.best})`}`);
	const regressed = comparisons.filter((c) => c.regressed).length;
	console.log(`ratchet: ${comparisons.length} metrics, ${regressed} regressed`);
	if (update) {
		writeFileSync(BASELINES, `${JSON.stringify(advance(records, baselines), null, "\t")}\n`);
		console.log(`moved ${BASELINES} to every improvement`);
	}
	return regressed;
}

function load(): Baselines {
	try {
		return JSON.parse(readFileSync(BASELINES, "utf8")) as Baselines;
	} catch {
		return {};
	}
}
