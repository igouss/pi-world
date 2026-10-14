import { Agent, request } from "undici";
import { callPath } from "../../src/api/paths.ts";
import type { Reply } from "./open-loop.ts";

/** Keep-alive connections enough that the client never limits an open-loop run. */
const dispatcher: Agent = new Agent({ connections: 1024, pipelining: 1, keepAliveTimeout: 30_000 });

export interface Answer<T> {
	readonly status: number;
	readonly body: T;
}

/** pi-world's REST API, as the load generator and the scenarios use it. */
export class Api {
	readonly base: string;

	constructor(base: string) {
		this.base = base;
	}

	async send<T>(method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown): Promise<Answer<T>> {
		const response = await request(`${this.base}${path}`, {
			method,
			dispatcher,
			headers: body === undefined ? {} : { "content-type": "application/json" },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
		const text = await response.body.text();
		return { status: response.statusCode, body: (text ? safeJson(text) : null) as T };
	}

	async createWorld(name: string): Promise<string> {
		const { status, body } = await this.send<{ id: string; error?: string }>("POST", "/api/worlds", { name });
		if (status !== 201) throw new Error(`creating world ${name}: ${status} ${JSON.stringify(body)}`);
		return body.id;
	}

	async forgetWorld(id: string): Promise<void> {
		await this.send("DELETE", `/api/worlds/${id}`);
	}

	async worlds(): Promise<readonly { id: string; name: string }[]> {
		return (await this.send<{ id: string; name: string }[]>("GET", "/api/worlds")).body;
	}

	async develop(id: string, source: string): Promise<Answer<{ status: string; rejection?: { reason: string } }>> {
		return this.send("POST", `/api/worlds/${id}/develop`, { source, summary: "perf fixture" });
	}

	async mustDevelop(id: string, source: string): Promise<void> {
		const { status, body } = await this.develop(id, source);
		if (status !== 200) throw new Error(`develop in ${id} was refused: ${JSON.stringify(body).slice(0, 400)}`);
	}

	/** Enrol a check as the operator; answers false when the target's build has no such route (older than pw-djz). */
	async enrol(id: string, check: { name: string; expression: string; counterexample: string; generator?: unknown }): Promise<boolean> {
		const { status, body } = await this.send("POST", `/api/worlds/${id}/checks`, check);
		if (status === 404 && /no route/.test(JSON.stringify(body))) return false;
		if (status !== 200) throw new Error(`check ${check.name} in ${id} was refused: ${JSON.stringify(body).slice(0, 400)}`);
		return true;
	}

	async setGrants(id: string, grants: unknown): Promise<void> {
		const { status, body } = await this.send("PUT", `/api/worlds/${id}/grants`, grants);
		if (status !== 200) throw new Error(`grants for ${id}: ${status} ${JSON.stringify(body)}`);
	}

	call(id: string, fn: string, args: readonly unknown[]): Promise<Answer<{ ok: boolean; value?: unknown; error?: string; failure?: string }>> {
		return this.send("POST", callPath(id, fn), { args });
	}

	async mustCall(id: string, fn: string, args: readonly unknown[]): Promise<unknown> {
		const { status, body } = await this.call(id, fn, args);
		if (status !== 200 || !body.ok) throw new Error(`call ${id}.${fn}: ${status} ${JSON.stringify(body).slice(0, 400)}`);
		return body.value;
	}

	/** A call as a load request: anything but a 200 with `ok` and a value `accept` passes is a failure, named by its status and error. */
	async callReply(id: string, fn: string, args: readonly unknown[], accept: (value: unknown) => string | undefined = () => undefined): Promise<Reply> {
		const { status, body } = await this.call(id, fn, args);
		if (status === 200 && body?.ok) {
			const wrong = accept(body.value);
			return wrong === undefined ? { ok: true } : { ok: false, kind: `200 wrong value: ${wrong.slice(0, 80)}` };
		}
		return { ok: false, kind: `${status} ${failureName(body)}` };
	}

	/** A develop as a load request. */
	async developReply(id: string, source: string): Promise<Reply> {
		const { status, body } = await this.develop(id, source);
		if (status === 200 && body.status === "accepted") return { ok: true };
		return { ok: false, kind: `${status} ${body?.rejection?.reason?.split("\n")[0]?.slice(0, 80) ?? failureName(body)}` };
	}
}

function failureName(body: unknown): string {
	const b = body as { failure?: string; error?: string } | null;
	return (b?.failure ?? b?.error ?? String(body)).split("\n")[0]!.slice(0, 80);
}

function safeJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}
