import { describe, expect, it } from "vitest";
import { rememberCall } from "../src/world/remember-call.ts";

describe("rememberCall", () => {
	it("records the first call", () => {
		const calls: Record<string, number> = {};
		rememberCall(calls, "a", 0, 2);
		expect(calls).toEqual({ a: 0 });
	});

	it("keeps calls up to the limit", () => {
		const calls: Record<string, number> = { a: 0 };
		rememberCall(calls, "b", 1, 2);
		expect(calls).toEqual({ a: 0, b: 1 });
	});

	it("drops the oldest calls beyond the limit", () => {
		const calls: Record<string, number> = { a: 0, b: 1 };
		rememberCall(calls, "c", 2, 2);
		expect(calls).toEqual({ b: 1, c: 2 });
	});
});
