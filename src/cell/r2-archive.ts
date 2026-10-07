import type { ArchiveStore } from "../revision/tiered-blob-store.ts";

/** Snapshot blobs in R2, gzipped (a 1.38 MB snapshot is about 110 KB), under `snapshots/<hash>.gz`. */
export function r2Archive(bucket: R2Bucket): ArchiveStore {
	const key = (hash: string): string => `snapshots/${hash}.gz`;
	return {
		put: async (hash, bytes) => {
			await bucket.put(key(hash), await gzip(bytes));
		},
		get: async (hash) => {
			const object = await bucket.get(key(hash));
			return object ? gunzip(object.body) : undefined;
		},
		has: async (hash) => (await bucket.head(key(hash))) !== null,
	};
}

async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
	const stream = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new CompressionStream("gzip"));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzip(body: ReadableStream): Promise<Uint8Array> {
	return new Uint8Array(await new Response(body.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
}
