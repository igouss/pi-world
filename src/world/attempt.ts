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
 * world is rejected; so is one after which an enrolled check does not return `true`. A rejected attempt restores the
 * checkpoint, so it leaves no trace in the heap.
 */
export async function attemptDevelop(vm: WorldVm, source: string, checks: readonly Check[], mode: AttemptMode): Promise<Attempt> {
	const checkpoint = vm.snapshot();
	const before = vm.catalogue();
	const evaluated = vm.develop(source, mode);
	if (!evaluated.ok) {
		await vm.reset(checkpoint);
		return { accepted: false, failure: evaluated.failure, reason: evaluated.error };
	}
	for (const check of checks) {
		const verdict = runCheck(vm, check, mode);
		if (verdict !== true) {
			await vm.reset(checkpoint);
			return { accepted: false, failure: "check", check: check.name, reason: `check "${check.name}" failed: ${verdict}` };
		}
	}
	const catalogue = vm.catalogue();
	return { accepted: true, snapshot: vm.snapshot(), catalogue, changes: diffCatalogues(before, catalogue) };
}

/** `true` when the check holds, otherwise a description of what it returned or threw. */
export function runCheck(vm: WorldVm, check: Pick<Check, "expression">, mode: AttemptMode): true | string {
	const outcome = vm.evaluate(check.expression, mode);
	if (!outcome.ok) return `${outcome.failure}: ${outcome.error.split("\n")[0]}`;
	return outcome.value === true ? true : `returned ${JSON.stringify(outcome.value)}`;
}

export type Enrolment = { readonly enrolled: true } | { readonly enrolled: false; readonly reason: string };

/**
 * A check is enrolled only after it has been seen failing: it must hold on the current world, and it must fail once
 * the counterexample is applied on a checkpoint. The world is restored either way.
 */
export async function attemptEnrolment(vm: WorldVm, expression: string, counterexample: string, mode: AttemptMode): Promise<Enrolment> {
	const now = runCheck(vm, { expression }, mode);
	if (now !== true) return { enrolled: false, reason: `the check does not hold on the current world: ${now}` };
	const checkpoint = vm.snapshot();
	try {
		const applied = vm.develop(counterexample, mode);
		if (!applied.ok) return { enrolled: false, reason: `the counterexample did not apply (${applied.failure}): ${applied.error.split("\n")[0]}` };
		const broken = runCheck(vm, { expression }, mode);
		if (broken === true) return { enrolled: false, reason: "the check still holds after the counterexample, so it was never seen failing" };
		return { enrolled: true };
	} finally {
		await vm.reset(checkpoint);
	}
}
