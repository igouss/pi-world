#!/usr/bin/env node
/**
 * pi-world's performance harness. `perf help` lists the commands; perf/README.md says how to use them.
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { gzipSync } from "node:zlib";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Api } from "../lib/api.ts";
import { Fixture } from "../lib/fixtures.ts";
import { fold } from "../lib/fold.ts";
import { advance, compare, type Baselines } from "../lib/ratchet.ts";
import { order, SUITES } from "../suites.ts";
import type { RunRecord, Verdict } from "../lib/result.ts";
import type { Host } from "../lib/sampler.ts";
import { Context, type Scenario } from "../lib/scenario.ts";
import { SCENARIOS } from "../scenarios/index.ts";

const PERF: string = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO: string = resolve(PERF, "..");
const DEV_PORT: number = 8791;

/** The deployed node, as perf/README.md describes it. */
const NODE = { ssh: "oracle-arm", base: "http://127.0.0.1:8787", internal: "127.0.0.1:8788", process: "^[^ ]*celld --bucket" } as const;

interface Options {
	readonly target: string;
	readonly set: Record<string, number>;
	readonly approval: string | undefined;
	readonly keep: boolean;
	readonly internal: string | undefined;
	readonly out: string;
}

async function main(argv: readonly string[]): Promise<number> {
	const [command, ...rest] = argv;
	switch (command) {
		case "list":
			for (const s of SCENARIOS) console.log(`${s.id.padEnd(12)} ${s.objectives.join(",").padEnd(16)} ${s.title}  [${Object.entries(s.params).map(([k, v]) => `${k}=${v}`).join(" ")}]`);
			return 0;
		case "run":
			return run(rest);
		case "dev":
			return dev(rest[0] ?? "up", rest.slice(1));
		case "report":
			return report(rest);
		case "gate":
			return gate(rest);
		case "remote":
			return remote(rest);
		case "profile":
			return profile(rest);
		case "suite":
			return suite(rest);
		case "ratchet":
			return ratchet(rest) === 0 ? 0 : 1;
		default:
			console.log(`usage:
  perf list                                   scenarios, their objectives and parameters
  perf dev up [--env NAME=VALUE]... | down    start (clean) or stop celld dev on port ${DEV_PORT}
  perf run <scenario>... [--target dev|node|URL] [--set name=value]... [--approval TEXT] [--keep] [--internal HOST:PORT]
                                              run scenarios; a run against the node needs --approval with the operator's words
  perf report [results.json...]               print the verdicts of result files (default: the newest of each scenario)
  perf gate [dir]                             exit 1 if any valid verdict in the newest results fails
  perf suite <name> [--target ...] [--approval TEXT]
                                              run a suite's scenario graph in dependency order, then gate and ratchet it
                                              (suites: ${Object.keys(SUITES).join(", ")})
  perf ratchet [--update] [results.json...]   compare the newest results with the best-ever of each metric (perf/baselines.json);
                                              exit 1 on a regression; --update moves the baselines to every improvement
  perf profile <scenario> --celld PATH [--seconds N] [--delay N] [--set ...]
                                              run a scenario on a clean celld dev started from PATH (a celld built to read
                                              CELLD_V8_FLAGS), record it with Linux perf, and attribute the samples by layer
  perf remote run <scenario>... --approval TEXT [--set ...]
                                              copy the harness to the node and run it there, on loopback, in a node container;
                                              its result files are copied back to perf/results/node/`);
			return command === "help" ? 0 : 2;
	}
}

function parse(args: readonly string[]): { names: string[]; options: Options } {
	const names: string[] = [];
	const set: Record<string, number> = {};
	let target = "dev";
	let approval: string | undefined;
	let keep = false;
	let internal: string | undefined;
	let out = join(PERF, "results");
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		const value = (): string => {
			const v = args[++i];
			if (v === undefined) throw new Error(`${arg} needs a value`);
			return v;
		};
		if (arg === "--target") target = value();
		else if (arg === "--approval") approval = value();
		else if (arg === "--keep") keep = true;
		else if (arg === "--internal") internal = value();
		else if (arg === "--out") out = value();
		else if (arg === "--set") {
			const [k, v] = value().split("=");
			if (!k || v === undefined || Number.isNaN(Number(v))) throw new Error(`--set needs name=number, not ${args[i]}`);
			set[k] = Number(v);
		} else names.push(arg);
	}
	return { names, options: { target, set, approval, keep, internal, out } };
}

