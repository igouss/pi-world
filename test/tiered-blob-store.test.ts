import { describe, expect, it } from "vitest";
import { MemoryBlobStore } from "../src/revision/blob-store.ts";
import { TieredBlobStore } from "../src/revision/tiered-blob-store.ts";

const bytes = (n: number): Uint8Array => new Uint8Array([n, n, n]);

/** An archive that fails its first `failPuts` puts, as an object store can, and counts the puts it accepts. */
class Archive extends MemoryBlobStore {
	puts: number = 0;

	constructor(private failures: number = 0) {
		super();
	}

	override async put(hash: string, bytes: Uint8Array): Promise<void> {
		if (this.failures-- > 0) throw new Error("archive unavailable");
		this.puts++;
		await super.put(hash, bytes);
	}
}

const archive = (failPuts: number = 0): Archive => new Archive(failPuts);

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
		expect([...(await remote.hashes())].sort()).toEqual(["a", "b"]);
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

	it("collapses archive requests made during a pass into one more pass for the newest head", async () => {
		const local = new MemoryBlobStore();
		const remote = archive();
		const store = new TieredBlobStore(local, remote);
		await store.put("r1", bytes(1));
		await store.put("r2", bytes(2));
		const first = store.archiveFor("r2");
		await store.put("r3", bytes(3));
		void store.archiveFor("r3");
		await store.put("r4", bytes(4));
		await store.archiveFor("r4");
		await first;
		expect(await local.hashes()).toEqual(["r4"]);
		expect(remote.puts).toBe(3);
		await store.archiveFor("r4");
		expect(remote.puts).toBe(3);
	});

	it("reports a failed background pass and archives on the next request", async () => {
		const errors: unknown[] = [];
		const local = new MemoryBlobStore();
		const store = new TieredBlobStore(local, archive(1), (error) => errors.push(error));
		await store.put("old", bytes(1));
		await store.archiveFor("head");
		expect(errors).toHaveLength(1);
		expect(await local.hashes()).toEqual(["old"]);
		await store.archiveFor("head");
		expect(await local.hashes()).toEqual([]);
	});
});

