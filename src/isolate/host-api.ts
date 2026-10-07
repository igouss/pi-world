import type { PeerTransport } from "../world/chained-peers.ts";

/** What the host lends a world's runtime isolate: snapshots by content hash, and the other worlds. */
export interface HostApi extends PeerTransport {
	blob(hash: string): Promise<Uint8Array>;
}

/** A row as it crosses into the runtime: its key and its JSON text. */
export interface DataRecord {
	readonly key: string;
	readonly json: string;
}
