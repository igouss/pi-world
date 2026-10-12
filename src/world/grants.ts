import { WORLD_ID } from "../directory/world-id.ts";
import type { PeerPort } from "./peer-port.ts";

/**
 * What a world may reach beyond itself, granted by its owner. `calls` is "any" or the ids of the worlds whose
 * definitions this world's calls may call; the agent cannot change it.
 */
export interface Grants {
	readonly calls: "any" | readonly string[];
}

/** What a world has until its owner restricts it: today's behaviour, any world. */
export const ANY_WORLD: Grants = { calls: "any" };

/** The most worlds one grant may name. */
const MAX_GRANTED: number = 100;

/** Check grants as the operator sent them: "any", or a list of distinct world ids. */
export function parseGrants(value: unknown): { readonly grants: Grants } | { readonly error: string } {
	const calls = (value as { calls?: unknown } | null)?.calls;
	if (calls === "any") return { grants: ANY_WORLD };
	if (!Array.isArray(calls)) return { error: `calls is "any" or a list of world ids; got ${JSON.stringify(calls)}` };
	if (calls.length > MAX_GRANTED) return { error: `a grant names at most ${MAX_GRANTED} worlds` };
	const bad = calls.find((id) => typeof id !== "string" || !WORLD_ID.test(id));
	if (bad !== undefined) return { error: `not a world id: ${JSON.stringify(bad)}` };
	return { grants: { calls: [...new Set(calls as string[])].sort() } };
}

export function mayCall(grants: Grants, worldId: string): boolean {
	return grants.calls === "any" || grants.calls.includes(worldId);
}

/**
 * The other worlds as a world with `grants` sees them: only the granted ones are listed, and a call to or a listing
 * of any other is refused, naming the grant it lacks.
 */
export function grantedPeers(peers: PeerPort, grants: Grants): PeerPort {
	if (grants.calls === "any") return peers;
	const refused = (worldId: string): string => `this world may not call ${worldId}: its owner has not granted it`;
	return {
		call: async (worldId, name, args) => (mayCall(grants, worldId) ? peers.call(worldId, name, args) : { ok: false, failure: "threw", error: refused(worldId) }),
		list: async () => (grants.calls.length === 0 ? [] : (await peers.list()).filter((world) => mayCall(grants, world.id))),
		functions: async (worldId) => {
			if (!mayCall(grants, worldId)) throw new Error(refused(worldId));
			return peers.functions(worldId);
		},
	};
}
