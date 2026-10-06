import type { CatalogueEntry } from "./world-vm.ts";

export interface CatalogueChanges {
	readonly added: readonly string[];
	readonly changed: readonly string[];
	readonly removed: readonly string[];
}

export function diffCatalogues(before: readonly CatalogueEntry[], after: readonly CatalogueEntry[]): CatalogueChanges {
	const old = new Map(before.map((entry) => [entry.name, entry]));
	const next = new Map(after.map((entry) => [entry.name, entry]));
	const same = (a: CatalogueEntry, b: CatalogueEntry): boolean =>
		a.source === b.source && a.version === b.version && a.doc === b.doc;
	return {
		added: after.filter((entry) => !old.has(entry.name)).map((entry) => entry.name),
		changed: after.filter((entry) => old.has(entry.name) && !same(old.get(entry.name)!, entry)).map((entry) => entry.name),
		removed: before.filter((entry) => !next.has(entry.name)).map((entry) => entry.name),
	};
}
