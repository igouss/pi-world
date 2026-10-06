import { hex } from "../src/api/text.ts";
import { callPath } from "../src/api/paths.ts";
import type { AccountStatus, CallResult, ChecksState, DataRow, DevelopResult, Revision, WorldListing, WorldSummary } from "../src/api/types.ts";

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
	const response = await fetch(path, {
		method,
		headers: body === undefined ? {} : { "content-type": "application/json" },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
	const value = (await response.json()) as T & { error?: string };
	if (!response.ok && typeof value?.error === "string") throw new Error(value.error);
	return value;
}

/** A retry-safe request id. `crypto.randomUUID` needs a secure context, and the UI is often served over plain HTTP. */
function requestId(): string {
	return hex(crypto.getRandomValues(new Uint8Array(16)));
}

export const api = {
	account: () => request<AccountStatus>("GET", "/api/account"),
	startLogin: () => request<{ url: string }>("POST", "/api/account/login"),
	finishLogin: (code: string) => request<AccountStatus>("POST", "/api/account/login/finish", { code }),
	setToken: (token: string) => request<AccountStatus>("POST", "/api/account/token", { token }),
	logout: () => request<unknown>("POST", "/api/account/logout"),

	worlds: () => request<WorldListing[]>("GET", "/api/worlds"),
	createWorld: (name: string) => request<WorldListing>("POST", "/api/worlds", { name }),
	forgetWorld: (id: string) => request<unknown>("DELETE", `/api/worlds/${id}`),

	world: (id: string) => request<WorldSummary>("GET", `/api/worlds/${id}`),
	send: (id: string, content: string) => request<unknown>("POST", `/api/worlds/${id}/messages`, { content, requestId: requestId() }),
	abort: (id: string) => request<unknown>("POST", `/api/worlds/${id}/abort`),
	reset: (id: string) => request<unknown>("POST", `/api/worlds/${id}/reset`),
	setModel: (id: string, model: string) => request<unknown>("POST", `/api/worlds/${id}/model`, { model }),
	call: (id: string, name: string, args: unknown[]) => request<CallResult>("POST", callPath(id, name), { args }),
	execute: (id: string, expression: string) => request<CallResult>("POST", `/api/worlds/${id}/execute`, { expression }),
	develop: (id: string, source: string, summary: string) => request<DevelopResult>("POST", `/api/worlds/${id}/develop`, { source, summary }),
	revisions: (id: string, before?: number) => request<Revision[]>("GET", `/api/worlds/${id}/revisions${before === undefined ? "" : `?before=${before}`}`),
	rollback: (id: string, revision: number, reason: string) => request<Revision>("POST", `/api/worlds/${id}/rollback`, { revision, reason }),
	checks: (id: string) => request<ChecksState>("GET", `/api/worlds/${id}/checks`),
	removeCheck: (id: string, name: string, reason: string) => request<unknown>("DELETE", `/api/worlds/${id}/checks/${encodeURIComponent(name)}`, { reason }),
	data: (id: string, prefix: string) => request<DataRow[]>("GET", `/api/worlds/${id}/data?prefix=${encodeURIComponent(prefix)}`),
	deleteData: (id: string, key: string) => request<unknown>("DELETE", `/api/worlds/${id}/data/${encodeURIComponent(key)}`),
};
