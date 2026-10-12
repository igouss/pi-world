import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, it } from "vitest";
import { Choices } from "../src/check/choices.ts";
import { generate, integer, parseGenerator, type Generator, type Json } from "../src/check/generator.ts";
import { mulberry32 } from "../src/world/random.ts";

/** A generator from JSON, with its defaults filled in. */
function parsed(spec: unknown): Generator {
	const result = parseGenerator(spec);
	if ("error" in result) throw new Error(result.error);
	return result.generator;
}

/** Any valid generator, nested up to `depth` deep. */
function generatorSpec(depth: number): gs.Generator<Generator> {
	return gs.composite<Generator>((tc) => {
		const kind = tc.draw(gs.sampledFrom(depth > 0 ? (["int", "bool", "string", "oneOf", "const", "array", "record"] as const) : (["int", "bool", "string", "oneOf", "const"] as const)));
		switch (kind) {
			case "int": {
				const a = tc.draw(gs.integers({ minValue: -1_000_000, maxValue: 1_000_000 }));
				const b = tc.draw(gs.integers({ minValue: -1_000_000, maxValue: 1_000_000 }));
				return { int: [Math.min(a, b), Math.max(a, b)] };
			}
			case "bool":
				return { bool: true };
			case "string":
				return { string: { max: tc.draw(gs.integers({ minValue: 0, maxValue: 100 })), alphabet: tc.draw(gs.text({ minSize: 1, maxSize: 5 })) } };
			case "oneOf":
				return { oneOf: tc.draw(gs.arrays(gs.integers(), { minSize: 1, maxSize: 4 })) };
			case "const":
				return { const: tc.draw(gs.text({ maxSize: 5 })) };
			case "array": {
				const a = tc.draw(gs.integers({ minValue: 0, maxValue: 100 }));
				const b = tc.draw(gs.integers({ minValue: 0, maxValue: 100 }));
				return { array: tc.draw(generatorSpec(depth - 1)), min: Math.min(a, b), max: Math.max(a, b) };
			}
			default:
				return { record: { a: tc.draw(generatorSpec(depth - 1)), b: tc.draw(generatorSpec(depth - 1)) } };
		}
	});
}

/** Whether `value` is something `generator` can produce. */
function fits(generator: Generator, value: Json): boolean {
	if ("int" in generator) return Number.isInteger(value) && (value as number) >= generator.int[0] && (value as number) <= generator.int[1];
	if ("bool" in generator) return typeof value === "boolean";
	if ("string" in generator)
		return typeof value === "string" && [...value].length <= generator.string.max && [...value].every((ch) => [...generator.string.alphabet].includes(ch));
	if ("oneOf" in generator) return generator.oneOf.some((option) => JSON.stringify(option) === JSON.stringify(value));
	if ("const" in generator) return JSON.stringify(value) === JSON.stringify(generator.const);
	if ("array" in generator)
		return Array.isArray(value) && value.length >= generator.min && value.length <= generator.max && value.every((element) => fits(generator.array, element));
	const record = value as Record<string, Json>;
	return Object.entries(generator.record).every(([key, field]) => key in record && fits(field, record[key]!));
}

describe("generators", () => {
	it("produce only values their spec allows, from any choices", () =>
		hegel.test((tc) => {
			const generator = tc.draw(generatorSpec(2));
			const prefix = tc.draw(gs.arrays(gs.integers({ minValue: 0, maxValue: 2_000_000 }), { maxSize: 50 }));
			const seed = tc.draw(gs.integers({ minValue: 0, maxValue: 2 ** 31 }));
			expect(fits(generator, generate(generator, new Choices(prefix, mulberry32(seed))))).toBe(true);
		}));

	it("give the same input when their recorded choices are replayed", () =>
		hegel.test((tc) => {
			const generator = tc.draw(generatorSpec(2));
			const seed = tc.draw(gs.integers({ minValue: 0, maxValue: 2 ** 31 }));
			const first = new Choices([], mulberry32(seed));
			const input = generate(generator, first);
			expect(generate(generator, new Choices(first.record()))).toEqual(input);
		}));

	it("parse back to themselves from JSON", () =>
		hegel.test((tc) => {
			const generator = tc.draw(generatorSpec(2));
			expect(parseGenerator(JSON.parse(JSON.stringify(generator)))).toEqual({ generator });
		}));

	it("generate true and strings from the choices they are given", () => {
		expect(generate({ bool: true }, new Choices([1]))).toBe(true);
		expect(generate({ string: { max: 10, alphabet: "ab" } }, new Choices([2, 0, 1]))).toBe("ab");
		expect(generate({ string: { max: 10, alphabet: "ab" } }, new Choices([2, 5, 5]))).toBe("bb");
		expect(generate(parsed({ string: {} }), new Choices([3, 0, 1, 26]))).toBe("abA");
		expect(generate({ oneOf: ["x", "y"] }, new Choices([1]))).toBe("y");
	});

	it("record exactly the draws they made", () => {
		const choices = new Choices([5, 9]);
		generate({ array: { bool: true }, min: 0, max: 3 }, choices);
		expect(choices.record()).toEqual([3, 1, 0, 0]);
	});

	it("generate the simplest value from no choices", () => {
		const record = parsed({ record: { n: { int: [-5, 5] }, ok: { bool: true }, s: { string: {} }, xs: { array: { int: [3, 9] }, min: 2 } } });
		expect(generate(record, new Choices([]))).toEqual({ n: 0, ok: false, s: "", xs: [3, 3] });
	});
});

