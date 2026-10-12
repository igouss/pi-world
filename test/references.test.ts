import { describe, expect, it } from "vitest";
import { references } from "../src/source/references.ts";

describe("references", () => {
	it("is empty for no definitions", () => {
		expect(references([])).toEqual(new Map());
	});

	it("gives one definition no calls, even when it recurses", () => {
		expect(references([{ name: "fact", source: "(n) => n < 2 ? 1 : n * fact(n - 1)" }]).get("fact")).toEqual({ calls: [], calledBy: [] });
	});

	it("links many definitions both ways, sorted", () => {
		const graph = references([
			{ name: "total", source: "(xs) => sum(xs.map(price))" },
			{ name: "average", source: "(xs) => sum(xs) / xs.length" },
			{ name: "sum", source: "(xs) => xs.reduce(add, 0)" },
			{ name: "add", source: "(a, b) => a + b" },
			{ name: "price", source: "(item) => item.price" },
		]);
		expect(graph.get("total")).toEqual({ calls: ["price", "sum"], calledBy: [] });
		expect(graph.get("add")).toEqual({ calls: [], calledBy: ["sum"] });
		expect(graph.get("sum")).toEqual({ calls: ["add"], calledBy: ["average", "total"] });
	});

	it("does not count a property, a key or a parameter named like a definition", () => {
		const graph = references([
			{ name: "price", source: "() => 1" },
			{ name: "label", source: "(price) => ({ price: 1 }).price" },
		]);
		expect(graph.get("label")).toEqual({ calls: [], calledBy: [] });
	});

	it("reads a class's methods", () => {
		const graph = references([
			{ name: "tax", source: "(x) => x / 10" },
			{ name: "Cart", source: "class Cart { #sum = 0; total() { this.#sum ??= 1; return tax(this.#sum); } }" },
		]);
		expect(graph.get("tax")).toEqual({ calls: [], calledBy: ["Cart"] });
	});

	it("gives a source that does not parse no calls", () => {
		expect(references([{ name: "native", source: "function native() { [native code] }" }]).get("native")).toEqual({ calls: [], calledBy: [] });
	});
});
