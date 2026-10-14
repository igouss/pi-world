import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { fold, type Profile } from "../lib/fold.ts";
import { scenario } from "../scenarios/index.ts";
import type { Options } from "./args.ts";
import { startDev } from "./dev-server.ts";
import { fail, fileStamp, PERF, REPO } from "./paths.ts";
import { runOne } from "./run.ts";
import { devServerPid, target } from "./target.ts";

/** V8's flags for a profile: a perf map names JavaScript and WebAssembly frames, interpreted frames included. */
const V8_FLAGS: string = "--perf-basic-prof --interpreted-frames-native-stack";

/**
 * `perf profile`: run a scenario on a clean celld dev started from a celld that reads CELLD_V8_FLAGS, record celld's
 * server with Linux perf from `delay` seconds in, for `seconds`, and attribute the samples by layer. Writes the folded
 * stacks (gzipped), a flame graph and a summary under perf/profiles.
 */
export async function profile(options: Options): Promise<number> {
	const celld = options.celld ?? fail("perf profile needs --celld PATH, a celld that reads CELLD_V8_FLAGS");
	const chosen = scenario(options.names[0] ?? "");
	if (!(await startDev(celld, { CELLD_V8_FLAGS: V8_FLAGS }))) return 1;
	const server = devServerPid() ?? fail("celld dev's server process is not running");
	const dir = join(PERF, "profiles");
	mkdirSync(dir, { recursive: true });
	const data = join(dir, `${chosen.id}-${fileStamp(new Date())}.perf.data`);
	const recorded = new Promise<void>((done) =>
		setTimeout(() => {
			console.log(`perf record of pid ${server} for ${options.seconds} s`);
			spawn("perf", ["record", "-F", "499", "-g", "-p", server, "-o", data, "--", "sleep", String(options.seconds)], { stdio: "inherit" }).on("exit", () => done());
		}, options.delay * 1000),
	);
	const { held } = await runOne(chosen, options, await target({ ...options, target: "dev" }));
	await recorded;
	const profiled = fold(execFileSync("perf", ["script", "-i", data], { encoding: "utf8", maxBuffer: 1 << 30 }));
	// V8's profiling flags also write a log per isolate into the working directory; the perf map is what is needed.
	for (const file of readdirSync(REPO).filter((f) => /^isolate-0x[0-9a-f]+-\d+-v8\.log$/.test(f))) rmSync(join(REPO, file));
	write(data, chosen.id, profiled);
	print(profiled);
	return held ? 0 : 1;
}

function write(data: string, title: string, profiled: Profile): void {
	const base = data.replace(/\.perf\.data$/, "");
	writeFileSync(`${base}.folded.gz`, gzipSync(`${profiled.folded}\n`, { level: 9 }));
	try {
		writeFileSync(`${base}.svg`, execFileSync("flamegraph.pl", ["--title", `${title}: celld dev`], { input: profiled.folded, encoding: "utf8", maxBuffer: 1 << 28 }));
	} catch {
		console.log("flamegraph.pl is not installed; the folded stacks are written");
	}
	const { folded: _, ...summary } = profiled;
	writeFileSync(`${base}.json`, `${JSON.stringify(summary, null, "\t")}\n`);
}

function print(profiled: Profile): void {
	const pct = (n: number): string => `${((n / profiled.samples) * 100).toFixed(1)}%`;
	console.log(`${profiled.samples} samples`);
	console.log(`by layer (leaf): ${Object.entries(profiled.selfByLayer).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${pct(v)}`).join(", ")}`);
	for (const [title, ranked] of [["inclusive", profiled.topInclusive], ["self", profiled.topSelf]] as const) {
		console.log(`top functions, ${title}:`);
		for (const f of ranked.slice(0, 20)) console.log(`  ${pct(f.samples).padStart(6)}  ${f.layer.padEnd(13)} ${f.frame.slice(0, 120)}`);
	}
}
