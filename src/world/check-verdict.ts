import type { Check } from "../check/check.ts";
import { Choices } from "../check/choices.ts";
import { generate, type Generator, type Json } from "../check/generator.ts";
import { shrink } from "../check/shrink.ts";
import { MemoryDataPort } from "./data-port.ts";
import { mulberry32 } from "./random.ts";
import type { AttemptMode, WorldVm } from "./world-vm.ts";
import { firstLine } from "../api/text.ts";

/** How many inputs a property check tries each time it runs. */
export const PROPERTY_CASES: number = 50;

/** How many replays shrinking a failing input may take. */
const SHRINK_BUDGET: number = 200;

type Checked = Pick<Check, "expression" | "generator">;

/** A run of a check that did not hold: what it returned or threw, and for a property check the input and its choices. */
interface Failed {
	readonly verdict: string;
	readonly input?: Json;
	readonly choices?: readonly number[];
}

/**
 * `true` when the check holds, otherwise what it returned or threw. A plain check is one expression; a property
 * check must hold for `PROPERTY_CASES` inputs drawn from its generator, seeded by the attempt, and its failure names
 * the smallest input it shrinks to. Each evaluation gets a fresh, empty scratch data store; heap changes are left
 * for the caller to discard.
 */
export async function checkVerdict(vm: WorldVm, check: Checked, mode: AttemptMode): Promise<true | string> {
	const failed = await firstFailure(vm, check, mode);
	if (!failed) return true;
	if (!check.generator || !failed.choices) return failed.verdict;
	const smallest = await smallestFailure(vm, check.expression, check.generator, failed, mode);
	return `on input ${JSON.stringify(smallest.input)}: ${smallest.verdict}`;
}

/** Whether the check fails at all, without shrinking: what a counterexample re-run needs to know. */
export async function checkFails(vm: WorldVm, check: Checked, mode: AttemptMode): Promise<boolean> {
	return (await firstFailure(vm, check, mode)) !== undefined;
}

async function firstFailure(vm: WorldVm, check: Checked, mode: AttemptMode): Promise<Failed | undefined> {
	if (!check.generator) {
		const verdict = await holds(vm, check.expression, mode);
		return verdict === true ? undefined : { verdict };
	}
	const random = mulberry32(mode.seed);
	for (let i = 0; i < PROPERTY_CASES; i++) {
		const choices = new Choices([], random);
		const input = generate(check.generator, choices);
		const verdict = await holdsFor(vm, check.expression, input, mode);
		if (verdict !== true) return { verdict, input, choices: choices.record() };
	}
	return undefined;
}

/** Shrink a failing input's choices, keeping the input and verdict of the smallest run that still failed. */
async function smallestFailure(vm: WorldVm, expression: string, generator: Generator, failed: Failed, mode: AttemptMode): Promise<Failed> {
	const runs = new Map<string, Failed>();
	const smallest = await shrink(
		failed.choices!,
		async (prefix) => {
			const choices = new Choices(prefix);
			const input = generate(generator, choices);
			const verdict = await holdsFor(vm, expression, input, mode);
			if (verdict === true) return undefined;
			runs.set(choices.record().join(","), { verdict, input });
			return choices.record();
		},
		SHRINK_BUDGET,
	);
	return runs.get(smallest.join(",")) ?? failed;
}

function holdsFor(vm: WorldVm, expression: string, input: Json, mode: AttemptMode): Promise<true | string> {
	return holds(vm, `((input) => (\n${expression}\n))(${JSON.stringify(input)})`, mode);
}

async function holds(vm: WorldVm, expression: string, mode: AttemptMode): Promise<true | string> {
	const outcome = await vm.evaluate(expression, { kind: "check", at: mode.at, seed: mode.seed, data: new MemoryDataPort() });
	if (!outcome.ok) return `${outcome.failure}: ${firstLine(outcome.error)}`;
	return outcome.value === true ? true : `returned ${JSON.stringify(outcome.value)}`;
}
