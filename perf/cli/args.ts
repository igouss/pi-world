import { join } from "node:path";
import { parseArgs } from "node:util";
import { fail, PERF } from "./paths.ts";

/** Every command's options, parsed by one set of rules. */
export interface Options {
	readonly names: readonly string[];
	readonly target: string;
	/** Scenario parameters, `--set name=number`. */
	readonly set: Readonly<Record<string, number>>;
	/** celld settings for `dev up`, `--env NAME=VALUE`. */
	readonly env: Readonly<Record<string, string>>;
	readonly approval: string | undefined;
	readonly keep: boolean;
	readonly internal: string | undefined;
	readonly out: string;
	readonly celld: string | undefined;
	readonly seconds: number;
	readonly delay: number;
	readonly update: boolean;
}

export function parse(args: readonly string[]): Options {
	const { values, positionals } = parseArgs({
		args: [...args],
		allowPositionals: true,
		options: {
			target: { type: "string", default: "dev" },
			set: { type: "string", multiple: true, default: [] },
			env: { type: "string", multiple: true, default: [] },
			approval: { type: "string" },
			keep: { type: "boolean", default: false },
			internal: { type: "string" },
			out: { type: "string", default: join(PERF, "results") },
			celld: { type: "string" },
			seconds: { type: "string", default: "20" },
			delay: { type: "string", default: "8" },
			update: { type: "boolean", default: false },
		},
	});
	return {
		names: positionals,
		target: values.target,
		set: Object.fromEntries(values.set.map((pair) => numberPair(pair))),
		env: Object.fromEntries(values.env.map((pair) => textPair(pair))),
		approval: values.approval,
		keep: values.keep,
		internal: values.internal,
		out: values.out,
		celld: values.celld,
		seconds: Number(values.seconds),
		delay: Number(values.delay),
		update: values.update,
	};
}

function textPair(pair: string): [string, string] {
	const at = pair.indexOf("=");
	if (at <= 0) fail(`expected NAME=VALUE, not ${pair}`);
	return [pair.slice(0, at), pair.slice(at + 1)];
}

function numberPair(pair: string): [string, number] {
	const [name, value] = textPair(pair);
	if (value === "" || Number.isNaN(Number(value))) fail(`--set needs name=number, not ${pair}`);
	return [name, Number(value)];
}
