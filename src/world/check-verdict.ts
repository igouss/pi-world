import type { Check } from "../check/check.ts";
import { Choices } from "../check/choices.ts";
import { generate, type Generator, type Json } from "../check/generator.ts";
import { shrink, STOP } from "../check/shrink.ts";
import { MemoryDataPort } from "./data-port.ts";
import { mulberry32 } from "./random.ts";
import type { AttemptMode, WorldVm } from "./world-vm.ts";
import { firstLine } from "../api/text.ts";

/** How many inputs a property check tries each time it runs. */
export const PROPERTY_CASES: number = 50;

/** How many replays shrinking a failing input may take. */
const SHRINK_BUDGET: number = 200;

type Checked = Pick<Check, "expression" | "generator">;

/** One evaluation of a check that did not hold: whether it ran out of budget, and what it returned or how it failed. */
interface Broken {
	readonly hung: boolean;
	readonly verdict: string;
}

/** A generated input a property check did not hold for, and the choices that generated it. */
interface Failed extends Broken {
	readonly input: Json;
	readonly choices: readonly number[];
}

/**
 * `true` when the check holds, otherwise what it returned or threw. A plain check is one expression; a property
 * check must hold for `PROPERTY_CASES` inputs drawn from its generator, seeded by the attempt, and its failure names
 * the smallest input it shrinks to. An input the check runs out of budget on is not shrunk, and shrinking stops at
 * the first smaller input it runs out of budget on: every such run costs a whole budget, so a check runs out of
 * budget at most once. Each evaluation gets a fresh, empty scratch data store; heap changes are left for the caller
 * to discard.
 */
export async function checkVerdict(vm: WorldVm, check: Checked, mode: AttemptMode): Promise<true | string> {
	if (!check.generator) {
		const broken = await holds(vm, check.expression, mode);
		return broken === true ? true : broken.verdict;
	}
	const failed = await firstFailingInput(vm, check.expression, check.generator, mode);
	if (!failed) return true;
	const reported = failed.hung ? failed : await smallestFailure(vm, check.expression, check.generator, failed, mode);
	return `on input ${JSON.stringify(reported.input)}: ${reported.verdict}`;
}

/** Whether the check fails at all, without shrinking: what a counterexample re-run needs to know. */
export async function checkFails(vm: WorldVm, check: Checked, mode: AttemptMode): Promise<boolean> {
	if (!check.generator) return (await holds(vm, check.expression, mode)) !== true;
	return (await firstFailingInput(vm, check.expression, check.generator, mode)) !== undefined;
}

async function firstFailingInput(vm: WorldVm, expression: string, generator: Generator, mode: AttemptMode): Promise<Failed | undefined> {
	const random = mulberry32(mode.seed);
	for (let i = 0; i < PROPERTY_CASES; i++) {
		const choices = new Choices([], random);
		const input = generate(generator, choices);
		const broken = await holdsFor(vm, expression, input, mode);
		if (broken !== true) return { ...broken, input, choices: choices.record() };
	}
	return undefined;
}

/** Shrink a failing input's choices, keeping the input and verdict of the smallest run that still failed. */
async function smallestFailure(vm: WorldVm, expression: string, generator: Generator, failed: Failed, mode: AttemptMode): Promise<Failed> {
	const runs = new Map<string, Failed>();
	const smallest = await shrink(
		failed.choices,
		async (prefix) => {
			const choices = new Choices(prefix);
			const input = generate(generator, choices);
			const broken = await holdsFor(vm, expression, input, mode);
			if (broken === true) return undefined;
			if (broken.hung) return STOP;
			const drawn: readonly number[] = choices.record();
			runs.set(drawn.join(","), { ...broken, input, choices: drawn });
			return drawn;
		},
		SHRINK_BUDGET,
	);
	return runs.get(smallest.join(",")) ?? failed;
}

function holdsFor(vm: WorldVm, expression: string, input: Json, mode: AttemptMode): Promise<true | Broken> {
	return holds(vm, `((input) => (\n${expression}\n))(${JSON.stringify(input)})`, mode);
}

async function holds(vm: WorldVm, expression: string, mode: AttemptMode): Promise<true | Broken> {
	const outcome = await vm.evaluate(expression, { kind: "check", at: mode.at, seed: mode.seed, data: new MemoryDataPort() });
	if (!outcome.ok) return { hung: outcome.failure === "budget", verdict: `${outcome.failure}: ${firstLine(outcome.error)}` };
	return outcome.value === true ? true : { hung: false, verdict: `returned ${JSON.stringify(outcome.value)}` };
}
