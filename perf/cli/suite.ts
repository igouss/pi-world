import { readFileSync } from "node:fs";
import type { RunRecord } from "../lib/result.ts";
import { scenario } from "../scenarios/index.ts";
import { order, SUITES } from "../suites.ts";
import type { Options } from "./args.ts";
import { fail } from "./paths.ts";
import { ratchet } from "./ratchet.ts";
import { runOne } from "./run.ts";
import { target } from "./target.ts";

/** `perf suite`: a suite's steps in dependency order against one target, then the ratchet over what they wrote. */
export async function suite(options: Options): Promise<number> {
	const name = options.names[0] ?? "";
	const chosen = SUITES[name] ?? fail(`no suite ${name}; there are ${Object.keys(SUITES).join(", ")}`);
	const steps = order(chosen);
	const where = await target(options);
	console.log(`suite ${name}: ${chosen.title}; ${steps.map((s) => s.id).join(" → ")} against build ${where.build}`);
	const records: RunRecord[] = [];
	let failed = 0;
	for (const step of steps) {
		const { file, held } = await runOne(scenario(step.scenario), { ...options, set: { ...step.set, ...options.set } }, where);
		records.push(JSON.parse(readFileSync(file, "utf8")) as RunRecord);
		if (!held) failed++;
	}
	console.log(`suite ${name}: ${steps.length - failed} of ${steps.length} steps held every verdict`);
	const regressions = ratchet(records, options.update);
	return failed === 0 && regressions === 0 ? 0 : 1;
}
