import type { WorldListing } from "../src/api/types.ts";

/** The world a reference names: its exact id, else its name (any case), else the one id that starts with it. */
export function resolveWorld(worlds: readonly WorldListing[], ref: string): WorldListing {
	const byId: WorldListing | undefined = worlds.find((w) => w.id === ref);
	if (byId) return byId;
	const lower: string = ref.toLowerCase();
	const byName: readonly WorldListing[] = worlds.filter((w) => w.name.toLowerCase() === lower);
	const candidates: readonly WorldListing[] = byName.length > 0 ? byName : worlds.filter((w) => w.id.startsWith(ref));
	if (candidates.length === 1) return candidates[0]!;
	if (candidates.length > 1) throw new Error(`"${ref}" names ${candidates.length} worlds: ${candidates.map((w) => w.id).join(", ")}`);
	throw new Error(`no world "${ref}"; the worlds are: ${worlds.map((w) => `${w.id} (${w.name})`).join(", ") || "none"}`);
}
