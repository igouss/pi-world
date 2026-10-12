import { parse, type Identifier } from "acorn";
import { full } from "acorn-walk";

/** One definition's place in the call graph. */
export interface References {
	/** Other definitions its source names. */
	readonly calls: readonly string[];
	/** Definitions whose source names it. */
	readonly calledBy: readonly string[];
}

export const NO_REFERENCES: References = { calls: [], calledBy: [] };

/**
 * Who names whom among the definitions, read from their sources. A name counts wherever it is used as a value, so a
 * local variable that shadows a definition counts as a use, and a call through `globalThis[name]` or `worlds.call`
 * does not: this is for reading the world, not a proof of what can run.
 */
export function references(definitions: readonly { readonly name: string; readonly source: string }[]): ReadonlyMap<string, References> {
	const names = new Set(definitions.map((d) => d.name));
	const calls = new Map<string, string[]>();
	const calledBy = new Map<string, string[]>(definitions.map((d) => [d.name, []]));
	for (const d of definitions) {
		const named = [...namesUsed(d.source)].filter((name) => names.has(name) && name !== d.name).sort();
		calls.set(d.name, named);
		for (const callee of named) calledBy.get(callee)?.push(d.name);
	}
	return new Map(definitions.map((d) => [d.name, { calls: calls.get(d.name) ?? [], calledBy: (calledBy.get(d.name) ?? []).sort() }]));
}

/** Every identifier used as a value in a function or class source. */
function namesUsed(source: string): ReadonlySet<string> {
	const used = new Set<string>();
	try {
		full(parse(`(${source})`, { ecmaVersion: "latest" }), (node, _state, type) => {
			if (type === "Identifier") used.add((node as Identifier).name);
		});
	} catch {
		// A native or host function's source does not parse; it names no definition.
	}
	return used;
}
