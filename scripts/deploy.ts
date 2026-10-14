#!/usr/bin/env node
/**
 * Deploys to the celld fleet and waits until the node serves the new build. The bundle is stamped with the git
 * revision; a working tree with changes adds a hash of them, so two different dirty deploys never share a build and
 * the wait cannot mistake the previous one for this one. The fleet bucket and its service-account key come from the
 * environment, with the defaults this project's fleet uses.
 */
import { execFile } from "node:child_process";
import { createHash, type Hash } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { runMain } from "../cli/run-main.ts";
import { serverFromEnv } from "../cli/server.ts";
import { createClient, type Client } from "../src/api/client.ts";

const run = promisify(execFile);

const BUCKET: string = process.env.CELLD_BUCKET ?? "gs://pi-world-celld";
const CREDENTIALS: string = process.env.GOOGLE_APPLICATION_CREDENTIALS ?? `${process.env.HOME}/.config/celld/pi-world.json`;
const SERVER: string = serverFromEnv();
const CONFIG: string = "wrangler.jsonc";
const STAMPED: string = "wrangler.deploy.jsonc";
const DEV_BUILD: string = `"BUILD": "\\"dev\\""`;
/** The node polls the bucket for deployments every 30 s; allow two polls and a slow cut-over. */
const ADOPTION_TIMEOUT_MS: number = 90_000;
const POLL_MS: number = 2_000;

/** The wrangler config with the BUILD define set to `build`. */
export function stamp(config: string, build: string): string {
	if (!config.includes(DEV_BUILD)) throw new Error(`${CONFIG} has no ${DEV_BUILD} define to stamp`);
	return config.replace(DEV_BUILD, `"BUILD": ${JSON.stringify(JSON.stringify(build))}`);
}

async function git(...args: string[]): Promise<string> {
	return (await run("git", args, { maxBuffer: 256 * 1024 * 1024, encoding: "buffer" })).stdout.toString("utf8");
}

/** The revision, and for a working tree with changes `-dirty-` and a hash of the diff and of every untracked file. */
async function buildName(): Promise<string> {
	const revision: string = (await git("describe", "--always", "--dirty")).trim();
	const untracked: readonly string[] = (await git("ls-files", "--others", "--exclude-standard")).split("\n").filter(Boolean).sort();
	if (!revision.endsWith("-dirty") && untracked.length === 0) return revision;
	const hash: Hash = createHash("sha256").update(await git("diff", "HEAD", "--binary"));
	for (const path of untracked) hash.update(path).update(await readFile(path));
	return `${revision.replace(/-dirty$/, "")}-dirty-${hash.digest("hex").slice(0, 8)}`;
}

async function waitForBuild(client: Client, build: string): Promise<number> {
	const started: number = Date.now();
	while (Date.now() - started < ADOPTION_TIMEOUT_MS) {
		const served: string | undefined = await client.version().then(
			(version) => version.build,
			() => undefined,
		);
		if (served === build) return Date.now() - started;
		await sleep(POLL_MS);
	}
	throw new Error(`${SERVER} still does not serve ${build} after ${ADOPTION_TIMEOUT_MS / 1000} s`);
}

async function main(): Promise<void> {
	const build: string = await buildName();
	await writeFile(STAMPED, stamp(await readFile(CONFIG, "utf8"), build));
	try {
		const { stdout, stderr } = await run("celld", ["deploy", STAMPED, "--bucket", BUCKET], {
			env: { ...process.env, GOOGLE_APPLICATION_CREDENTIALS: CREDENTIALS },
		});
		process.stdout.write(stdout);
		process.stderr.write(stderr);
	} finally {
		await rm(STAMPED, { force: true });
	}
	console.log(`deployed ${build}; waiting for ${SERVER} to serve it`);
	const took: number = await waitForBuild(createClient(SERVER), build);
	console.log(`${SERVER} serves ${build} (adopted in ${Math.round(took / 1000)} s)`);
}

if (import.meta.main) runMain("deploy", main);
