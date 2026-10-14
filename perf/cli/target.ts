import { execFileSync } from "node:child_process";
import { hostname } from "node:os";
import { Api } from "../lib/api.ts";
import type { RunRecord } from "../lib/result.ts";
import type { Host } from "../lib/sampler.ts";
import type { Options } from "./args.ts";
import { fail } from "./paths.ts";

export const DEV_PORT: number = 8791;

/** The pattern of celld dev's server process (not its supervisor), as `pgrep -f` and the sampler match it. */
export const DEV_SERVER: string = "celld --no-control-plane";

/** The deployed node, as perf/README.md describes it. */
export const NODE = { ssh: "oracle-arm", base: "http://127.0.0.1:8787", internal: "127.0.0.1:8788", process: "^[^ ]*celld --bucket" } as const;

/** Where the load goes, how to sample it, and the build it answered with. */
export interface Target {
	readonly api: Api;
	readonly host: Host | undefined;
	readonly kind: RunRecord["target"]["kind"];
	readonly loopback: boolean;
	readonly build: string;
}

/** Resolve `--target` and ask it its build; a target that does not answer runs nothing. The node needs an approval. */
export async function target(options: Options): Promise<Target> {
	const where = locate(options);
	return { ...where, build: await build(where.api) };
}

function locate(options: Options): Omit<Target, "build"> {
	if (options.target === "dev") {
		const internal = options.internal ?? devInternal();
		return { api: new Api(`http://127.0.0.1:${DEV_PORT}`), host: { ssh: undefined, process: `^[^ ]*${DEV_SERVER}`, internal, sudo: false }, kind: "dev", loopback: true };
	}
	if (options.target === "node") {
		if (!options.approval) fail("a run against the operator's node needs --approval with the operator's words approving it (pw-djz, Operator decision)");
		const onNode = hostname() === NODE.ssh;
		return {
			api: new Api(onNode ? NODE.base : `http://${NODE.ssh}.mist-walleye.ts.net:8787`),
			// In the remote container (root, --pid host) /proc is readable without sudo; as the node's login user it needs sudo.
			host: { ssh: onNode ? undefined : NODE.ssh, process: NODE.process, internal: options.internal ?? NODE.internal, sudo: process.getuid?.() !== 0 },
			kind: "node",
			loopback: onNode,
		};
	}
	const local = /^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(options.target);
	return { api: new Api(options.target.replace(/\/$/, "")), host: undefined, kind: "other", loopback: local };
}

async function build(api: Api): Promise<string> {
	const version = await api.send<{ build?: string }>("GET", "/api/version").catch((e: unknown) => fail(`${api.base} does not answer (${e instanceof Error ? e.message : String(e)}); nothing was run`));
	if (version.status !== 200) fail(`${api.base}/api/version answered ${version.status}; nothing was run`);
	return version.body.build ?? "unknown";
}

/** celld dev's server process, if one runs. */
export function devServerPid(): string | undefined {
	try {
		return execFileSync("pgrep", ["-f", DEV_SERVER], { encoding: "utf8" }).trim().split("\n")[0];
	} catch {
		return undefined;
	}
}

/** celld dev's internal listener: the server process's other listening port. */
export function devInternal(): string | undefined {
	const pid = devServerPid();
	if (!pid) return undefined;
	const lines = execFileSync("ss", ["-ltnpH"], { encoding: "utf8" }).split("\n").filter((l) => l.includes(`pid=${pid},`));
	return lines.map((l) => l.split(/\s+/)[3]!).find((a) => !a.endsWith(`:${DEV_PORT}`));
}
