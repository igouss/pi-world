import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { Fixture } from "../lib/fixtures.ts";
import type { RunRecord } from "../lib/result.ts";
import { Context, type Scenario } from "../lib/scenario.ts";
import { scenario } from "../scenarios/index.ts";
import type { Options } from "./args.ts";
import { fail, fileStamp, REPO } from "./paths.ts";
import { target, type Target } from "./target.ts";

/** `perf run`: the scenarios named, one after another, against one target. */
export async function run(options: Options): Promise<number> {
	if (options.names.length === 0) fail("name at least one scenario; perf list shows them");
	const chosen = options.names.map(scenario);
	const where = await target(options);
	console.log(`target build ${where.build}`);
	let failed = 0;
	for (const s of chosen) failed += (await runOne(s, options, where)).held ? 0 : 1;
	return failed === 0 ? 0 : 1;
}

/** Run one scenario on its own fixture worlds and write its result file; answers the file and whether every valid verdict held. */
export async function runOne(chosen: Scenario, options: Options, where: Target): Promise<{ file: string; held: boolean }> {
	const startedAt = new Date();
	const fixture = new Fixture(where.api, `loadtest-${chosen.id}-${Date.now().toString(36)}`);
	const params = { ...chosen.params, ...options.set };
	const ctx = new Context(where.api, fixture, params, where.host, where.loopback, (line) => console.log(line));
	console.log(`# ${chosen.id}: ${chosen.title} against ${where.api.base} (${where.kind}${where.loopback ? ", loopback" : ""})`);
	let error: unknown;
	try {
		await chosen.run(ctx);
	} catch (e) {
		error = e;
		ctx.note(`the scenario stopped: ${e instanceof Error ? e.message : String(e)}`);
	} finally {
		if (!options.keep) await fixture.forget().catch((e: unknown) => ctx.note(`forgetting the fixture's worlds failed: ${String(e)}`));
	}
	const record: RunRecord = {
		scenario: chosen.id,
		title: chosen.title,
		target: { base: where.api.base, kind: where.kind, loopback: where.loopback, build: where.build },
		startedAt: startedAt.toISOString(),
		git: git(),
		host: hostname(),
		approval: options.approval,
		params,
		phases: ctx.phases,
		verdicts: ctx.verdicts,
		notes: ctx.notes,
	};
	const dir = join(options.out, where.kind);
	mkdirSync(dir, { recursive: true });
	const file = join(dir, `${chosen.id}-${fileStamp(startedAt)}.json`);
	writeFileSync(file, `${JSON.stringify(record, null, "\t")}\n`);
	console.log(`wrote ${file}`);
	return { file, held: error === undefined && ctx.verdicts.every((v) => v.invalid !== undefined || v.holds) };
}

/** The harness's own revision; in the node's container, which has no git, the one `perf remote` passed in. */
export function git(): string {
	if (process.env.PERF_GIT) return process.env.PERF_GIT;
	try {
		return execFileSync("git", ["-C", REPO, "describe", "--always", "--dirty"], { encoding: "utf8" }).trim();
	} catch {
		return "unknown";
	}
}
