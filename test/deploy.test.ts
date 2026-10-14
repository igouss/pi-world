import { describe, expect, it } from "vitest";
import { stamp } from "../scripts/deploy.ts";

describe("stamping a deploy", () => {
	it("sets the BUILD define to the revision, as a JavaScript string literal", () => {
		expect(stamp(`{ "define": { "BUILD": "\\"dev\\"" } }`, "d308981-dirty")).toBe(`{ "define": { "BUILD": "\\"d308981-dirty\\"" } }`);
	});

	it("refuses a config with no dev BUILD define, so an unstamped bundle is never deployed", () => {
		expect(() => stamp(`{ "define": {} }`, "d308981")).toThrow('wrangler.jsonc has no "BUILD": "\\"dev\\"" define to stamp');
	});
});
