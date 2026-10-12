import { parse, type Comment, type Node, type Program } from "acorn";

/**
 * Turn the top-level `function` and `class` declarations of a develop source into definitions, so the agent can write
 * ordinary JavaScript. A JSDoc comment right before a declaration becomes its doc.
 *
 * - `function f(…) {…}` stays where it is, hoisted as before, and the first line gains `var f = define("f", f);`.
 *   Every reference to `f` in the source, including its own recursion, then goes through the stub, so a later
 *   redefinition reaches it.
 * - `class C … {…}` becomes `const C = define("C", class C … {…});` in place.
 *
 * Nothing else changes, and no line moves, so an error's line number points into the source as written. A source
 * that does not parse is returned unchanged; its evaluation reports the syntax error.
 */
export function rewriteSource(source: string): string {
	const comments: Comment[] = [];
	let program: Program;
	try {
		program = parse(source, { ecmaVersion: "latest", sourceType: "script", allowReturnOutsideFunction: true, onComment: comments });
	} catch {
		return source;
	}
	const functions = new Map<string, string>();
	const edits: Edit[] = [];
	for (const statement of program.body) {
		if (statement.type === "FunctionDeclaration") {
			functions.set(statement.id.name, `var ${statement.id.name} = define(${JSON.stringify(statement.id.name)}, ${statement.id.name}${options(docBefore(statement, comments, source))});`);
		} else if (statement.type === "ClassDeclaration" && statement.id) {
			const name = statement.id.name;
			edits.push({ at: statement.start, text: `const ${name} = define(${JSON.stringify(name)}, ` });
			edits.push({ at: statement.end, text: `${options(docBefore(statement, comments, source))});` });
		}
	}
	if (functions.size > 0) edits.push({ at: afterDirectives(program), text: [...functions.values()].join(" ") + " " });
	return apply(source, edits);
}

interface Edit {
	readonly at: number;
	readonly text: string;
}

/** Insert every edit, later positions first so earlier offsets stay valid. */
function apply(source: string, edits: readonly Edit[]): string {
	let out = source;
	for (const edit of [...edits].sort((a, b) => b.at - a.at)) out = out.slice(0, edit.at) + edit.text + out.slice(edit.at);
	return out;
}

/** Where code may go without breaking a leading `"use strict"`: after the directive prologue, else the start. */
function afterDirectives(program: Program): number {
	let at = 0;
	for (const statement of program.body) {
		if (statement.type !== "ExpressionStatement" || !("directive" in statement) || statement.directive === undefined) break;
		at = statement.end;
	}
	return at;
}

function options(doc: string | undefined): string {
	return doc === undefined ? "" : `, { doc: ${JSON.stringify(doc)} }`;
}

/** The text of a `/** … *\/` comment that ends right before `node`, up to its first blank line or `@` tag. */
function docBefore(node: Node, comments: readonly Comment[], source: string): string | undefined {
	const comment = comments.findLast((c) => c.end <= node.start);
	if (!comment || comment.type !== "Block" || !comment.value.startsWith("*")) return undefined;
	if (source.slice(comment.end, node.start).trim() !== "") return undefined;
	const lines = comment.value
		.slice(1)
		.split("\n")
		.map((line) => line.replace(/^\s*\*?/, "").trim());
	const body: string[] = [];
	for (const line of lines) {
		if (line.startsWith("@")) break;
		if (line === "" && body.length > 0) break;
		if (line !== "") body.push(line);
	}
	return body.length ? body.join(" ") : undefined;
}
