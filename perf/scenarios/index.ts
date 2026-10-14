import type { Scenario } from "../lib/scenario.ts";
import { chain } from "./chain.ts";
import { coldCall } from "./cold-call.ts";
import { develop } from "./develop.ts";
import { failureStorm } from "./failure-storm.ts";
import { lostUpdate } from "./lost-update.ts";
import { overload } from "./overload.ts";
import { readCall } from "./read-call.ts";
import { slowOverload } from "./slow-overload.ts";
import { stall } from "./stall.ts";
import { worlds } from "./worlds.ts";
import { writeCall } from "./write-call.ts";

/** Every scenario, in the order the objectives list them. */
export const SCENARIOS: readonly Scenario[] = [readCall, writeCall, coldCall, chain, develop, stall, worlds, overload, slowOverload, failureStorm, lostUpdate];

/** The scenario with this id; an unknown id is an error naming the command that lists them. */
export function scenario(id: string): Scenario {
	const found = SCENARIOS.find((s) => s.id === id);
	if (!found) throw new Error(`no scenario ${id}; perf list shows them`);
	return found;
}
