/**
 * A plain copy of a value as strict JSON: undefined fields dropped. A document holds strict JSON, and a draft is only
 * valid inside its commit, so what leaves a commit goes through here.
 */
export function plain<T>(value: unknown): T {
	return JSON.parse(JSON.stringify(value)) as T;
}
