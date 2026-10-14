import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage, type JsonObject } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { openWorld } from "../src/cell/open-world.ts";
import { worldDeps } from "./world-deps.ts";

const call = (name: string, args: JsonObject) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });

async function setup() {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const { blobs, calls, workbench } = worldDeps();
	const opened = await openWorld({
		storage: new MemoryStorage(),
		blobs,
		calls,
		workbench,
		models,
		model: { provider: "faux", modelId: faux.getModel().id },
	});
	return { faux, ...opened };
}

async function ask(root: Awaited<ReturnType<typeof setup>>["root"], content: string) {
	const submission = await root.submit({ type: "input", content }, BACKGROUND_CONTEXT);
	return submission.wait(BACKGROUND_CONTEXT);
}

async function toolResults(root: Awaited<ReturnType<typeof setup>>["root"]): Promise<string[]> {
	const context = await root.context(BACKGROUND_CONTEXT);
	return context.messages
		.filter((message) => message.role === "toolResult")
		.map((message) => (message.content as { type: string; text?: string }[]).map((part) => part.text ?? "").join(""));
}

describe("the agent grows the world", () => {
	it("runs jiti's example session: two develops, an execute, a combination, then a direct call", async () => {
		const { faux, world, root } = await setup();
		faux.setResponses([
			call("develop", { source: `define("uppercaseString", (s) => s.toUpperCase(), { doc: "Uppercased copy" });`, summary: "add uppercaseString" }),
			fauxAssistantMessage("Added uppercaseString."),
			call("develop", { source: `define("reverseString", (s) => [...s].reverse().join(""), { doc: "Reversed copy" });`, summary: "add reverseString" }),
			fauxAssistantMessage("Added reverseString."),
			call("execute", { expression: `reverseString(uppercaseString("Hello"))` }),
			fauxAssistantMessage("OLLEH"),
			call("develop", { source: `define("shoutBackwards", (s) => reverseString(uppercaseString(s)));`, summary: "save shoutBackwards" }),
			fauxAssistantMessage("Saved."),
		]);
		expect((await ask(root, "Add uppercaseString.")).status).toBe("done");
		expect((await ask(root, "Add reverseString.")).status).toBe("done");
		expect((await ask(root, "Uppercase Hello, then reverse it.")).status).toBe("done");
		expect((await ask(root, "Save that as shoutBackwards.")).status).toBe("done");
		expect(await toolResults(root)).toEqual([
			"Accepted as revision 1: added uppercaseString.",
			"Accepted as revision 2: added reverseString.",
			`"OLLEH"`,
			"Accepted as revision 3: added shoutBackwards.",
		]);
		expect(world.catalogue().map((entry) => entry.name)).toEqual(["uppercaseString", "reverseString", "shoutBackwards"]);
		expect(await world.call("shoutBackwards", ["Hello"])).toEqual({ ok: true, value: "OLLEH" });
		expect(faux.state.callCount).toBe(8);
	});

	it("reports a rejected develop to the agent and leaves the world unchanged", async () => {
		const { faux, world, root } = await setup();
		faux.setResponses([
			call("develop", { source: `data.set("x", 1);`, summary: "write data" }),
			fauxAssistantMessage("That was rejected."),
		]);
		await ask(root, "Store x.");
		const [result] = await toolResults(root);
		expect(result).toContain("Rejected (host-call)");
		expect(world.head().revision).toBe(0);
	});

	it("lists rejected attempts in history, and says when there are none", async () => {
		const { faux, root } = await setup();
		faux.setResponses([
			call("history", { rejected: true }),
			fauxAssistantMessage("None."),
			call("develop", { source: `data.set("x", 1);`, summary: "write data" }),
			fauxAssistantMessage("That was rejected."),
			call("history", { rejected: true }),
			fauxAssistantMessage("One."),
			call("develop", { source: `define("one", () => 1);`, summary: "one" }),
			fauxAssistantMessage("Added."),
			call("develop", { source: `throw new Error("no");`, summary: "throw" }),
			fauxAssistantMessage("That was rejected too."),
			call("history", { rejected: true }),
			fauxAssistantMessage("Two."),
			call("history", {}),
			fauxAssistantMessage("Revisions."),
		]);
		await ask(root, "What was rejected?");
		await ask(root, "Store x.");
		await ask(root, "What was rejected now?");
		await ask(root, "Add one.");
		await ask(root, "Throw.");
		await ask(root, "And now?");
		await ask(root, "And the revisions?");
		const results = await toolResults(root);
		expect(results[0]).toBe("No attempt has been rejected.");
		expect(results[2]).toMatch(/^#0 on revision 0, develop: write data \(host-call\): a develop must not reach the outside world/);
		expect(results[5]?.split("\n")).toEqual([
			"#1 on revision 1, develop: throw (threw): Error: no",
			expect.stringMatching(/^#0 on revision 0, develop: write data \(host-call\)/),
		]);
		expect(results[6]).toBe("1 develop: one\n0 genesis: the prelude");
	});

	it("names the check a rejected develop broke in history", async () => {
		const { faux, world, root } = await setup();
		await world.develop(`define("one", () => 1);`, "one", { by: "operator" });
		await world.proposeCheck({ name: "one is 1", expression: "one() === 1", counterexample: `define("one", () => 2);` }, { by: "operator" });
		await world.develop(`define("one", () => 3);`, "three", { by: "operator" });
		faux.setResponses([call("history", { rejected: true, limit: 1 }), fauxAssistantMessage("Seen.")]);
		await ask(root, "What was rejected?");
		const [result] = await toolResults(root);
		expect(result).toMatch(/^#0 on revision 1, develop: three \(broke the check "one is 1"\): check "one is 1" failed/);
	});

	it("marks a rejected develop as an error and labels a refused check in history", async () => {
		const { faux, root } = await setup();
		faux.setResponses([
			call("develop", { source: `throw new Error("no");`, summary: "throw" }),
			fauxAssistantMessage("Rejected."),
			call("propose_check", { name: "vacuous", expression: "true", counterexample: `define("x", () => 1);` }),
			fauxAssistantMessage("Refused."),
			call("history", { rejected: true, limit: 1 }),
			fauxAssistantMessage("Seen."),
		]);
		await ask(root, "Throw.");
		await ask(root, "Check nothing.");
		await ask(root, "What was refused?");
		const context = await root.context(BACKGROUND_CONTEXT);
		const results = context.messages.filter((message) => message.role === "toolResult") as { isError?: boolean }[];
		expect(results.map((result) => result.isError === true)).toEqual([true, true, false]);
		expect((await toolResults(root))[2]).toMatch(/^#1 on revision 0, check: check "vacuous" \(refused\): the check still holds/);
	});

	it("describes what a definition calls and what calls it", async () => {
		const { faux, world, root } = await setup();
		await world.develop(`function add(a, b) { return a + b; }\nfunction sum(xs) { return xs.reduce(add, 0); }\nfunction total(xs) { return sum(xs); }`, "sums", { by: "operator" });
		faux.setResponses([call("describe", { name: "sum" }), fauxAssistantMessage("Seen.")]);
		await ask(root, "Describe sum.");
		const [result] = await toolResults(root);
		expect(result).toContain("calls: add\ncalled by: total");
	});

	it("describes one definition with its doc and revisions, and a removed one by its history", async () => {
		const { faux, world, root } = await setup();
		await world.develop(`define("a", () => 1);`, "add a", { by: "operator" });
		await world.develop(`/** Two. */ function b() { return 2; }`, "add b", { by: "operator" });
		await world.develop(`undefine("a");`, "drop a", { by: "operator" });
		faux.setResponses([call("describe", { name: "b" }), fauxAssistantMessage("b."), call("describe", { name: "a" }), fauxAssistantMessage("a.")]);
		await ask(root, "Describe b.");
		await ask(root, "Describe a.");
		const [b, a] = await toolResults(root);
		expect(b).toBe("function b() @1\ndoc: Two.\nsource:\nfunction b() { return 2; }\nrevisions:\n  2: add b");
		expect(a).toBe("a is not defined at revision 3.\nRevisions that touched it:\n  3: drop a\n  1: add a");
	});

	it("proposes a property check with a generator", async () => {
		const { faux, world, root } = await setup();
		await world.develop(`function double(x) { return 2 * x; }`, "double", { by: "operator" });
		faux.setResponses([
			call("propose_check", { name: "double is even", expression: "double(input) % 2 === 0", counterexample: `function double(x) { return x; }`, generator: { int: [-100, 100] } }),
			fauxAssistantMessage("Enrolled."),
		]);
		await ask(root, "Protect double.");
		expect(await toolResults(root)).toEqual([`Enrolled the check "double is even".`]);
		expect(world.checks().checks[0]?.generator).toEqual({ int: [-100, 100] });
	});

	it("lists open incidents, shows one in full, and retries one after a fix", async () => {
		const { faux, world, root } = await setup();
		await world.develop(`function half(n) { if (n % 2) throw new Error("odd"); return n / 2; }`, "half", { by: "operator" });
		faux.setResponses([
			call("incidents", {}),
			fauxAssistantMessage("None."),
			call("retry_incident", { n: 0 }),
			fauxAssistantMessage("Still failing."),
			call("incidents", {}),
			fauxAssistantMessage("One."),
			call("incidents", { n: 0 }),
			fauxAssistantMessage("Seen."),
			call("develop", { source: `function half(n) { return n / 2; }`, summary: "allow odd" }),
			call("retry_incident", { n: 0 }),
			fauxAssistantMessage("Fixed."),
			call("incidents", { n: 7 }),
			fauxAssistantMessage("No such."),
		]);
		await ask(root, "Any incidents?");
		await world.call("half", [3]);
		await ask(root, "Retry it.");
		await ask(root, "Any incidents now?");
		await ask(root, "Show it.");
		await ask(root, "Fix it.");
		await ask(root, "Show 7.");
		const results = await toolResults(root);
		expect(results[0]).toBe("No open incident.");
		expect(results[1]).toMatch(/^Still failing \(threw\): Error: odd/);
		expect(results[2]).toMatch(/^#0 half at revision 1, 1× \(threw\): Error: odd$/);
		expect(results[3]).toMatch(/^incident #0, open: half failed 1× \(threw\), last at revision 1, 1 failed retries\nargs: \[\n  3\n\]\nerror:\nError: odd/);
		expect(results[5]).toBe("Incident 0 closed: the call returned 1.5");
		expect((await world.incidents.get(0))?.resolution?.by).toBe("agent");
		expect(results[6]).toBe("No incident 7.");
		const errors = (await root.context(BACKGROUND_CONTEXT)).messages.filter((m) => m.role === "toolResult").map((m) => (m as { isError?: boolean }).isError === true);
		expect(errors).toEqual([false, true, false, false, false, false, true]);
	});

	it("lists only open incidents, and shows a closed one as closed", async () => {
		const { faux, world, root } = await setup();
		await world.develop(`function boom(x) { throw new Error("no"); }`, "boom", { by: "operator" });
		await world.call("boom", [1]);
		await world.incidents.close(0, "operator", { kind: "dismissed", reason: "seen" });
		await world.call("boom", ["y".repeat(70 * 1024)]);
		await world.develop(`function bang() { throw new Error("bang"); }`, "bang", { by: "operator" });
		await world.call("bang", []);
		faux.setResponses([call("incidents", {}), fauxAssistantMessage("One."), call("incidents", { n: 0 }), fauxAssistantMessage("Closed."), call("incidents", { n: 1 }), fauxAssistantMessage("Big.")]);
		await ask(root, "Open ones?");
		await ask(root, "Show 0.");
		await ask(root, "Show 1.");
		const [open, closed, big] = await toolResults(root);
		expect(open?.split("\n")).toEqual([expect.stringMatching(/^#2 bang/), expect.stringMatching(/^#1 boom/)]);
		expect(closed).toMatch(/^incident #0, closed \(dismissed\): boom failed 1×/);
		expect(big).toContain("args: not kept (too large)");
	});

	it("shows the world's definitions in the system prompt", async () => {
		const { faux, world, root } = await setup();
		await world.develop(`define("area", (w, h) => w * h, { doc: "Rectangle area" });`, "area", { by: "operator" });
		let system = "";
		faux.setResponses([
			(context) => {
				system = context.messages.filter((m) => m.role === "system").map((m) => JSON.stringify(m)).join("\n");
				return fauxAssistantMessage("ok");
			},
		]);
		await ask(root, "What is defined?");
		expect(system).toContain("area(w, h): Rectangle area");
		expect(system).toContain("Revision 1.");
	});

	it("answers a direct call without a model request or a conversation entry", async () => {
		const { faux, world, root } = await setup();
		await world.develop(`define("shout", (s) => s.toUpperCase());`, "shout", { by: "operator" });
		const before = (await root.context(BACKGROUND_CONTEXT)).entries.length;
		expect(await world.call("shout", ["hi"])).toEqual({ ok: true, value: "HI" });
		expect(faux.state.callCount).toBe(0);
		expect((await root.context(BACKGROUND_CONTEXT)).entries.length).toBe(before);
	});
});