/** Where a target is, and how to sample it. The node is reached through ssh; its client must run on the node to be loopback. */
function resolveTarget(options: Options): { api: Api; host: Host | undefined; kind: RunRecord["target"]["kind"]; loopback: boolean } {
	if (options.target === "dev") {
		const internal = options.internal ?? devInternal();
		return { api: new Api(`http://127.0.0.1:${DEV_PORT}`), host: { ssh: undefined, process: "^[^ ]*celld --no-control-plane", internal, sudo: false }, kind: "dev", loopback: true };
	}
	if (options.target === "node") {
		if (!options.approval) throw new Error("a run against the operator's node needs --approval with the operator's words approving it (pw-djz, Operator decision)");
		const onNode = hostname() === NODE.ssh;
		return {
			api: new Api(onNode ? NODE.base : `http://${NODE.ssh}.mist-walleye.ts.net:8787`),
			// In the remote container (root, --pid host) /proc is readable without sudo; as the node's login user it needs sudo.
			host: { ssh: onNode ? undefined : NODE.ssh, process: NODE.process, internal: options.internal ?? NODE.internal, sudo: process.getuid?.() !== 0 },
			kind: "node",
			loopback: onNode,
		};
	}
	const local = /^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(options.target);
	return { api: new Api(options.target.replace(/\/$/, "")), host: undefined, kind: "other", loopback: local };
}

/** celld dev's internal listener: the server process's other listening port. */
function devInternal(): string | undefined {
	try {
		const pid = execFileSync("pgrep", ["-f", "celld --no-control-plane"], { encoding: "utf8" }).trim().split("\n")[0];
		const lines = execFileSync("ss", ["-ltnpH"], { encoding: "utf8" }).split("\n").filter((l) => l.includes(`pid=${pid},`));
		const port = lines.map((l) => l.split(/\s+/)[3]!).find((a) => !a.endsWith(`:${DEV_PORT}`));
		return port;
	} catch {
		return undefined;
	}
}

async function run(args: readonly string[]): Promise<number> {
	const { names, options } = parse(args);
	const chosen = names.length === 0 ? [] : names.map((n) => SCENARIOS.find((s) => s.id === n) ?? fail(`no scenario ${n}; perf list shows them`));
	if (chosen.length === 0) throw new Error("name at least one scenario; perf list shows them");
	const target = resolveTarget(options);
	const version = await target.api.send<{ build?: string }>("GET", "/api/version").catch((e: unknown) => fail(`${target.api.base} does not answer (${e instanceof Error ? e.message : String(e)}); nothing was run`));
	if (version.status !== 200) fail(`${target.api.base}/api/version answered ${version.status}; nothing was run`);
	console.log(`target build ${version.body.build ?? "unknown"}`);
	let failed = 0;
	for (const scenario of chosen) failed += (await runOne(scenario, options, target)) ? 0 : 1;
	return failed === 0 ? 0 : 1;
}

async function runOne(scenario: Scenario, options: Options, target: ReturnType<typeof resolveTarget>): Promise<boolean> {
	const startedAt = new Date().toISOString();
	const prefix = `loadtest-${scenario.id}-${Date.now().toString(36)}`;
	const fixture = new Fixture(target.api, prefix);
	const params = { ...scenario.params, ...options.set };
	const ctx = new Context(target.api, fixture, params, target.host, target.loopback, (line) => console.log(line));
	console.log(`# ${scenario.id}: ${scenario.title} against ${target.api.base} (${target.kind}${target.loopback ? ", loopback" : ""})`);
	let error: unknown;
	try {
		await scenario.run(ctx);
	} catch (e) {
		error = e;
		ctx.note(`the scenario stopped: ${e instanceof Error ? e.message : String(e)}`);
	} finally {
		if (!options.keep) await fixture.forget().catch((e: unknown) => ctx.note(`forgetting the fixture's worlds failed: ${String(e)}`));
	}
	const record: RunRecord = {
		scenario: scenario.id,
		title: scenario.title,
		target: { base: target.api.base, kind: target.kind, loopback: target.loopback },
		startedAt,
		git: git(),
		host: hostname(),
		approval: options.approval,
		params,
		phases: ctx.phases,
		verdicts: ctx.verdicts,
		notes: ctx.notes,
	};
	const dir = join(options.out, target.kind);
	mkdirSync(dir, { recursive: true });
	const file = join(dir, `${scenario.id}-${startedAt.replaceAll(":", "").replace(/\.\d+Z$/, "Z")}.json`);
	writeFileSync(file, `${JSON.stringify(record, null, "\t")}\n`);
	console.log(`wrote ${file}`);
	return error === undefined && ctx.verdicts.every((v) => v.invalid !== undefined || v.holds);
}

