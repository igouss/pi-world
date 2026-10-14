import { readFileSync } from "node:fs";
import { join } from "node:path";
import { formatVerdict, type RunRecord } from "../lib/result.ts";
import { entries, PERF } from "./paths.ts";

/** The result files named, or else the newest result of each scenario under a directory (perf/results by default). */
export function results(args: readonly string[]): RunRecord[] {
	const files = args.filter((a) => a.endsWith(".json"));
	if (files.length > 0) return files.map(load);
	const root = args[0] ?? join(PERF, "results");
	const newest = new Map<string, string>();
	for (const kind of entries(root)) {
		for (const file of entries(join(root, kind)).filter((f) => f.endsWith(".json")).sort()) newest.set(`${kind}/${file.replace(/-\d{8}T.*$/, "")}`, join(root, kind, file));
	}
	return [...newest.values()].map(load);
}

function load(file: string): RunRecord {
	return JSON.parse(readFileSync(file, "utf8")) as RunRecord;
}

/** `perf report`: every verdict and note of the results. */
export function report(args: readonly string[]): number {
	for (const record of results(args)) {
		console.log(`# ${record.scenario} on ${record.target.kind} (${record.target.base}, build ${record.target.build ?? "unknown"}) at ${record.startedAt}, harness ${record.git}`);
		for (const v of record.verdicts) console.log(`  ${formatVerdict(v)}`);
		for (const n of record.notes) console.log(`  note: ${n}`);
	}
	return 0;
}

/** `perf gate`: exit 1 if any valid verdict of the results fails. */
export function gate(args: readonly string[]): number {
	const failing = results(args).flatMap((r) => r.verdicts.filter((v) => !v.invalid && !v.holds).map((v) => ({ r, v })));
	for (const { r, v } of failing) console.log(`${r.target.kind}/${r.scenario} ${formatVerdict(v)}`);
	console.log(failing.length === 0 ? "every valid verdict holds" : `${failing.length} verdicts fail`);
	return failing.length === 0 ? 0 : 1;
}
