/**
 * Named suites: graphs of scenario steps. A step runs after every step it `needs`; steps never overlap, because two
 * loads on one server would measure each other. `perf suite <name>` runs one, then gates and ratchets its results.
 */
export interface Step {
	readonly id: string;
	readonly scenario: string;
	readonly set?: Readonly<Record<string, number>>;
	readonly needs?: readonly string[];
}

export interface Suite {
	readonly title: string;
	readonly steps: readonly Step[];
}

export const SUITES: Readonly<Record<string, Suite>> = {
	/** What a change to the call path must not slow down: minutes, not a quarter of an hour. */
	quick: {
		title: "The call path, briefly",
		steps: [
			{ id: "read", scenario: "read-call", set: { duration: 20, warmup: 5 } },
			{ id: "write", scenario: "write-call", set: { duration: 20, warmup: 5 }, needs: ["read"] },
			{ id: "chain", scenario: "chain", set: { duration: 20, warmup: 5 }, needs: ["read"] },
			{ id: "serializable", scenario: "lost-update", needs: ["write"] },
		],
	},
	/** Every objective that one server can judge, in the order a failure upstream explains failures downstream. */
	full: {
		title: "Every objective one server judges",
		steps: [
			{ id: "read", scenario: "read-call" },
			{ id: "write", scenario: "write-call", needs: ["read"] },
			{ id: "chain", scenario: "chain", needs: ["read"] },
			{ id: "cold", scenario: "cold-call", needs: ["read"] },
			{ id: "develop", scenario: "develop", needs: ["read"] },
			{ id: "stall", scenario: "stall", needs: ["read", "develop"] },
			{ id: "overload", scenario: "overload", needs: ["read"] },
			{ id: "slow-overload", scenario: "slow-overload", needs: ["overload"] },
			{ id: "failures", scenario: "failure-storm", needs: ["read"] },
			{ id: "serializable", scenario: "lost-update", needs: ["write"] },
		],
	},
};

/** The steps in an order that runs each after everything it needs; a cycle or an unknown step is an error. */
export function order(suite: Suite): readonly Step[] {
	const byId = new Map(suite.steps.map((s) => [s.id, s]));
	const done = new Set<string>();
	const visiting = new Set<string>();
	const out: Step[] = [];
	const visit = (step: Step): void => {
		if (done.has(step.id)) return;
		if (visiting.has(step.id)) throw new Error(`suite steps form a cycle through ${step.id}`);
		visiting.add(step.id);
		for (const need of step.needs ?? []) visit(byId.get(need) ?? fail(`step ${step.id} needs ${need}, which the suite does not have`));
		visiting.delete(step.id);
		done.add(step.id);
		out.push(step);
	};
	for (const step of suite.steps) visit(step);
	return out;
}

function fail(message: string): never {
	throw new Error(message);
}
