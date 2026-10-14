/**
 * A typed client of the REST API, shared by the web UI (same origin) and the `pw` command line (any server).
 */
import { hex } from "./text.ts";
import { callPath, incidentPath } from "./paths.ts";
import type {
	AccountStatus,
	CallResult,
	CheckProposal,
	ChecksState,
	DataRow,
	DevelopResult,
	EnrolResult,
	Grants,
	Incident,
	Rejection,
	Revision,
	Transcript,
	WorldListing,
	WorldSummary,
} from "./types.ts";

/** A retry-safe request id. `crypto.randomUUID` needs a secure context, and the UI is often served over plain HTTP. */
function requestId(): string {
	return hex(crypto.getRandomValues(new Uint8Array(16)));
}

/** A newest-first list's path, from its start or numbered below `before`. */
function paged(path: string, before?: number): string {
	return before === undefined ? path : `${path}?before=${before}`;
}

/** The client of the server at `base` (empty for the page's own origin). A response with an `error` and a failing status throws it. */
export function createClient(base: string, fetcher: typeof fetch = fetch) {
	async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
		const response: Response = await fetcher(base + path, {
			method,
			headers: body === undefined ? {} : { "content-type": "application/json" },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
		const value: T & { error?: string } = (await response.json()) as T & { error?: string };
		if (!response.ok && typeof value?.error === "string") throw new Error(value.error);
		return value;
	}

	return {
		base,
		version: () => request<{ build: string }>("GET", "/api/version"),
		account: () => request<AccountStatus>("GET", "/api/account"),
		startLogin: () => request<{ url: string }>("POST", "/api/account/login"),
		finishLogin: (code: string) => request<AccountStatus>("POST", "/api/account/login/finish", { code }),
		setToken: (token: string) => request<AccountStatus>("POST", "/api/account/token", { token }),
		logout: () => request<unknown>("POST", "/api/account/logout"),

		worlds: () => request<WorldListing[]>("GET", "/api/worlds"),
		createWorld: (name: string) => request<WorldListing>("POST", "/api/worlds", { name }),
		forgetWorld: (id: string) => request<unknown>("DELETE", `/api/worlds/${id}`),

		world: (id: string) => request<WorldSummary>("GET", `/api/worlds/${id}`),
		transcript: (id: string) => request<Transcript>("GET", `/api/worlds/${id}/transcript`),
		send: (id: string, content: string) => request<{ submission: number }>("POST", `/api/worlds/${id}/messages`, { content, requestId: requestId() }),
		abort: (id: string) => request<unknown>("POST", `/api/worlds/${id}/abort`),
		reset: (id: string) => request<unknown>("POST", `/api/worlds/${id}/reset`),
		setModel: (id: string, model: string) => request<unknown>("POST", `/api/worlds/${id}/model`, { model }),
		call: (id: string, name: string, args: unknown[]) => request<CallResult>("POST", callPath(id, name), { args }),
		execute: (id: string, expression: string) => request<CallResult>("POST", `/api/worlds/${id}/execute`, { expression }),
		develop: (id: string, source: string, summary: string) => request<DevelopResult>("POST", `/api/worlds/${id}/develop`, { source, summary }),
		revisions: (id: string, before?: number) => request<Revision[]>("GET", paged(`/api/worlds/${id}/revisions`, before)),
		rejections: (id: string, before?: number) => request<Rejection[]>("GET", paged(`/api/worlds/${id}/rejections`, before)),
		rollback: (id: string, revision: number, reason: string) => request<Revision>("POST", `/api/worlds/${id}/rollback`, { revision, reason }),
		incidents: (id: string, before?: number) => request<Incident[]>("GET", paged(`/api/worlds/${id}/incidents`, before)),
		retryIncident: (id: string, n: number) => request<CallResult>("POST", `${incidentPath(id, n)}/retry`),
		returnFromIncident: (id: string, n: number, value: unknown) => request<Incident>("POST", `${incidentPath(id, n)}/return`, { value }),
		dismissIncident: (id: string, n: number, reason: string) => request<Incident>("POST", `${incidentPath(id, n)}/dismiss`, { reason }),
		setGrants: (id: string, grants: Grants) => request<Grants>("PUT", `/api/worlds/${id}/grants`, grants),
		checks: (id: string) => request<ChecksState>("GET", `/api/worlds/${id}/checks`),
		proposeCheck: (id: string, proposal: CheckProposal) => request<EnrolResult>("POST", `/api/worlds/${id}/checks`, proposal),
		removeCheck: (id: string, name: string, reason: string) => request<unknown>("DELETE", `/api/worlds/${id}/checks/${encodeURIComponent(name)}`, { reason }),
		data: (id: string, prefix: string) => request<DataRow[]>("GET", `/api/worlds/${id}/data?prefix=${encodeURIComponent(prefix)}`),
		deleteData: (id: string, key: string) => request<unknown>("DELETE", `/api/worlds/${id}/data/${encodeURIComponent(key)}`),
	};
}

export type Client = ReturnType<typeof createClient>;