function git(): string {
	try {
		return execFileSync("git", ["-C", REPO, "describe", "--always", "--dirty"], { encoding: "utf8" }).trim();
	} catch {
		return "unknown";
	}
}

/** Start or stop celld dev; `up` takes `--env NAME=VALUE` settings for celld, such as CELLD_IDLE_EVICT_S=5. */
async function dev(action: string, args: readonly string[] = []): Promise<number> {
	const env: Record<string, string> = {};
	for (let i = 0; i < args.length; i++) {
		if (args[i] !== "--env") throw new Error(`perf dev ${action}: unknown argument ${args[i]}`);
		const [name, ...value] = (args[++i] ?? "").split("=");
		if (!name || value.length === 0) throw new Error("--env needs NAME=VALUE");
		env[name] = value.join("=");
	}
	if (action === "down") {
		let pids: string[] = [];
		try {
			pids = execFileSync("pgrep", ["-x", "celld"], { encoding: "utf8" }).split("\n").filter(Boolean);
		} catch {
			// pgrep exits 1 when nothing runs
		}
		for (const pid of pids) process.kill(Number(pid));
		return 0;
	}
	execFileSync("npm", ["run", "build"], { cwd: REPO, stdio: "inherit" });
	const child = spawn("celld", ["dev", ".", "--port", String(DEV_PORT), "--no-watch", "--clean"], { cwd: REPO, detached: true, stdio: "ignore", env: { ...process.env, ...env } });
	child.unref();
	const api = new Api(`http://127.0.0.1:${DEV_PORT}`);
	for (let i = 0; i < 120; i++) {
		try {
			if ((await api.send("GET", "/api/version")).status === 200) {
				console.log(`celld dev is up on ${DEV_PORT}; internal listener ${devInternal() ?? "unknown"}`);
				return 0;
			}
		} catch {
			// not up yet
		}
		await new Promise((r) => setTimeout(r, 500));
	}
	console.error("celld dev did not come up within 60 s");
	return 1;
}

/**
 * Profile a scenario. V8 writes /tmp/perf-<pid>.map for its JavaScript and WebAssembly code, so `perf script` names
 * QuickJS's functions and pi-world's, beside celld's own symbols (the build keeps them, with frame pointers).
 */
