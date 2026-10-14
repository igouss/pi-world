import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Host } from "./sampler.ts";

const run = promisify(execFile);

/** celld's unauthenticated operator routes on the internal listener: `/state` and `/evict/<scope>`. */
export class Operator {
	private readonly host: Host;

	constructor(host: Host) {
		this.host = host;
	}

	async residents(): Promise<readonly string[]> {
		const state = JSON.parse(await this.curl("GET", "/state")) as { residents?: string[] };
		return state.residents ?? [];
	}

	/** Evict a resident cell; answers celld's reply. */
	evict(scope: string): Promise<string> {
		return this.curl("POST", `/evict/${scope}`);
	}

	private async curl(method: string, path: string): Promise<string> {
		if (!this.host.internal) throw new Error("the target has no internal listener configured (--internal)");
		const args = ["-s", "-m", "30", "-X", method, `http://${this.host.internal}${path}`];
		const sudo = this.host.sudo ? ["sudo", "-n"] : [];
		const { stdout } = this.host.ssh ? await run("ssh", ["-o", "BatchMode=yes", this.host.ssh, ...sudo, "curl", ...args.map(quote)]) : await run("curl", args);
		return stdout;
	}
}

function quote(arg: string): string {
	return `'${arg.replaceAll("'", "'\\''")}'`;
}
