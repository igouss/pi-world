import type { AccountStatus, CallResult, Check, Revision, WorldListing, WorldSummary } from "../src/api/types.ts";

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
	const response = await fetch(path, {
		method,
		headers: body === undefined ? {} : { "content-type": "application/json" },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
	const value = (await response.json()) as T & { error?: string };
	if (!response.ok && value && typeof value === "object" && "error" in value && value.error) throw new Error(value.error);
	return value;
}

/** A retry-safe request id. `crypto.randomUUID` needs a secure context, and the UI is often served over plain HTTP. */
function requestId(): string {
	return [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface DataRow {
	readonly key: string;
	readonly value: unknown;
}

export type DevelopResponse =
	| { status: "accepted"; revision: Revision }
	| { status: "rejected"; failure: string; reason: string; check?: string };

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
	call: (id: string, name: string, args: unknown[]) => request<CallResult>("POST", `/api/worlds/${id}/call/${encodeURIComponent(name)}`, { args }),
	execute: (id: string, expression: string) => request<CallResult>("POST", `/api/worlds/${id}/execute`, { expression }),
	develop: (id: string, source: string, summary: string) => request<DevelopResponse>("POST", `/api/worlds/${id}/develop`, { source, summary }),
	revisions: (id: string, before?: number) => request<Revision[]>("GET", `/api/worlds/${id}/revisions${before === undefined ? "" : `?before=${before}`}`),
	rollback: (id: string, revision: number, reason: string) => request<Revision>("POST", `/api/worlds/${id}/rollback`, { revision, reason }),
	checks: (id: string) => request<{ checks: Check[]; removed: { check: Check; reason: string; removedAt: number }[] }>("GET", `/api/worlds/${id}/checks`),
	removeCheck: (id: string, name: string, reason: string) => request<unknown>("DELETE", `/api/worlds/${id}/checks/${encodeURIComponent(name)}`, { reason }),
	data: (id: string, prefix: string) => request<DataRow[]>("GET", `/api/worlds/${id}/data?prefix=${encodeURIComponent(prefix)}`),
	deleteData: (id: string, key: string) => request<unknown>("DELETE", `/api/worlds/${id}/data/${encodeURIComponent(key)}`),
};
