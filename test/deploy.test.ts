import { describe, expect, it } from "vitest";
import { refuseChanges, stamp } from "../scripts/deploy.ts";

describe("stamping a deploy", () => {
	it("sets the BUILD define to the revision, as a JavaScript string literal", () => {
		expect(stamp(`{ "define": { "BUILD": "\\"dev\\"" } }`, "d308981-dirty")).toBe(`{ "define": { "BUILD": "\\"d308981-dirty\\"" } }`);
	});

	it("refuses a config with no dev BUILD define, so an unstamped bundle is never deployed", () => {
		expect(() => stamp(`{ "define": {} }`, "d308981")).toThrow('wrangler.jsonc has no "BUILD": "\\"dev\\"" define to stamp');
	});
});

describe("deploying only what is committed", () => {
	it("accepts a working tree with no changes", () => {
		expect(() => refuseChanges("")).not.toThrow();
	});

	it("refuses a working tree with one change, naming it", () => {
		expect(() => refuseChanges(" M src/worker.ts\n")).toThrow("commit or stash these changes before deploying:\n M src/worker.ts");
	});

	it("refuses a working tree with many changes, naming each, untracked files among them", () => {
		expect(() => refuseChanges(" M src/worker.ts\n?? cli/new.ts\n")).toThrow("commit or stash these changes before deploying:\n M src/worker.ts\n?? cli/new.ts");
	});
});
