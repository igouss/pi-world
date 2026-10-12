import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { JsonObject, Session, SessionDocFamilyToken } from "@earendil-works/pi-durable";

/** How many entries a log keeps in memory by default; older ones are read again from storage. */
const CACHED: number = 256;

/**
 * A session document family numbered 0, 1, 2, …: the revisions or the rejections of a world. Entries are written once
 * by the owner's commit and never change, so a read can be cached.
 */
export class NumberedLog<T> {
	private readonly cache: Map<number, T> = new Map();

	constructor(
		private readonly session: Pick<Session, "snapshot">,
		private readonly family: SessionDocFamilyToken<T & JsonObject, T & JsonObject>,
		/** What an entry is called in an error, such as "revision". */
		private readonly noun: string,
		private readonly cached: number = CACHED,
	) {}

	async get(n: number): Promise<T | undefined> {
		const cached = this.cache.get(n);
		if (cached) return cached;
		const entry = (await this.session.snapshot(this.family, String(n), BACKGROUND_CONTEXT)) as T | undefined;
		if (entry) this.remember(n, entry);
		return entry;
	}

	async require(n: number): Promise<T> {
		const entry = await this.get(n);
		if (!entry) throw new Error(`no ${this.noun} ${n}`);
		return entry;
	}

	/** Up to `limit` entries numbered below `before` and below `end`, newest first. */
	newestFirst(end: number, limit: number, before?: number): Promise<T[]> {
		const top = Math.min(before ?? end, end) - 1;
		const count = Math.max(0, Math.min(limit, top + 1));
		return Promise.all(Array.from({ length: count }, (_, i) => this.require(top - i)));
	}

	/** Cache an entry its owner has just committed. */
	remember(n: number, entry: T): void {
		this.cache.set(n, entry);
		for (const oldest of this.cache.keys()) {
			if (this.cache.size <= this.cached) break;
			this.cache.delete(oldest);
		}
	}
}
