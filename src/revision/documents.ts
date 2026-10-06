import { defineDoc, defineDocFamily, type JsonObject } from "@earendil-works/pi-durable";
import type { Check, RemovedCheck } from "../check/check.ts";
import type { Head, Revision } from "./revision.ts";

/** -1 until the genesis revision is committed. */
export const WorldHead = defineDoc<Head & JsonObject>({
	kind: "world.head",
	version: 1,
	scope: "session",
	initial: () => ({ revision: -1, blob: "", calls: {} }),
});

export const WorldRevision = defineDocFamily<Revision & JsonObject, Revision & JsonObject>({
	kind: "world.revision",
	version: 1,
	scope: "session",
	family: true,
	initial: (seed) => seed,
});

export interface ChecksState {
	readonly checks: readonly Check[];
	readonly removed: readonly RemovedCheck[];
}

export const WorldChecks = defineDoc<ChecksState & JsonObject>({
	kind: "world.checks",
	version: 1,
	scope: "session",
	initial: () => ({ checks: [], removed: [] }),
});
