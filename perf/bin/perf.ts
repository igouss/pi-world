#!/usr/bin/env node
/**
 * pi-world's performance harness. `perf help` lists the commands; perf/README.md says how to use them.
 */
import { parse } from "../cli/args.ts";
import { startDev, stopDev } from "../cli/dev-server.ts";
import { profile } from "../cli/profile.ts";
import { ratchet } from "../cli/ratchet.ts";
import { remote } from "../cli/remote.ts";
import { gate, report, results } from "../cli/results.ts";
import { run } from "../cli/run.ts";
import { suite } from "../cli/suite.ts";
import { DEV_PORT } from "../cli/target.ts";
import { SCENARIOS } from "../scenarios/index.ts";
import { SUITES } from "../suites.ts";

const USAGE: string = `usage:
  perf list                                   scenarios, their objectives and parameters
  perf dev up [--env NAME=VALUE]... | down    start (clean) or stop celld dev on port ${DEV_PORT}
  perf run <scenario>... [--target dev|node|URL] [--set name=value]... [--approval TEXT] [--keep] [--internal HOST:PORT]
                                              run scenarios; a run against the node needs --approval with the operator's words
  perf report [results.json...]               print the verdicts of result files (default: the newest of each scenario)
  perf gate [dir]                             exit 1 if any valid verdict in the newest results fails
  perf suite <name> [--target ...] [--approval TEXT] [--update]
                                              run a suite's scenario graph in dependency order, then ratchet it
                                              (suites: ${Object.keys(SUITES).join(", ")})
  perf ratchet [--update] [results.json...]   compare the newest results with the best-ever of each metric (perf/baselines.json);
                                              exit 1 on a regression; --update moves the baselines to every improvement
  perf profile <scenario> --celld PATH [--seconds N] [--delay N] [--set ...]
                                              run a scenario on a clean celld dev started from PATH (a celld built to read
                                              CELLD_V8_FLAGS), record it with Linux perf, and attribute the samples by layer
  perf remote run <scenario>... --approval TEXT [--set ...]
                                              copy the harness to the node and run it there, on loopback, in a node container;
                                              its result files are copied back to perf/results/node/`;

async function main(argv: readonly string[]): Promise<number> {
	const [command = "help", ...rest] = argv;
	const options = parse(rest);
	switch (command) {
		case "list":
			for (const s of SCENARIOS) console.log(`${s.id.padEnd(14)} ${s.objectives.join(",").padEnd(16)} ${s.title}  [${Object.entries(s.params).map(([k, v]) => `${k}=${v}`).join(" ")}]`);
			return 0;
		case "run":
			return run(options);
		case "dev":
			if (options.names[0] === "down") {
				stopDev();
				return 0;
			}
			return (await startDev("celld", options.env)) ? 0 : 1;
		case "report":
			return report(options.names);
		case "gate":
			return gate(options.names);
		case "suite":
			return suite(options);
		case "ratchet":
			return ratchet(results(options.names), options.update) === 0 ? 0 : 1;
		case "profile":
			return profile(options);
		case "remote":
			return remote(options, rest);
		default:
			console.log(USAGE);
			return command === "help" ? 0 : 2;
	}
}

main(process.argv.slice(2)).then(
	(code) => process.exit(code),
	(error: unknown) => {
		console.error(error instanceof Error ? error.message : error);
		process.exit(2);
	},
);
