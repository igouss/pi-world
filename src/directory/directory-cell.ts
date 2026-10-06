import { DurableObject } from "cloudflare:workers";
import type { WorldListing } from "../api/types.ts";
import { worldId } from "./world-id.ts";

/** The list of worlds. Each world lives in its own cell; this cell only knows their ids and names. */
export class DirectoryCell extends DurableObject {
	async list(): Promise<readonly WorldListing[]> {
		return (await this.ctx.storage.get<WorldListing[]>("worlds")) ?? [];
	}

	async create(name: string): Promise<WorldListing> {
		const trimmed = name.trim();
		if (!trimmed) throw new Error("a world needs a name");
		const worlds = [...(await this.list())];
		const listing: WorldListing = { id: worldId(trimmed, crypto.getRandomValues(new Uint8Array(3))), name: trimmed, createdAt: Date.now() };
		worlds.unshift(listing);
		await this.ctx.storage.put("worlds", worlds);
		return listing;
	}

	async get(id: string): Promise<WorldListing | undefined> {
		return (await this.list()).find((world) => world.id === id);
	}

	/** Forget a world. Its cell keeps its storage; nothing is deleted. */
	async forget(id: string): Promise<void> {
		await this.ctx.storage.put("worlds", (await this.list()).filter((world) => world.id !== id));
	}
}
