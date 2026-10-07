import type { DataRow } from "../world/data-port.ts";
import type { PeerListing } from "../world/peer-port.ts";
import type { CatalogueEntry, Outcome } from "../world/world-vm.ts";

/** What the host lends a world's runtime isolate: snapshots by hash, and the other worlds. */
export interface HostApi {
	blob(hash: string): Promise<Uint8Array>;
	peerCall(worldId: string, name: string, args: unknown[], chain: string[]): Promise<Outcome>;
	peerList(): Promise<PeerListing[]>;
	peerFunctions(worldId: string): Promise<CatalogueEntry[]>;
}

/** A row as it crosses into the runtime when a world's data moves there: the key and its JSON text. */
export interface DataRecord {
	readonly key: string;
	readonly json: string;
}

export type { DataRow };
