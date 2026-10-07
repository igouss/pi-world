import type { DataPort, DataRow } from "../../world/data-port.ts";
import type { DataRecord } from "../host-api.ts";

const LIST_LIMIT: number = 1000;
const TABLE: string = "world_data";

/**
 * A world's data store: one table in a SQLite database, the runtime facet's. Synchronous, because world code calls it
 * from inside the VM, and the SQL API is synchronous.
 */
export function sqlDataPort(sql: SqlStorage): DataPort {
	sql.exec(`CREATE TABLE IF NOT EXISTS ${TABLE} (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
	return {
		get: (key) => sql.exec<{ value: string }>(`SELECT value FROM ${TABLE} WHERE key = ?`, key).toArray()[0]?.value,
		set: (key, json) => {
			sql.exec(`INSERT INTO ${TABLE} (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, key, json);
		},
		delete: (key) => sql.exec(`DELETE FROM ${TABLE} WHERE key = ?`, key).rowsWritten > 0,
		list: (prefix) =>
			sql
				.exec<{ key: string; value: string }>(`SELECT key, value FROM ${TABLE} WHERE substr(key, 1, ?) = ? ORDER BY key LIMIT ?`, prefix.length, prefix, LIST_LIMIT)
				.toArray()
				.map((row): DataRow => ({ key: row.key, value: JSON.parse(row.value) as unknown })),
	};
}

/** Every row of a database's data table, unlimited; none when the database has no such table. */
export function sqlDataRecords(sql: SqlStorage): DataRecord[] {
	const exists = sql.exec<{ n: number }>("SELECT count(*) AS n FROM sqlite_master WHERE name = ?", TABLE).one().n > 0;
	if (!exists) return [];
	return sql.exec<{ key: string; value: string }>(`SELECT key, value FROM ${TABLE}`).toArray().map(({ key, value }) => ({ key, json: value }));
}
