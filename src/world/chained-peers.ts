import type { PeerListing, PeerPort } from "./peer-port.ts";
import type { CatalogueEntry, Outcome } from "./world-vm.ts";

/** How one world reaches another; `chain` lists the worlds the call has passed through, the caller last. */
export interface PeerTransport {
	call(worldId: string, name: string, args: readonly unknown[], chain: readonly string[]): Promise<Outcome>;
	list(): Promise<readonly PeerListing[]>;
	functions(worldId: string): Promise<readonly CatalogueEntry[]>;
}

/** The longest chain of worlds one call may pass through. */
export const MAX_CHAIN: number = 4;

/**
 * The peers of world `self` for a call that arrived through `chain`. A call back into a world already on the chain
 * would wait for that world's lock, which the chain holds, so it is refused; so is a chain longer than `MAX_CHAIN`.
 */
export function chainedPeers(self: string, chain: readonly string[], transport: PeerTransport): PeerPort {
	const path = [...chain, self];
	return {
		call: async (worldId, name, args) => {
			if (path.includes(worldId))
				return { ok: false, failure: "threw", error: `calling ${worldId} would form a cycle: ${[...path, worldId].join(" → ")}` };
			if (path.length >= MAX_CHAIN) return { ok: false, failure: "threw", error: `a call may pass through at most ${MAX_CHAIN} worlds: ${path.join(" → ")}` };
			return transport.call(worldId, name, args, path);
		},
		list: async () => (await transport.list()).filter((world) => world.id !== self),
		functions: (worldId) => transport.functions(worldId),
	};
}
