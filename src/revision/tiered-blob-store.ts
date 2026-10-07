import type { BlobStore, LocalBlobStore } from "./blob-store.ts";

/**
 * Snapshot blobs in two tiers. A new blob is written to the local tier, so the write before a revision's commit stays
 * fast and the head opens from local storage. Every other blob moves to the archive, gzipped or not as the archive
 * chooses; the local copy is deleted only once the archive holds it, so a pass interrupted halfway is completed by
 * the next one. A blob not held locally is read from the archive. The archive's `put` must be idempotent.
 */
export class TieredBlobStore implements BlobStore {
	private archivedFor: string | undefined;
	private wanted: string | undefined;
	private running: Promise<void> | undefined;

	constructor(
		private readonly local: LocalBlobStore,
		private readonly archive: BlobStore,
		private readonly onArchiveError: (error: unknown) => void = () => undefined,
	) {}

	put(hash: string, bytes: Uint8Array): Promise<void> {
		return this.local.put(hash, bytes);
	}

	async get(hash: string): Promise<Uint8Array | undefined> {
		return (await this.local.get(hash)) ?? (await this.archive.get(hash));
	}

	/**
	 * Archive every blob but the head's, in the background. Passes run one at a time; requests that arrive during a
	 * pass collapse into one more pass for the newest head, and a head already archived for asks for nothing.
	 */
	archiveFor(head: string): Promise<void> {
		if (head === this.archivedFor && !this.running) return Promise.resolve();
		this.wanted = head;
		this.running ??= this.drain();
		return this.running;
	}

	/** Move every local blob but `keep` to the archive; answers how many moved. */
	async archiveAllBut(keep: string): Promise<number> {
		let moved = 0;
		for (const hash of await this.local.hashes()) {
			if (hash === keep) continue;
			const bytes = await this.local.get(hash);
			if (!bytes) continue;
			await this.archive.put(hash, bytes);
			await this.local.delete(hash);
			moved++;
		}
		return moved;
	}

	private async drain(): Promise<void> {
		try {
			while (this.wanted !== undefined) {
				const head = this.wanted;
				this.wanted = undefined;
				try {
					await this.archiveAllBut(head);
					this.archivedFor = head;
				} catch (error) {
					this.onArchiveError(error);
				}
			}
		} finally {
			this.running = undefined;
		}
	}
}
