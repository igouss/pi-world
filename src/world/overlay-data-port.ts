import { byKey, type DataPort, type DataRow } from "./data-port.ts";

/** What an evaluation wrote, as keys. */
export interface DataChanges {
	readonly set: readonly string[];
	readonly deleted: readonly string[];
}

/**
 * A data store that records writes instead of making them. Reads see the base store through the recorded writes, so
 * an evaluation behaves as if its writes happened; dropping the overlay discards them. Works across awaits, which a
 * SQL transaction cannot.
 */
export class OverlayDataPort implements DataPort {
	/** Key to its JSON value, or null for a deletion. */
	private readonly writes: Map<string, string | null> = new Map();

	constructor(private readonly base: DataPort) {}

	get(key: string): string | undefined {
		return this.writes.has(key) ? (this.writes.get(key) ?? undefined) : this.base.get(key);
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
		const rows = new Map(this.base.list(prefix).map((row) => [row.key, row.value]));
		for (const [key, json] of this.writes) {
			if (!key.startsWith(prefix)) continue;
			if (json === null) rows.delete(key);
			else rows.set(key, JSON.parse(json) as unknown);
		}
		return [...rows].sort(([a], [b]) => byKey(a, b)).map(([key, value]) => ({ key, value }));
	}

	/** The writes that were discarded, sorted by key. */
	changes(): DataChanges {
		const entries = [...this.writes].sort(([a], [b]) => byKey(a, b));
		return {
			set: entries.filter(([, json]) => json !== null).map(([key]) => key),
			deleted: entries.filter(([, json]) => json === null).map(([key]) => key),
		};
	}
}
