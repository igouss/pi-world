import { WorkerEntrypoint } from "cloudflare:workers";
import { DIRECTORY_NAME, type Env } from "../env.ts";
import type { PeerListing } from "../world/peer-port.ts";
import type { CatalogueEntry, Outcome } from "../world/world-vm.ts";
import type { HostApi } from "./host-api.ts";

/**
 * The capability a world's runtime isolate gets: it runs in the host, so the runtime reaches storage and other
 * worlds only through these methods. `worldId` is fixed when the capability is made.
 */
export class WorldHost extends WorkerEntrypoint<Env, { worldId: string }> implements HostApi {
	blob(hash: string): Promise<Uint8Array> {
		return this.env.WORLD.getByName(this.ctx.props.worldId).blobBytes(hash);
	}

	peerCall(worldId: string, name: string, args: unknown[], chain: string[]): Promise<Outcome> {
		return this.env.WORLD.getByName(worldId).peerCall(name, args, chain);
	}

	async peerList(): Promise<PeerListing[]> {
		return (await this.env.DIRECTORY.getByName(DIRECTORY_NAME).list()).map(({ id, name }) => ({ id, name }));
	}

	async peerFunctions(worldId: string): Promise<CatalogueEntry[]> {
		return [...(await this.env.WORLD.getByName(worldId).peerFunctions())];
	}
}
