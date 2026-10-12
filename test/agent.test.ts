import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage, type JsonObject } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { openWorld } from "../src/cell/open-world.ts";
import { wasm } from "./wasm.ts";
import { worldDeps } from "./world-deps.ts";

const call = (name: string, args: JsonObject) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });

async function setup() {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const { blobs, calls } = worldDeps();
	const opened = await openWorld({
		storage: new MemoryStorage(),
		blobs,
		calls,
		wasm,
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
		await world.proposeCheck("one is 1", "one() === 1", `define("one", () => 2);`, { by: "operator" });
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

