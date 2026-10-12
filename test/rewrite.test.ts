import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, it } from "vitest";
import { rewriteSource } from "../src/source/rewrite.ts";
import { WorldVm } from "../src/world/world-vm.ts";
import { wasm } from "./wasm.ts";

const attempt = { kind: "attempt", at: 1_750_000_000_000, seed: 1 } as const;

/** Identifiers that are never keywords or prelude names. */
const functionName = gs.fromRegex("f_[a-z0-9]{1,6}");
const className = gs.fromRegex("C_[a-z0-9]{1,6}");
const docText = gs.fromRegex("[A-Za-z][A-Za-z ,.]{0,30}");

type Statement =
	| { readonly kind: "function"; readonly name: string; readonly doc: string | null; readonly value: number }
	| { readonly kind: "class"; readonly name: string; readonly doc: string | null }
	| { readonly kind: "other"; readonly text: string };

const statement = gs.composite<Statement>((tc) => {
	const kind = tc.draw(gs.sampledFrom(["function", "class", "other"] as const));
	if (kind === "function")
		return { kind, name: tc.draw(functionName), doc: tc.draw(gs.optional(docText)), value: tc.draw(gs.integers({ minValue: -1000, maxValue: 1000 })) };
	if (kind === "class") return { kind, name: tc.draw(className), doc: tc.draw(gs.optional(docText)) };
	return { kind, text: tc.draw(gs.sampledFrom(["var local = 1;", "// a comment", "", "state(\"s\", () => ({}));", "/* block */"])) };
});

/** A develop source; distinct names, so each declaration defines its own name. */
const program = gs.composite((tc) => {
	const statements = tc.draw(gs.arrays(statement, { maxSize: 8 }));
	const seen = new Set<string>();
	return statements.filter((s) => s.kind === "other" || (!seen.has(s.name) && seen.add(s.name)));
});

function render(statements: readonly Statement[]): string {
	return statements
		.map((s) => {
			if (s.kind === "other") return s.text;
			const doc = s.doc === null ? "" : `/** ${s.doc} */\n`;
			if (s.kind === "function") return `${doc}function ${s.name}() {\n\treturn ${s.value};\n}`;
			return `${doc}class ${s.name} {\n\tvalue() { return 1; }\n}`;
		})
		.join("\n");
}

const declared = (statements: readonly Statement[], kind: "function" | "class"): string[] =>
	statements.flatMap((s) => (s.kind === kind ? [s.name] : []));

describe("rewriteSource", () => {
	it("never throws, and returns any source that does not parse unchanged", () =>
		hegel.test((tc) => {
			const text = tc.draw(gs.text());
			const rewritten = rewriteSource(text);
			if (!/\b(function|class)\b/.test(text)) expect(rewritten).toBe(text);
		}));

	it("keeps every line where it was", () =>
		hegel.test((tc) => {
			const source = render(tc.draw(program));
			expect(rewriteSource(source).split("\n").length).toBe(source.split("\n").length);
		}));

	it("defines exactly the top-level functions and classes, functions first", () =>
		hegel.testAsync(
			async (tc) => {
				const statements = tc.draw(program);
				const vm = await vmWith(rewriteSource(render(statements)));
				const names = vm.catalogue().map((entry) => entry.name);
				vm.dispose();
				expect(names).toEqual([...declared(statements, "function"), ...declared(statements, "class")]);
			},
			{ testCases: 30 },
		));

	it("gives each declaration its JSDoc as its doc", () =>
		hegel.testAsync(
			async (tc) => {
				const statements = tc.draw(program);
				const vm = await vmWith(rewriteSource(render(statements)));
				const docs = Object.fromEntries(vm.catalogue().map((entry) => [entry.name, entry.doc]));
				vm.dispose();
				expect(docs).toEqual(Object.fromEntries(statements.flatMap((s) => (s.kind === "other" ? [] : [[s.name, s.doc?.trim() ?? ""]]))));
			},
			{ testCases: 30 },
		));

	it("routes a function's references inside its own source through the registry, so a redefinition reaches them", () =>
		hegel.testAsync(
			async (tc) => {
				const statements = tc.draw(program).filter((s) => s.kind === "function");
				const callers = statements.map((s) => `function call_${s.name}() { return ${s.name}(); }`).join("\n");
				const vm = await vmWith(rewriteSource(`${render(statements)}\n${callers}`));
				const redefined = vm.develop(statements.map((s) => `define("${s.name}", () => ${s.value + 1});`).join("\n"), attempt);
				expect(redefined.ok).toBe(true);
				const results = statements.map((s) => vm.develop(`if (call_${s.name}() !== ${s.value + 1}) throw new Error("stale");`, attempt).ok);
				vm.dispose();
				expect(results.every(Boolean)).toBe(true);
			},
			{ testCases: 30 },
		));
});

describe("rewriteSource examples", () => {
	it("returns a source that does not parse unchanged, defining nothing", () => {
		expect(rewriteSource("function (")).toBe("function (");
	});

	it("parses a source that returns early, as a function body may", () => {
		expect(rewriteSource("function a() {}\nreturn;")).toBe(`var a = define("a", a); function a() {}\nreturn;`);
	});

	it("takes a doc that ends right at the declaration", () => {
		expect(rewriteSource("/** Tight. */function a() {}")).toContain(`{ doc: "Tight." }`);
	});

	it("takes no doc from a line comment or a plain block comment", () => {
		expect(rewriteSource("//* not a doc\nfunction a() {}").split("\n")[0]).toBe(`var a = define("a", a); //* not a doc`);
		expect(rewriteSource("/* not a doc */\nfunction a() {}").split("\n")[0]).toBe(`var a = define("a", a); /* not a doc */`);
	});

	it("reads a doc line that has no leading star", () => {
		expect(rewriteSource("/**\n  Plain text.\n*/\nfunction a() {}")).toContain(`{ doc: "Plain text." }`);
	});

	it("joins a doc's lines, trimmed, up to its first blank line", () => {
		const doc = "/**\n   *   Totals  the cart,  \n   *including tax.\n   *\n   * Details nobody reads.\n   */\nfunction total() {}";
		expect(rewriteSource(doc)).toContain(`{ doc: "Totals  the cart, including tax." }`);
	});

	it("leaves a source without declarations alone", () => {
		expect(rewriteSource(`define("x", () => 1);`)).toBe(`define("x", () => 1);`);
	});

	it("puts the definitions after a use-strict directive", () => {
		expect(rewriteSource(`"use strict";\nfunction a() {}`)).toBe(`"use strict";var a = define("a", a); \nfunction a() {}`);
	});

	it("stops a doc at its first tag", () => {
		const source = rewriteSource(`/**\n * Adds one.\n * @param x a number\n */\nfunction inc(x) { return x + 1; }`);
		expect(source.split("\n")[0]).toBe(`var inc = define("inc", inc, { doc: "Adds one." }); /**`);
	});
});

async function vmWith(source: string): Promise<WorldVm> {
	const vm = await WorldVm.create(wasm);
	const developed = vm.develop(source, attempt);
	if (!developed.ok) throw new Error(`${developed.error}\n${source}`);
	return vm;
}
