import type { DataPort, DataRow } from "../world/data-port.ts";

const LIST_LIMIT: number = 1000;

/**
 * The world's data store: one table in the world cell's SQLite. Synchronous, because world code calls it from
 * inside the VM, and the cell's SQL API is synchronous.
 */
export function sqlDataPort(sql: SqlStorage): DataPort {
	sql.exec("CREATE TABLE IF NOT EXISTS world_data (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
	return {
		get: (key) => sql.exec<{ value: string }>("SELECT value FROM world_data WHERE key = ?", key).toArray()[0]?.value,
		set: (key, json) => {
			sql.exec("INSERT INTO world_data (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, json);
		},
		delete: (key) => sql.exec("DELETE FROM world_data WHERE key = ?", key).rowsWritten > 0,
		list: (prefix) =>
			sql
				.exec<{ key: string; value: string }>(
					"SELECT key, value FROM world_data WHERE substr(key, 1, ?) = ? ORDER BY key LIMIT ?",
					prefix.length,
					prefix,
					LIST_LIMIT,
				)
				.toArray()
				.map((row): DataRow => ({ key: row.key, value: JSON.parse(row.value) as unknown })),
	};
}
