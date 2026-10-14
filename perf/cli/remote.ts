import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { quote } from "../lib/operator.ts";
import type { Options } from "./args.ts";
import { fail, PERF, REPO } from "./paths.ts";
import { git } from "./run.ts";
import { NODE } from "./target.ts";

/** Where the harness lives on the node, and the image node runs from there: the node has no Node.js of its own. */
const REMOTE_DIR: string = "pi-world-perf";
const NODE_IMAGE: string = "docker.io/library/node:25-slim";

/**
 * `perf remote run`: copy the harness and the packages it imports to the node, run it there in a container on the
 * host's network and PID namespace (so the client is on loopback and can read celld's /proc), and copy its result
 * files back. `args` are passed to `perf run` as given.
 */
export function remote(options: Options, args: readonly string[]): number {
	if (options.names[0] !== "run") fail("perf remote supports run");
	if (!options.approval) fail("a run against the operator's node needs --approval with the operator's words approving it");
	const packages = runtimePackages(["hdr-histogram-js", "undici"]).map((name) => `node_modules/${name}/`);
	execFileSync("rsync", ["-a", "--relative", "--exclude", "perf/results/", "--exclude", "perf/profiles/", "perf/", ...packages, "package.json", `${NODE.ssh}:${REMOTE_DIR}/`], { cwd: REPO, stdio: "inherit" });
	const passed = args.slice(args.indexOf("run") + 1).map(quote).join(" ");
	const command = `podman run --rm --network host --uts host --pid host -e PERF_GIT=${quote(git())} -v ~/${REMOTE_DIR}:/work:Z -w /work ${NODE_IMAGE} node perf/bin/perf.ts run ${passed} --target node`;
	let code = 0;
	try {
		execFileSync("ssh", ["-o", "BatchMode=yes", NODE.ssh, command], { stdio: "inherit" });
	} catch {
		code = 1;
	}
	execFileSync("ssh", ["-o", "BatchMode=yes", NODE.ssh, `mkdir -p ${REMOTE_DIR}/perf/results/node`]);
	execFileSync("rsync", ["-a", `${NODE.ssh}:${REMOTE_DIR}/perf/results/node/`, `${join(PERF, "results", "node")}/`], { stdio: "inherit" });
	return code;
}

/** The packages named and everything they depend on, from their package.json files. */
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