describe("integer", () => {
	it("maps the choices of a range one to one onto the range, nearest to 0 first", () =>
		hegel.test((tc) => {
			const a = tc.draw(gs.integers({ minValue: -50, maxValue: 50 }));
			const b = tc.draw(gs.integers({ minValue: -50, maxValue: 50 }));
			const [min, max] = [Math.min(a, b), Math.max(a, b)];
			const values = Array.from({ length: max - min + 1 }, (_, c) => integer(c, min, max));
			expect([...values].sort((x, y) => x - y)).toEqual(Array.from({ length: max - min + 1 }, (_, i) => min + i));
			expect(values.map(Math.abs)).toEqual([...values.map(Math.abs)].sort((x, y) => x - y));
		}));

	it("starts at 0 when 0 is in range, and at the bound nearer 0 otherwise", () => {
		expect(Object.is(integer(0, -3, 3), 0)).toBe(true);
		expect(integer(0, 4, 9)).toBe(4);
		expect(integer(0, -9, -4)).toBe(-4);
	});
});

describe("parseGenerator", () => {
	it("refuses what is not a generator, saying why", () => {
		expect(parseGenerator(null)).toEqual({ error: "a generator is an object, not null" });
		expect(parseGenerator({})).toEqual({ error: "a generator has exactly one of int, bool, string, oneOf, const, array, record; got []" });
		expect(parseGenerator({ int: [1, 2], bool: true })).toMatchObject({ error: expect.stringContaining("exactly one") });
		expect(parseGenerator({ int: [3, 1] })).toMatchObject({ error: expect.stringContaining("min <= max") });
		expect(parseGenerator({ int: [0.5, 1] })).toMatchObject({ error: expect.stringContaining("two integers") });
		expect(parseGenerator({ bool: 1 })).toMatchObject({ error: "bool takes true; got 1" });
		expect(parseGenerator({ string: { max: 101 } })).toMatchObject({ error: expect.stringContaining("from 0 to 100") });
		expect(parseGenerator({ string: { alphabet: "" } })).toEqual({ error: "string alphabet is a non-empty string" });
		expect(parseGenerator({ string: "x" })).toEqual({ error: "string takes an object: { max, alphabet }" });
		expect(parseGenerator({ oneOf: [] })).toEqual({ error: "oneOf takes a non-empty array of values" });
		expect(parseGenerator({ array: { bool: true }, min: 5, max: 2 })).toMatchObject({ error: expect.stringContaining("min <= max") });
		expect(parseGenerator({ array: { bool: false } })).toEqual({ error: "array element: bool takes true; got false" });
		expect(parseGenerator({ record: { a: { int: [1] } } })).toMatchObject({ error: expect.stringContaining("record field a: int takes") });
		expect(parseGenerator({ record: [] })).toEqual({ error: "record takes an object of generators" });
	});

	it("refuses a value of the wrong type at every level", () => {
		expect(parseGenerator(5)).toEqual({ error: "a generator is an object, not 5" });
		expect(parseGenerator({ string: 5 })).toEqual({ error: "string takes an object: { max, alphabet }" });
		expect(parseGenerator({ string: null })).toEqual({ error: "string takes an object: { max, alphabet }" });
		expect(parseGenerator({ string: { alphabet: 5 } })).toEqual({ error: "string alphabet is a non-empty string" });
		expect(parseGenerator({ record: 5 })).toEqual({ error: "record takes an object of generators" });
		expect(parseGenerator({ record: null })).toEqual({ error: "record takes an object of generators" });
		expect(parseGenerator({ array: { bool: true }, min: -1 })).toEqual({ error: `array min and max are integers from 0 to 100 with min <= max; got {"min":-1,"max":10}` });
		expect(parseGenerator({ array: { bool: true }, max: 0.5 })).toMatchObject({ error: expect.stringContaining("integers from 0 to 100") });
		expect(parseGenerator({ string: { max: -1 } })).toMatchObject({ error: expect.stringContaining("from 0 to 100") });
	});

	it("accepts sizes up to 100 and nesting up to 8", () => {
		expect(parseGenerator({ string: { max: 100 } })).toMatchObject({ generator: { string: { max: 100 } } });
		expect(parseGenerator({ array: { bool: true }, min: 2, max: 2 })).toEqual({ generator: { array: { bool: true }, min: 2, max: 2 } });
		const eight = { array: { array: { array: { array: { array: { array: { array: { array: { bool: true } } } } } } } } };
		expect(parseGenerator(eight)).toMatchObject({ generator: expect.anything() });
		const deepRecord = Array.from({ length: 9 }).reduce<unknown>((inner) => ({ record: { a: inner } }), { bool: true });
		expect(parseGenerator(deepRecord)).toMatchObject({ error: expect.stringContaining("at most 8 deep") });
	});

	it("refuses nesting deeper than 8", () => {
		const deep = { array: { array: { array: { array: { array: { array: { array: { array: { array: { bool: true } } } } } } } } } };
		expect(parseGenerator(deep)).toMatchObject({ error: expect.stringContaining("at most 8 deep") });
	});

	it("fills in an array's default bounds", () => {
		expect(parseGenerator({ array: { bool: true } })).toEqual({ generator: { array: { bool: true }, min: 0, max: 10 } });
	});
});
