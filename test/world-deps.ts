import { createSession, MemoryStorage, type Session } from "@earendil-works/pi-durable";
import { MemoryBlobStore } from "../src/revision/blob-store.ts";
import { MemoryDataPort } from "../src/world/data-port.ts";
import { LocalCallRunner } from "../src/world/local-call-runner.ts";
import type { PeerPort } from "../src/world/peer-port.ts";
import type { WorldDeps } from "../src/world/world.ts";
import { wasm } from "./wasm.ts";

export type TestWorldDeps = WorldDeps & { readonly session: Session; readonly data: MemoryDataPort; readonly blobs: MemoryBlobStore; readonly calls: LocalCallRunner };

/** A world in memory with its calls in this process, as tests run it. */
export function worldDeps(options: { peers?: (chain: readonly string[]) => PeerPort; concurrentCalls?: number; now?: () => number } = {}): TestWorldDeps {
	const blobs = new MemoryBlobStore();
	const data = new MemoryDataPort();
	const calls = new LocalCallRunner({
		wasm,
		data,
		blob: async (hash) => {
			const bytes = await blobs.get(hash);
			if (!bytes) throw new Error(`no blob ${hash}`);
			return bytes;
		},
		...(options.peers ? { peers: options.peers } : {}),
		...(options.concurrentCalls ? { concurrentCalls: options.concurrentCalls } : {}),
	});
	return { session: createSession(new MemoryStorage()), blobs, data, calls, wasm, ...(options.now ? { now: options.now } : {}) };
}
