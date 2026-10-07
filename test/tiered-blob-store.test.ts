import { describe, expect, it } from "vitest";
import { MemoryBlobStore } from "../src/revision/blob-store.ts";
import { TieredBlobStore, type ArchiveStore } from "../src/revision/tiered-blob-store.ts";

const bytes = (n: number): Uint8Array => new Uint8Array([n, n, n]);

/** An archive that fails its first `failPuts` puts, as an object store can. */
function archive(failPuts: number = 0): ArchiveStore & { readonly blobs: MemoryBlobStore } {
	const blobs = new MemoryBlobStore();
	let failures = failPuts;
	return {
		blobs,
		put: async (hash, data) => {
			if (failures-- > 0) throw new Error("archive unavailable");
			await blobs.put(hash, data);
		},
		get: (hash) => blobs.get(hash),
		has: (hash) => blobs.has(hash),
	};
}

describe("TieredBlobStore", () => {
	it("keeps the head local and moves every other blob to the archive", async () => {
		const local = new MemoryBlobStore();
		const remote = archive();
		const store = new TieredBlobStore(local, remote);
		await store.put("a", bytes(1));
		await store.put("b", bytes(2));
		await store.put("head", bytes(3));
		expect(await store.archiveAllBut("head")).toEqual(2);
		expect(await local.hashes()).toEqual(["head"]);
		expect([...(await remote.blobs.hashes())].sort()).toEqual(["a", "b"]);
	});

	it("reads an archived blob from the archive", async () => {
		const store = new TieredBlobStore(new MemoryBlobStore(), archive());
		await store.put("old", bytes(7));
		await store.put("head", bytes(8));
		await store.archiveAllBut("head");
		expect(await store.get("old")).toEqual(bytes(7));
		expect(await store.get("missing")).toBeUndefined();
	});

	it("keeps a blob local when the archive fails, and moves it on the next pass", async () => {
		const local = new MemoryBlobStore();
		const store = new TieredBlobStore(local, archive(1));
		await store.put("old", bytes(1));
		await expect(store.archiveAllBut("head")).rejects.toThrow("archive unavailable");
		expect(await local.hashes()).toEqual(["old"]);
		expect(await store.archiveAllBut("head")).toEqual(1);
		expect(await local.hashes()).toEqual([]);
	});

	it("does nothing when only the head is local", async () => {
		const store = new TieredBlobStore(new MemoryBlobStore(), archive());
		await store.put("head", bytes(1));
		expect(await store.archiveAllBut("head")).toEqual(0);
	});
});
