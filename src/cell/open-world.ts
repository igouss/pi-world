import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import { createRegistry, Harness, type Conversation, type HarnessSettings, type ModelRef, type Storage } from "@earendil-works/pi-durable";
import { worldExtension } from "../agent/world-extension.ts";
import type { BlobStore } from "../revision/blob-store.ts";
import type { DataPort } from "../world/data-port.ts";
import type { PeerPort } from "../world/peer-port.ts";
import { World } from "../world/world.ts";

export interface OpenWorldDeps {
	readonly storage: Storage;
	readonly blobs: BlobStore;
	readonly data: DataPort;
	readonly peers?: PeerPort;
	readonly wasm: WebAssembly.Module;
	readonly models: Models;
	readonly model: ModelRef;
	readonly settings?: HarnessSettings;
	readonly now?: () => number;
}

export interface OpenedWorld {
	readonly harness: Harness;
	readonly world: World;
	readonly root: Conversation;
}

/**
 * One world and the agent that grows it, over one storage. The world opens on the harness's session, so revisions
 * commit on the same line as the conversation. Tasks resume only after the world's tools are installed.
 */
export async function openWorld(deps: OpenWorldDeps): Promise<OpenedWorld> {
	const registry = createRegistry();
	const harness = await Harness.open(
		deps.storage,
		{ models: deps.models, registry, ...(deps.settings ? { settings: deps.settings } : {}) },
		BACKGROUND_CONTEXT,
	);
	const world = await World.open({
		session: harness,
		blobs: deps.blobs,
		data: deps.data,
		...(deps.peers ? { peers: deps.peers } : {}),
		wasm: deps.wasm,
		...(deps.now ? { now: deps.now } : {}),
	});
	registry.install(worldExtension(world));
	const root = await harness.root(BACKGROUND_CONTEXT, { agent: { model: deps.model } });
	harness.resume();
	return { harness, world, root };
}
