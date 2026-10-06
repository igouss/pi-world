import type { SqliteDatabase, SqliteExecutor, SqliteValue } from "@earendil-works/pi-durable/storage/sqlite";

/**
 * pi-durable's asynchronous SQLite facade over a cell's synchronous `ctx.storage.sql`. Operations run one at a time in
 * arrival order, and a transaction holds the queue until it commits or rolls back, as the facade requires.
 */
export function cellDatabase(storage: DurableObjectStorage): SqliteDatabase {
	const direct = executor(storage.sql);
	let tail: Promise<unknown> = Promise.resolve();
	const queued = <T>(operation: () => Promise<T>): Promise<T> => {
		const result = tail.then(operation);
		tail = result.catch(() => undefined);
		return result;
	};
	return {
		exec: (sql) => queued(() => direct.exec(sql)),
		run: (sql, ...params) => queued(() => direct.run(sql, ...params)),
		get: (sql, ...params) => queued(() => direct.get(sql, ...params)),
		all: (sql, ...params) => queued(() => direct.all(sql, ...params)),
		transaction: (callback) => queued(() => storage.transaction(() => callback(direct))),
		close: async () => undefined,
	};
}

function executor(sql: SqlStorage): SqliteExecutor {
	const rows = (query: string, params: readonly SqliteValue[]): Record<string, SqlStorageValue>[] =>
		sql.exec(query, ...(params as SqlStorageValue[])).toArray();
	return {
		exec: async (query) => {
			sql.exec(query);
		},
		run: async (query, ...params) => {
			rows(query, params);
		},
		get: async <T extends object>(query: string, ...params: SqliteValue[]) => rows(query, params).map(fromSql)[0] as T | undefined,
		all: async <T extends object>(query: string, ...params: SqliteValue[]) => rows(query, params).map(fromSql) as T[],
	};
}

/** The cell returns BLOBs as ArrayBuffer; the facade speaks Uint8Array. */
function fromSql(row: Record<string, SqlStorageValue>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(row)) out[key] = value instanceof ArrayBuffer ? new Uint8Array(value) : value;
	return out;
}
