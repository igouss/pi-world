/** Snapshot blobs, addressed by the SHA-256 of their bytes. `put` is idempotent. */
export interface BlobStore {
	put(hash: string, bytes: Uint8Array): Promise<void>;
	get(hash: string): Promise<Uint8Array | undefined>;
}

export async function contentHash(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export class MemoryBlobStore implements BlobStore {
	private readonly blobs: Map<string, Uint8Array> = new Map();

	async put(hash: string, bytes: Uint8Array): Promise<void> {
		if (!this.blobs.has(hash)) this.blobs.set(hash, bytes.slice());
	}

	async get(hash: string): Promise<Uint8Array | undefined> {
		return this.blobs.get(hash);
	}
}
