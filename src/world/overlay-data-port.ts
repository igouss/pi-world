import { byKey, type DataPort, type DataRow, type DataStore } from "./data-port.ts";

/** What an evaluation wrote, as keys. */
export interface DataChanges {
	readonly set: readonly string[];
	readonly deleted: readonly string[];
}

/**
 * A data store that records writes instead of making them, and remembers what it read from the base store. Reads see
 * the base store through the recorded writes, so an evaluation behaves as if its writes happened; committing makes
 * them, if nothing it read has changed since, and dropping the overlay discards them. Works across awaits, which a
 * SQL transaction cannot.
 */
export class OverlayDataPort implements DataPort {
	/** Key to its JSON value, or null for a deletion. */
	private readonly writes: Map<string, string | null> = new Map();
	/** What each key read from the base held when it was read; `undefined` for a key that was absent. */
	private readonly keysRead: Map<string, string | undefined> = new Map();
	/** What each prefix listed from the base held when it was listed; compared only if the call commits writes. */
	private readonly prefixesRead: Map<string, readonly DataRow[]> = new Map();

	constructor(private readonly base: DataStore) {}

	get(key: string): string | undefined {
		if (this.writes.has(key)) return this.writes.get(key) ?? undefined;
		return this.readBase(key);
	}

	set(key: string, json: string): void {
		this.writes.set(key, json);
	}

	delete(key: string): boolean {
		const existed = this.get(key) !== undefined;
		this.writes.set(key, null);
		return existed;
	}

	list(prefix: string): readonly DataRow[] {
		const base = this.base.list(prefix);
		if (!this.prefixesRead.has(prefix)) this.prefixesRead.set(prefix, base);
		const mine = [...this.writes].filter(([key]) => key.startsWith(prefix));
		if (mine.length === 0) return base;
		const rows = new Map(base.map((row) => [row.key, row.value]));
		for (const [key, json] of mine) {
			if (json === null) rows.delete(key);
			else rows.set(key, JSON.parse(json) as unknown);
		}
		return [...rows].sort(([a], [b]) => byKey(a, b)).map(([key, value]) => ({ key, value }));
	}

	/**
	 * Make the recorded writes in the base store, in one transaction of it, if every key and prefix read from the base
	 * still holds what it held then; answers whether it did. A false answer made no write: another call changed what
	 * this one read, so its writes rest on a state that no longer exists, and it must run again to be serializable.
	 */
	commitIfUnchanged(): boolean {
		// A call that wrote nothing is serializable at the moment it read, whatever changed since.
		if (this.writes.size === 0) return true;
		let committed = false;
		this.base.transaction(() => {
			if (!this.unchanged()) return;
			this.apply();
			committed = true;
		});
		return committed;
	}

	private readBase(key: string): string | undefined {
		const value = this.base.get(key);
		if (!this.keysRead.has(key)) this.keysRead.set(key, value);
		return value;
	}

	private unchanged(): boolean {
		for (const [key, value] of this.keysRead) if (this.base.get(key) !== value) return false;
		for (const [prefix, rows] of this.prefixesRead) if (JSON.stringify(this.base.list(prefix)) !== JSON.stringify(rows)) return false;
		return true;
	}

	private apply(): void {
		for (const [key, json] of this.writes) {
			if (json === null) this.base.delete(key);
			else this.base.set(key, json);
		}
	}

	/** The recorded writes as keys, sorted. */
	changes(): DataChanges {
		const entries = [...this.writes].sort(([a], [b]) => byKey(a, b));
		return {
			set: entries.filter(([, json]) => json !== null).map(([key]) => key),
			deleted: entries.filter(([, json]) => json === null).map(([key]) => key),
		};
	}
}
