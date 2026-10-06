import type { SqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite";
import type { BlobStore } from "../revision/blob-store.ts";

/** Snapshot blobs in the world cell's own SQLite, through the same queue as pi-durable's writes. */
export async function sqlBlobStore(db: SqliteDatabase): Promise<BlobStore> {
	await db.exec("CREATE TABLE IF NOT EXISTS world_blob (hash TEXT PRIMARY KEY, bytes BLOB NOT NULL)");
	return {
		put: (hash, bytes) => db.run("INSERT OR IGNORE INTO world_blob (hash, bytes) VALUES (?, ?)", hash, bytes),
		get: async (hash) => (await db.get<{ bytes: Uint8Array }>("SELECT bytes FROM world_blob WHERE hash = ?", hash))?.bytes,
	};
}
