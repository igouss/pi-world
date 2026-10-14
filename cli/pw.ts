#!/usr/bin/env node
/**
 * pw: pi-world from the command line. Drives a server's worlds through the same typed client as the web UI:
 * develop sources from files, call and preview functions, enrol checks, and talk to a world's agent.
 */
import { readFile } from "node:fs/promises";
import { Command } from "@commander-js/extra-typings";
import { createClient, type Client } from "../src/api/client.ts";
import { appPath } from "../src/api/paths.ts";
import type { CallResult, CheckProposal, DevelopResult, EnrolResult, Transcript, TranscriptItem, WorldSummary } from "../src/api/types.ts";
import { ask } from "./follow.ts";
import { formatCall, formatDevelop, formatEnrol, formatItem } from "./format.ts";
import { runMain } from "./run-main.ts";
import { serverFromEnv } from "./server.ts";
import { resolveWorld } from "./world-ref.ts";

const program = new Command()
	.name("pw")
	.description("Drive a pi-world server: worlds, develop, call, checks and the agent.")
	.option("-s, --server <url>", "the server (or set PW_SERVER)", serverFromEnv())
	.option("--json", "print raw JSON responses");

function client(): Client {
	return createClient(program.opts().server.replace(/\/$/, ""));
}

/** The client and the id of the world `ref` names. */
async function target(ref: string): Promise<{ readonly api: Client; readonly id: string }> {
	const api: Client = client();
	return { api, id: resolveWorld(await api.worlds(), ref).id };
}

/** Prints the raw response with --json, else the human form; exits 1 when `failed`. */
function print<T>(value: T, human: (value: T) => string, failed: boolean = false): void {
	console.log(program.opts().json ? JSON.stringify(value, null, 2) : human(value));
	if (failed) process.exitCode = 1;
}

/** A command-line argument as JSON when it parses, else as a string: `pw call w add 2 '"x"' hello`. */
function argument(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

program
	.command("worlds")
	.description("list the worlds")
	.action(async () => print(await client().worlds(), (ws) => ws.map((w) => `${w.id}\t${w.name}`).join("\n")));

program
	.command("create")
	.description("create a world")
	.argument("<name>")
	.action(async (name) => print(await client().createWorld(name), (w) => w.id));

program
	.command("show")
	.description("a world's revision, functions and checks")
	.argument("<world>", "id, name or id prefix")
	.action(async (ref) => {
		const { api, id } = await target(ref);
		const summary: WorldSummary = await api.world(id);
		print(summary, (s) =>
			[
				`${s.name} (${s.id}) at revision ${s.revision}, build ${s.build}, model ${s.model}`,
				`${s.rejections} rejected, ${s.incidents} open incidents${s.hasApp ? `, app at ${api.base}${appPath(s.id)}` : ""}`,
				"functions:",
				...s.functions.map((f) => `  ${f.name}(${f.params})  ${f.doc}`),
				"checks:",
				...s.checks.map((c) => `  ${c.name}: ${c.expression}`),
			].join("\n"),
		);
	});

program
	.command("develop")
	.description("develop a source file into a world, through the same attempt as the agent's")
	.argument("<world>")
	.argument("<file>")
	.option("-m, --summary <text>", "what the change does")
	.action(async (ref, file, options) => {
		const source: string = await readFile(file, "utf8");
		const { api, id } = await target(ref);
		const result: DevelopResult = await api.develop(id, source, options.summary ?? file);
		print(result, formatDevelop, result.status !== "accepted");
	});

program
	.command("execute")
	.description("preview an expression: data writes are rolled back")
	.argument("<world>")
	.argument("<expression>")
	.action(async (ref, expression) => {
		const { api, id } = await target(ref);
		const result: CallResult = await api.execute(id, expression);
		print(result, formatCall, !result.ok);
	});

program
	.command("call")
	.description("call a function for real; each argument is JSON, or a string when it is not")
	.argument("<world>")
	.argument("<function>")
	.argument("[args...]")
	.action(async (ref, fn, args) => {
		const { api, id } = await target(ref);
		const result: CallResult = await api.call(id, fn, args.map(argument));
		print(result, formatCall, !result.ok);
	});

program
	.command("check")
	.description("propose a check from a JSON file: { name, expression, counterexample, generator? }")
	.argument("<world>")
	.argument("<file>")
	.action(async (ref, file) => {
		const proposal: CheckProposal = JSON.parse(await readFile(file, "utf8")) as CheckProposal;
		const { api, id } = await target(ref);
		const result: EnrolResult = await api.proposeCheck(id, proposal);
		print(result, formatEnrol, result.status !== "enrolled");
	});

program
	.command("ask")
	.description("send the world's agent a message and follow its turn until it settles")
	.argument("<world>")
	.argument("[message...]")
	.option("-f, --file <file>", "read the message from a file")
	.option("-t, --timeout <seconds>", "give up after this long", "900")
	.action(async (ref, words, options) => {
		const content: string = options.file ? await readFile(options.file, "utf8") : words.join(" ");
		if (!content.trim()) throw new Error("ask needs a message, or --file");
		const { api, id } = await target(ref);
		const show = (item: TranscriptItem): void => {
			if (!program.opts().json) console.log(formatItem(item));
		};
		const transcript: Transcript = await ask(api, id, content, show, Number(options.timeout) * 1000);
		const last: TranscriptItem | undefined = transcript.items.at(-1);
		if (program.opts().json) console.log(JSON.stringify(last ?? null, null, 2));
		if (last?.kind === "assistant" && last.error) throw new Error(`the agent's turn ended in an error: ${last.error}`);
	});

program
	.command("transcript")
	.description("the agent's conversation, last items first")
	.argument("<world>")
	.option("-n, --last <count>", "how many items", "20")
	.action(async (ref, options) => {
		const { api, id } = await target(ref);
		const transcript: Transcript = await api.transcript(id);
		print(transcript.items.slice(-Number(options.last)), (items) => items.map(formatItem).join("\n"));
	});

program
	.command("rejections")
	.description("attempts the world turned away, newest first")
	.argument("<world>")
	.action(async (ref) => {
		const { api, id } = await target(ref);
		print(await api.rejections(id), (rs) => rs.map((r) => `#${r.n} ${r.summary}: ${r.reason}`).join("\n"));
	});

program
	.command("incidents")
	.description("failed calls, newest first")
	.argument("<world>")
	.action(async (ref) => {
		const { api, id } = await target(ref);
		print(await api.incidents(id), (is) => is.map((i) => JSON.stringify(i)).join("\n"));
	});

program
	.command("data")
	.description("the world's stored data")
	.argument("<world>")
	.argument("[prefix]", "key prefix", "")
	.action(async (ref, prefix) => {
		const { api, id } = await target(ref);
		print(await api.data(id, prefix), (rows) => rows.map((r) => `${r.key}\t${JSON.stringify(r.value)}`).join("\n"));
	});

runMain("pw", async () => {
	await program.parseAsync();
});
