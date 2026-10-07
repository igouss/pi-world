import type { BlobStore, LocalBlobStore } from "./blob-store.ts";

/** Long-term storage for snapshot blobs, such as an object store. `put` is idempotent. */
export interface ArchiveStore {
	put(hash: string, bytes: Uint8Array): Promise<void>;
	get(hash: string): Promise<Uint8Array | undefined>;
	has(hash: string): Promise<boolean>;
}

/**
 * Snapshot blobs in two tiers. A new blob is written to the local tier, so the write before a revision's commit stays
 * fast and the head opens from local storage. `archive` moves every other blob to the archive, deleting the local
 * copy only once the archive holds it; a pass interrupted halfway is completed by the next one. A blob not held
 * locally is read from the archive.
 */
export class TieredBlobStore implements BlobStore {
	constructor(
		private readonly local: LocalBlobStore,
		private readonly archive: ArchiveStore,
	) {}

	put(hash: string, bytes: Uint8Array): Promise<void> {
		return this.local.put(hash, bytes);
	}

	async get(hash: string): Promise<Uint8Array | undefined> {
		return (await this.local.get(hash)) ?? (await this.archive.get(hash));
	}

	/** Move every local blob but `keep` (the head's) to the archive; answers how many moved. */
	async archiveAllBut(keep: string): Promise<number> {
		let archived = 0;
		for (const hash of await this.local.hashes()) {
			if (hash === keep) continue;
			if (!(await this.archive.has(hash))) {
				const bytes = await this.local.get(hash);
				if (!bytes) continue;
				await this.archive.put(hash, bytes);
			}
			await this.local.delete(hash);
			archived++;
		}
		return archived;
	}
}
