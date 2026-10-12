import type { Choices } from "./choices.ts";

export type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };

/**
 * How a property check's input is generated, written as JSON; parsing fills in the defaults shown:
 *
 * - `{ "int": [min, max] }`: an integer in [min, max], shrinking toward 0, or toward the bound nearer 0.
 * - `{ "bool": true }`: a boolean, shrinking toward false.
 * - `{ "string": { "max": 10, "alphabet": "ab" } }`: up to `max` characters from `alphabet` (letters, digits and
 *   punctuation), shrinking toward "".
 * - `{ "oneOf": [a, b, …] }`: one of the given values, shrinking toward the first.
 * - `{ "const": value }`: always `value`.
 * - `{ "array": element, "min": 0, "max": 10 }`: between `min` and `max` elements, shrinking toward fewer.
 * - `{ "record": { "key": generator, … } }`: an object with one generated value per key.
 */
export type Generator =
	| { readonly int: readonly [number, number] }
	| { readonly bool: true }
	| { readonly string: { readonly max: number; readonly alphabet: string } }
	| { readonly oneOf: readonly Json[] }
	| { readonly const: Json }
	| { readonly array: Generator; readonly min: number; readonly max: number }
	| { readonly record: { readonly [key: string]: Generator } };

/** The most elements an array or characters a string may have, so one input stays small. */
const MAX_SIZE: number = 100;
const DEFAULT_SIZE: number = 10;
const MAX_DEPTH: number = 8;
const ALPHABET: string = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 -_.,:;!?";

type Parsed = { readonly generator: Generator } | { readonly error: string };

const PARSERS = {
	int: (spec) => {
		const range = spec.int;
		if (!Array.isArray(range) || range.length !== 2 || !range.every(Number.isSafeInteger) || range[0] > range[1])
			return { error: `int takes [min, max], two integers with min <= max; got ${JSON.stringify(range)}` };
		return { generator: { int: [range[0], range[1]] } };
	},
	bool: (spec) => (spec.bool === true ? { generator: { bool: true } } : { error: `bool takes true; got ${JSON.stringify(spec.bool)}` }),
	string: (spec) => {
		const options = spec.string;
		if (options === null || typeof options !== "object" || Array.isArray(options)) return { error: "string takes an object: { max, alphabet }" };
		const { max = DEFAULT_SIZE, alphabet = ALPHABET } = options as { max?: unknown; alphabet?: unknown };
		if (!isSize(max)) return { error: `string max is an integer from 0 to ${MAX_SIZE}; got ${JSON.stringify(max)}` };
		if (typeof alphabet !== "string" || alphabet.length === 0) return { error: "string alphabet is a non-empty string" };
		return { generator: { string: { max, alphabet } } };
	},
	oneOf: (spec) => (Array.isArray(spec.oneOf) && spec.oneOf.length > 0 ? { generator: { oneOf: spec.oneOf as Json[] } } : { error: "oneOf takes a non-empty array of values" }),
	const: (spec) => ({ generator: { const: spec.const as Json } }),
	array: (spec, depth) => {
		const { min = 0, max = DEFAULT_SIZE } = spec as { min?: unknown; max?: unknown };
		if (!isSize(min) || !isSize(max) || min > max) return { error: `array min and max are integers from 0 to ${MAX_SIZE} with min <= max; got ${JSON.stringify({ min, max })}` };
		const element = parseGenerator(spec.array, depth + 1);
		return "error" in element ? { error: `array element: ${element.error}` } : { generator: { array: element.generator, min, max } };
	},
	record: (spec, depth) => {
		const fields = spec.record;
		if (fields === null || typeof fields !== "object" || Array.isArray(fields)) return { error: "record takes an object of generators" };
		const record: Record<string, Generator> = {};
		for (const [key, field] of Object.entries(fields)) {
			const parsed = parseGenerator(field, depth + 1);
			if ("error" in parsed) return { error: `record field ${key}: ${parsed.error}` };
			record[key] = parsed.generator;
		}
		return { generator: { record } };
	},
} satisfies Record<string, (spec: Record<string, unknown>, depth: number) => Parsed>;

const KINDS = Object.keys(PARSERS) as (keyof typeof PARSERS)[];

/** Check that a value is a generator and fill in its defaults, or name the first thing wrong with it. */
export function parseGenerator(value: unknown, depth: number = 0): Parsed {
	if (depth > MAX_DEPTH) return { error: `a generator may nest at most ${MAX_DEPTH} deep` };
	if (value === null || typeof value !== "object" || Array.isArray(value)) return { error: `a generator is an object, not ${JSON.stringify(value)}` };
	const spec = value as Record<string, unknown>;
	const kinds = KINDS.filter((kind) => kind in spec);
	if (kinds.length !== 1) return { error: `a generator has exactly one of ${KINDS.join(", ")}; got ${JSON.stringify(Object.keys(spec))}` };
	return PARSERS[kinds[0]!](spec, depth);
}

function isSize(value: unknown): value is number {
	return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= MAX_SIZE;
}

/** Generate one input from the choices. */
export function generate(generator: Generator, choices: Choices): Json {
	if ("int" in generator) return integer(choices.next(generator.int[1] - generator.int[0]), generator.int[0], generator.int[1]);
	if ("bool" in generator) return choices.next(1) === 1;
	if ("string" in generator) {
		const symbols = [...generator.string.alphabet];
		const length = choices.next(generator.string.max);
		return Array.from({ length }, () => symbols[choices.next(symbols.length - 1)]).join("");
	}
	if ("oneOf" in generator) return generator.oneOf[choices.next(generator.oneOf.length - 1)]!;
	if ("const" in generator) return generator.const;
	if ("array" in generator) {
		const length = generator.min + choices.next(generator.max - generator.min);
		return Array.from({ length }, () => generate(generator.array, choices));
	}
	return Object.fromEntries(Object.entries(generator.record).map(([key, field]) => [key, generate(field, choices)]));
}

/**
 * The integer in [min, max] that choice `c` (in [0, max - min]) stands for, ordered by distance from 0: 0, 1, -1, 2,
 * -2, … while both signs fit, then the remaining side. A smaller choice is a smaller number, so shrinking a choice
 * shrinks the number toward 0.
 */
export function integer(c: number, min: number, max: number): number {
	if (min >= 0) return min + c;
	if (max <= 0) return max - c;
	const both = Math.min(max, -min);
	if (c === 0) return 0;
	if (c <= 2 * both) return c % 2 === 1 ? (c + 1) / 2 : -c / 2;
	const rest = c - 2 * both;
	return max > both ? both + rest : -(both + rest);
}
