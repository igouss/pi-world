import type { CatalogueEntry, Outcome } from "./world-vm.ts";

export interface PeerListing {
	readonly id: string;
	readonly name: string;
}

/**
 * Other worlds, as one world's live code sees them. An adapter carries the chain of worlds a call has passed through,
 * so a cycle or a deep chain is refused instead of waiting on a lock it already holds.
 */
export interface PeerPort {
	call(worldId: string, name: string, args: readonly unknown[]): Promise<Outcome>;
	list(): Promise<readonly PeerListing[]>;
	functions(worldId: string): Promise<readonly CatalogueEntry[]>;
}

/** The peer port of a world that is alone. */
export const NO_PEERS: PeerPort = {
	call: async (worldId) => ({ ok: false, failure: "threw", error: `no world ${worldId} is reachable from here` }),
	list: async () => [],
	functions: async (worldId) => {
		throw new Error(`no world ${worldId} is reachable from here`);
	},
};
