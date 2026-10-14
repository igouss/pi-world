import { execFileSync, spawn } from "node:child_process";
import { Api } from "../lib/api.ts";
import { REPO } from "./paths.ts";
import { DEV_PORT, devInternal } from "./target.ts";

/** Stop every celld on this machine: celld dev's supervisor and its server. */
export function stopDev(): void {
	let pids: string[] = [];
	try {
		pids = execFileSync("pgrep", ["-x", "celld"], { encoding: "utf8" }).split("\n").filter(Boolean);
	} catch {
		// pgrep exits 1 when nothing runs
	}
	for (const pid of pids) process.kill(Number(pid));
}

/**
 * Build pi-world and start a clean celld dev from `binary` with `env`, detached, then wait up to 60 s for it to
 * answer. A job runner that kills its process tree also kills a celld started this way; run it in a job of its own.
 */
export async function startDev(binary: string, env: Readonly<Record<string, string>>): Promise<boolean> {
	stopDev();
	execFileSync("npm", ["run", "build"], { cwd: REPO, stdio: "inherit" });
	await new Promise((r) => setTimeout(r, 1000));
	spawn(binary, ["dev", ".", "--port", String(DEV_PORT), "--no-watch", "--clean"], { cwd: REPO, detached: true, stdio: "ignore", env: { ...process.env, ...env } }).unref();
	const api = new Api(`http://127.0.0.1:${DEV_PORT}`);
	for (let i = 0; i < 120; i++) {
		if (await api.send("GET", "/api/version").then((a) => a.status === 200, () => false)) {
			console.log(`celld dev is up on ${DEV_PORT}; internal listener ${devInternal() ?? "unknown"}`);
			return true;
		}
		await new Promise((r) => setTimeout(r, 500));
	}
	console.error("celld dev did not come up within 60 s");
	return false;
}
