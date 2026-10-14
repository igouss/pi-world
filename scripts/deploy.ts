#!/usr/bin/env node
/**
 * Deploys a commit to the celld fleet and waits until the node serves it. A working tree with changes is refused,
 * before the gates run and again after them, so the bundle is exactly the commit its build names. The fleet bucket
 * and its service-account key come from the environment, with the defaults this project's fleet uses.
 */
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
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

/** Refuses `git status --porcelain` output that lists any change: a deploy is a commit, so its build names one. */
export function refuseChanges(porcelain: string): void {
	const changes: string = porcelain.trimEnd();
	if (changes) throw new Error(`commit or stash these changes before deploying:\n${changes}`);
}

async function git(...args: string[]): Promise<string> {
	return (await run("git", args)).stdout;
}

/** The commit to deploy, refused when the working tree has changes. */
async function committed(): Promise<string> {
	refuseChanges(await git("status", "--porcelain"));
	return (await git("describe", "--always")).trim();
}

/** Runs an npm script with its output on this terminal; a failure stops the deploy. */
async function npmRun(script: string): Promise<void> {
	const [code] = (await once(spawn("npm", ["run", "-s", script], { stdio: "inherit" }), "exit")) as [number | null];
	if (code !== 0) throw new Error(`npm run ${script} failed`);
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
	const build: string = await committed();
	for (const gate of ["typecheck", "test", "build"]) await npmRun(gate);
	if ((await committed()) !== build) throw new Error(`HEAD moved from ${build} while the gates ran`);
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
