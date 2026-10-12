import type { Snapshot } from "quickjs-wasi";
import type { Check } from "../check/check.ts";
import { diffCatalogues, type CatalogueChanges } from "./catalogue-diff.ts";
import type { CatalogueEntry, Failure, Mode } from "./world-vm.ts";
import type { WorldVm } from "./world-vm.ts";

export type AttemptMode = Mode & { kind: "attempt" };

export type Attempt =
	| {
			readonly accepted: true;
			readonly snapshot: Snapshot;
			readonly catalogue: readonly CatalogueEntry[];
			readonly changes: CatalogueChanges;
	  }
	| {
			readonly accepted: false;
			readonly failure: Failure | "check";
			readonly reason: string;
			readonly check?: string;
	  };

/**
 * Evaluate a develop source against a checkpoint. A source that throws, runs out of budget or reaches the outside
 * world is rejected; so is one after which an enrolled check does not return `true`, or no longer fails on its
 * counterexample: a check that cannot fail protects nothing, and a change to a definition or a state it reads can
 * make it vacuous. A rejected attempt restores the checkpoint, so it leaves no trace in the heap.
 *
 * The accepted snapshot is the heap right after the source, so whatever the checks do to the heap is not kept. A
 * counterexample is evaluated as stored: the caller has already applied the host rewrite.
 */
export async function attemptDevelop(vm: WorldVm, source: string, checks: readonly Check[], mode: AttemptMode): Promise<Attempt> {
	const checkpoint = vm.snapshot();
	const before = vm.catalogue();
	const evaluated = vm.develop(source, mode);
	if (!evaluated.ok) {
		await vm.reset(checkpoint);
		return { accepted: false, failure: evaluated.failure, reason: evaluated.error };
	}
	const developed = vm.snapshot();
	const broken = await firstBrokenCheck(vm, checks, mode, developed);
	if (broken) {
		await vm.reset(checkpoint);
		return { accepted: false, failure: "check", ...broken };
	}
	const catalogue = vm.catalogue();
	return { accepted: true, snapshot: developed, catalogue, changes: diffCatalogues(before, catalogue) };
}

/**
 * The first check that fails on the developed heap, or no longer fails on its counterexample. Each check starts from
 * the developed heap, and the heap is back at it afterwards.
 */
async function firstBrokenCheck(vm: WorldVm, checks: readonly Check[], mode: AttemptMode, developed: Snapshot): Promise<{ check: string; reason: string } | undefined> {
	for (const check of checks) {
		const verdict = await runCheck(vm, check, mode);
		if (verdict !== true) return { check: check.name, reason: `check "${check.name}" failed: ${verdict}` };
		const seen = await seenFailing(vm, check, mode);
		await vm.reset(developed);
		if (seen !== true)
			return {
				check: check.name,
				reason: `check "${check.name}" no longer fails on its counterexample after this change (${seen}), so it would protect nothing. Keep the behaviour it was enrolled for, or ask the owner to remove the check.`,
			};
	}
	return undefined;
}

/** `true` when the check holds, otherwise a description of what it returned or threw. */
async function runCheck(vm: WorldVm, check: Pick<Check, "expression">, mode: AttemptMode): Promise<true | string> {
	const outcome = await vm.evaluate(check.expression, mode);
	if (!outcome.ok) return `${outcome.failure}: ${outcome.error.split("\n")[0]}`;
	return outcome.value === true ? true : `returned ${JSON.stringify(outcome.value)}`;
}

/**
 * Apply the check's counterexample to the heap as it is and run the check: `true` when the check fails there, as it
 * must, otherwise why it could not be seen failing. The caller restores the heap.
 */
async function seenFailing(vm: WorldVm, check: Pick<Check, "expression" | "counterexample">, mode: AttemptMode): Promise<true | string> {
	const applied = vm.develop(check.counterexample, mode);
	if (!applied.ok) return `the counterexample did not apply (${applied.failure}): ${applied.error.split("\n")[0]}`;
	const broken = await runCheck(vm, check, mode);
	return broken === true ? "the check still holds after the counterexample, so it was never seen failing" : true;
}

export type Enrolment = { readonly enrolled: true } | { readonly enrolled: false; readonly reason: string };

/**
 * A check is enrolled only after it has been seen failing: it must hold on the current world, and it must fail once
 * the counterexample is applied on a checkpoint. The world is restored either way.
 */
export async function attemptEnrolment(vm: WorldVm, expression: string, counterexample: string, mode: AttemptMode): Promise<Enrolment> {
	const now = await runCheck(vm, { expression }, mode);
	if (now !== true) return { enrolled: false, reason: `the check does not hold on the current world: ${now}` };
	const checkpoint = vm.snapshot();
	try {
		const seen = await seenFailing(vm, { expression, counterexample }, mode);
		return seen === true ? { enrolled: true } : { enrolled: false, reason: seen };
	} finally {
		await vm.reset(checkpoint);
	}
}