async function profile(args: readonly string[]): Promise<number> {
	const flag = (name: string, fallback?: string): string | undefined => {
		const i = args.indexOf(name);
		return i >= 0 ? args[i + 1] : fallback;
	};
	const celld = flag("--celld") ?? fail("perf profile needs --celld PATH, a celld that reads CELLD_V8_FLAGS");
	const seconds = Number(flag("--seconds", "20"));
	const delay = Number(flag("--delay", "8"));
	const rest = args.filter((a, i) => !["--celld", "--seconds", "--delay"].includes(a) && !["--celld", "--seconds", "--delay"].includes(args[i - 1] ?? ""));
	const { names, options } = parse(rest);
	const scenario = SCENARIOS.find((s) => s.id === names[0]) ?? fail(`no scenario ${names[0]}`);
	await dev("down");
	execFileSync("npm", ["run", "build"], { cwd: REPO, stdio: "inherit" });
	await new Promise((r) => setTimeout(r, 2000));
	const child = spawn(celld, ["dev", ".", "--port", String(DEV_PORT), "--no-watch", "--clean"], {
		cwd: REPO,
		detached: true,
		stdio: "ignore",
		env: { ...process.env, CELLD_V8_FLAGS: "--perf-basic-prof --interpreted-frames-native-stack" },
	});
	child.unref();
	const api = new Api(`http://127.0.0.1:${DEV_PORT}`);
	for (let i = 0; i < 120 && !(await api.send("GET", "/api/version").then((a) => a.status === 200, () => false)); i++) await new Promise((r) => setTimeout(r, 500));
	const server = execFileSync("pgrep", ["-f", "celld --no-control-plane"], { encoding: "utf8" }).trim().split("\n")[0]!;
	const stamp = new Date().toISOString().replaceAll(":", "").replace(/\.\d+Z$/, "Z");
	const dir = join(PERF, "profiles");
	mkdirSync(dir, { recursive: true });
	const data = join(dir, `${scenario.id}-${stamp}.perf.data`);
	const recorded = new Promise<void>((done) =>
		setTimeout(() => {
			console.log(`perf record of pid ${server} for ${seconds} s`);
			const rec = spawn("perf", ["record", "-F", "499", "-g", "-p", server, "-o", data, "--", "sleep", String(seconds)], { stdio: "inherit" });
			rec.on("exit", () => done());
		}, delay * 1000),
	);
	const target = resolveTarget({ ...options, target: "dev" });
	const passed = await runOne(scenario, options, target);
	await recorded;
	const script = execFileSync("perf", ["script", "-i", data], { encoding: "utf8", maxBuffer: 1 << 30 });
	// V8's profiling flags also write a log per isolate into the working directory; the perf map is what is needed.
	for (const file of readdirSync(REPO).filter((f) => /^isolate-0x[0-9a-f]+-\d+-v8\.log$/.test(f))) rmSync(join(REPO, file));
	const profiled = fold(script);
	writeFileSync(data.replace(/\.perf\.data$/, ".folded.gz"), gzipSync(`${profiled.folded}\n`, { level: 9 }));
	try {
		writeFileSync(data.replace(/\.perf\.data$/, ".svg"), execFileSync("flamegraph.pl", ["--title", `${scenario.id}: celld dev`], { input: profiled.folded, encoding: "utf8", maxBuffer: 1 << 28 }));
	} catch {
		console.log("flamegraph.pl is not installed; the folded stacks are written");
	}
	const { folded: _, ...summary } = profiled;
	writeFileSync(data.replace(/\.perf\.data$/, ".json"), `${JSON.stringify(summary, null, "\t")}\n`);
	const pct = (n: number): string => `${((n / profiled.samples) * 100).toFixed(1)}%`;
	console.log(`${profiled.samples} samples`);
	console.log(`by layer (leaf): ${Object.entries(profiled.selfByLayer).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${pct(v)}`).join(", ")}`);
	console.log("top functions, inclusive:");
	for (const f of profiled.topInclusive.slice(0, 20)) console.log(`  ${pct(f.samples).padStart(6)}  ${f.layer.padEnd(13)} ${f.frame.slice(0, 120)}`);
	console.log("top functions, self:");
	for (const f of profiled.topSelf.slice(0, 20)) console.log(`  ${pct(f.samples).padStart(6)}  ${f.layer.padEnd(13)} ${f.frame.slice(0, 120)}`);
	return passed ? 0 : 1;
}

/** The harness and the two packages it needs, on the node under ~/pi-world-perf; node itself runs in a container there. */
const REMOTE_DIR: string = "pi-world-perf";
const NODE_IMAGE: string = "docker.io/library/node:25-slim";

function remote(args: readonly string[]): number {
	const [command, ...rest] = args;
	if (command !== "run") throw new Error("perf remote supports run");
	if (!parse(rest).options.approval) throw new Error("a run against the operator's node needs --approval with the operator's words approving it");
	const sync = (paths: string[]) =>
		execFileSync("rsync", ["-a", "--relative", "--exclude", "perf/results/", "--exclude", "perf/profiles/", ...paths, `${NODE.ssh}:${REMOTE_DIR}/`], { cwd: REPO, stdio: "inherit" });
	sync(["perf/", ...runtimePackages(["hdr-histogram-js", "undici"]).map((name) => `node_modules/${name}/`), "package.json"]);
	const quoted = rest.map((a) => `'${a.replaceAll("'", "'\\''")}'`).join(" ");
	const command_ = `podman run --rm --network host --uts host --pid host -v ~/${REMOTE_DIR}:/work:Z -w /work ${NODE_IMAGE} node perf/bin/perf.ts run ${quoted} --target node`;
	let code = 0;
	try {
		execFileSync("ssh", ["-o", "BatchMode=yes", NODE.ssh, command_], { stdio: "inherit" });
	} catch {
		code = 1;
	}
	execFileSync("ssh", ["-o", "BatchMode=yes", NODE.ssh, `mkdir -p ${REMOTE_DIR}/perf/results/node`]);
	execFileSync("rsync", ["-a", `${NODE.ssh}:${REMOTE_DIR}/perf/results/node/`, join(PERF, "results", "node") + "/"], { stdio: "inherit" });
	return code;
}

/** The packages named and everything they depend on, from their package.json files, so the node gets what the harness imports. */
function runtimePackages(roots: readonly string[]): string[] {
	const seen = new Set<string>();
	const walk = (name: string): void => {
		if (seen.has(name)) return;
		seen.add(name);
		const manifest = JSON.parse(readFileSync(join(REPO, "node_modules", name, "package.json"), "utf8")) as { dependencies?: Record<string, string> };
		for (const dependency of Object.keys(manifest.dependencies ?? {})) walk(dependency);
	};
	for (const root of roots) walk(root);
	return [...seen];
}

const BASELINES: string = join(PERF, "baselines.json");

async function suite(args: readonly string[]): Promise<number> {
	const { names, options } = parse(args);
	const chosen = SUITES[names[0] ?? ""] ?? fail(`no suite ${names[0]}; there are ${Object.keys(SUITES).join(", ")}`);
	const target = resolveTarget(options);
	const steps = order(chosen);
	console.log(`suite ${names[0]}: ${chosen.title}; ${steps.map((s) => s.id).join(" → ")}`);
	const files: string[] = [];
	let failed = 0;
	for (const step of steps) {
		const scenario = SCENARIOS.find((s) => s.id === step.scenario) ?? fail(`step ${step.id} names no scenario ${step.scenario}`);
		const before = new Set(safeDir(join(options.out, target.kind)));
		failed += (await runOne(scenario, { ...options, set: { ...step.set, ...options.set } }, target)) ? 0 : 1;
		files.push(...safeDir(join(options.out, target.kind)).filter((f) => !before.has(f)).map((f) => join(options.out, target.kind, f)));
	}
	console.log(`suite ${names[0]}: ${steps.length - failed} of ${steps.length} steps held every verdict`);
	const regressions = ratchet(files);
	return failed === 0 && regressions === 0 ? 0 : 1;
}

/** Compare results with the best-ever of each metric; answers how many regressed. With --update, move the pegs. */
function ratchet(args: readonly string[]): number {
	const update = args.includes("--update");
	const records = results(args.filter((a) => a !== "--update"));
	const baselines: Baselines = (() => {
		try {
			return JSON.parse(readFileSync(BASELINES, "utf8")) as Baselines;
		} catch {
			return {};
		}
	})();
	const comparisons = compare(records, baselines);
	for (const c of comparisons.filter((c) => c.regressed || c.best === undefined || c.improved))
		console.log(`${c.regressed ? "REGRESSED" : c.best === undefined ? "new      " : "improved "} ${c.key}: ${c.measured}${c.best === undefined ? "" : ` (best ${c.best})`}`);
	const regressed = comparisons.filter((c) => c.regressed).length;
	console.log(`ratchet: ${comparisons.length} metrics, ${regressed} regressed`);
	if (update) {
		writeFileSync(BASELINES, `${JSON.stringify(advance(records, baselines), null, "\t")}\n`);
		console.log(`moved ${BASELINES} to every improvement`);
	}
	return regressed;
}

/** The newest result file of each scenario under a directory, or the files named. */
function results(args: readonly string[]): RunRecord[] {
	const files = args.filter((a) => a.endsWith(".json"));
	if (files.length > 0) return files.map((f) => JSON.parse(readFileSync(f, "utf8")) as RunRecord);
	const root = args[0] ?? join(PERF, "results");
	const newest = new Map<string, string>();
	for (const kind of safeDir(root)) {
		for (const file of safeDir(join(root, kind)).filter((f) => f.endsWith(".json")).sort()) newest.set(`${kind}/${file.replace(/-\d{8}T.*$/, "")}`, join(root, kind, file));
	}
	return [...newest.values()].map((f) => JSON.parse(readFileSync(f, "utf8")) as RunRecord);
}

function safeDir(dir: string): string[] {
	try {
		return readdirSync(dir);
	} catch {
		return [];
	}
}

function report(args: readonly string[]): number {
	for (const record of results(args)) {
		console.log(`# ${record.scenario} on ${record.target.kind} (${record.target.base}) at ${record.startedAt}, build ${record.git}`);
		for (const v of record.verdicts) console.log(`  ${mark(v)} ${v.objective.padEnd(11)} ${v.metric}: ${v.measured} (limit ${v.limit})${v.invalid ? ` — ${v.invalid}` : ""}`);
		for (const n of record.notes) console.log(`  note: ${n}`);
	}
	return 0;
}

function gate(args: readonly string[]): number {
	const failing = results(args).flatMap((r) => r.verdicts.filter((v) => !v.invalid && !v.holds).map((v) => ({ r, v })));
	for (const { r, v } of failing) console.log(`FAIL ${r.target.kind}/${r.scenario} ${v.objective} ${v.metric}: ${v.measured} > ${v.limit}`);
	console.log(failing.length === 0 ? "every valid verdict holds" : `${failing.length} verdicts fail`);
	return failing.length === 0 ? 0 : 1;
}

function mark(v: Verdict): string {
	return v.invalid ? "n/a " : v.holds ? "PASS" : "FAIL";
}

function fail(message: string): never {
	throw new Error(message);
}

main(process.argv.slice(2)).then(
	(code) => process.exit(code),
	(error: unknown) => {
		console.error(error instanceof Error ? error.message : error);
		process.exit(2);
	},
);
