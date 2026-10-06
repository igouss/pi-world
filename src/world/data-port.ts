/**
 * The world's data store, reached from world code through `data.get/set/delete/list`.
 * Synchronous, because world code calls it from inside the VM. Values are JSON text.
 */
export interface DataPort {
	get(key: string): string | undefined;
	set(key: string, json: string): void;
	delete(key: string): boolean;
	list(prefix: string): readonly DataRow[];
}

export interface DataRow {
	readonly key: string;
	readonly value: unknown;
}

/** A data store held in memory; used by tests and by checks, which must not reach real data. */
export class MemoryDataPort implements DataPort {
	private readonly rows: Map<string, string> = new Map();

	get(key: string): string | undefined {
		return this.rows.get(key);
	}

	set(key: string, json: string): void {
		this.rows.set(key, json);
	}

	delete(key: string): boolean {
		return this.rows.delete(key);
	}

	list(prefix: string): readonly DataRow[] {
		return [...this.rows]
			.filter(([key]) => key.startsWith(prefix))
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([key, json]) => ({ key, value: JSON.parse(json) as unknown }));
	}
}
