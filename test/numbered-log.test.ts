import { defineDocFamily, type JsonObject, type Session } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { NumberedLog } from "../src/revision/numbered-log.ts";

interface Entry {
	readonly n: number;
}

const Family = defineDocFamily<Entry & JsonObject, Entry & JsonObject>({ kind: "test.entry", version: 1, scope: "session", family: true, initial: (seed) => seed });

/** A session holding entries 0 to `count - 1`, counting the reads that reach it. */
function store(count: number): { session: Pick<Session, "snapshot">; reads: string[] } {
	const reads: string[] = [];
	const snapshot = (async (_token: unknown, key: string) => {
		reads.push(key);
		const n = Number(key);
		return n < count ? { n } : undefined;
	}) as unknown as Session["snapshot"];
	return { session: { snapshot }, reads };
}

describe("NumberedLog", () => {
	it("lists nothing when it is empty", async () => {
		const log = new NumberedLog<Entry>(store(0).session, Family, "entry");
		expect(await log.newestFirst(0, 10)).toEqual([]);
		expect(await log.get(0)).toBeUndefined();
	});

	it("lists its one entry", async () => {
		const log = new NumberedLog<Entry>(store(1).session, Family, "entry");
		expect(await log.newestFirst(1, 10)).toEqual([{ n: 0 }]);
	});

	it("lists many entries newest first, at most `limit`, below `before`", async () => {
		const log = new NumberedLog<Entry>(store(5).session, Family, "entry");
		expect(await log.newestFirst(5, 3)).toEqual([{ n: 4 }, { n: 3 }, { n: 2 }]);
		expect(await log.newestFirst(5, 3, 2)).toEqual([{ n: 1 }, { n: 0 }]);
		expect(await log.newestFirst(5, 3, 9)).toEqual([{ n: 4 }, { n: 3 }, { n: 2 }]);
	});

	it("names a missing entry it was asked to require", async () => {
		const log = new NumberedLog<Entry>(store(1).session, Family, "entry");
		await expect(log.require(3)).rejects.toThrow("no entry 3");
	});

	it("reads an entry from storage once, then from its cache", async () => {
		const { session, reads } = store(2);
		const log = new NumberedLog<Entry>(session, Family, "entry");
		await log.get(1);
		await log.get(1);
		expect(reads).toEqual(["1"]);
	});

	it("serves a remembered entry without reading storage", async () => {
		const { session, reads } = store(0);
		const log = new NumberedLog<Entry>(session, Family, "entry");
		log.remember(7, { n: 7 });
		expect(await log.get(7)).toEqual({ n: 7 });
		expect(reads).toEqual([]);
	});

	it("drops the oldest cached entry beyond its size", async () => {
		const { session, reads } = store(3);
		const log = new NumberedLog<Entry>(session, Family, "entry", 2);
		log.remember(0, { n: 0 });
		log.remember(1, { n: 1 });
		log.remember(2, { n: 2 });
		await log.get(0);
		await log.get(2);
		expect(reads).toEqual(["0"]);
	});
});
