import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { MODELS, type CallResult, type Transcript, type WorldSummary } from "../api/types.ts";
import type { DataPort } from "../world/data-port.ts";
import type { Fanout } from "./fanout.ts";
import type { OpenedWorld } from "./open-world.ts";

/** What the routes need of an open world cell. */
export interface WorldRuntime {
	readonly id: string;
	readonly opened: OpenedWorld;
	readonly data: DataPort;
	readonly fanout: Fanout;
	transcript(): Transcript;
	summary(): Promise<WorldSummary>;
	setModel(modelId: string): Promise<void>;
	armHeartbeat(): Promise<void>;
	app(path: string, query: Record<string, string>): Promise<Response>;
}

const HISTORY_PAGE: number = 50;

/**
 * The world's REST surface, below `/api/worlds/:id`, and its page, below `/w/:id`.
 * A failed operation answers with `{ error }` and a 4xx status.
 */
export async function routeWorld(request: Request, runtime: WorldRuntime): Promise<Response> {
	const url = new URL(request.url);
	const segments = url.pathname.split("/").slice(1).map(decodeURIComponent);
	try {
		if (segments[0] === "w") return await runtime.app(`/${segments.slice(2).join("/")}`, Object.fromEntries(url.searchParams));
		if (segments[0] === "api" && segments[1] === "worlds") return await routeApi(request, url, segments.slice(3), runtime);
		return json({ error: "not found" }, 404);
	} catch (error) {
		return json({ error: error instanceof Error ? error.message : String(error) }, 400);
	}
}

async function routeApi(request: Request, url: URL, parts: string[], runtime: WorldRuntime): Promise<Response> {
	const { world, root } = runtime.opened;
	const method = request.method;
	const [head, arg] = parts;
	const route = `${method} ${head ?? ""}`;
	switch (route) {
		case "GET ":
			return json(await runtime.summary());
		case "GET ws": {
			if (request.headers.get("upgrade") !== "websocket") return json({ error: "expected a WebSocket upgrade" }, 426);
			const pair = new WebSocketPair();
			runtime.fanout.add(
				pair[1],
				[
					{ type: "world", world: await runtime.summary() },
					{ type: "transcript", transcript: runtime.transcript() },
				],
				() => undefined,
			);
			return new Response(null, { status: 101, webSocket: pair[0] });
		}
		case "GET transcript":
			return json(runtime.transcript());
		case "POST messages": {
			const body = await read<{ content: string; requestId?: string }>(request);
			if (!body.content?.trim()) return json({ error: "content is empty" }, 400);
			const submission = await root.submit(
				{ type: "input", content: body.content, ...(body.requestId ? { requestId: body.requestId } : {}) },
				BACKGROUND_CONTEXT,
			);
			await runtime.armHeartbeat();
			return json({ submission: submission.id });
		}
		case "POST abort":
			await root.abort(BACKGROUND_CONTEXT);
			return json({ ok: true });
		case "POST reset":
			await root.reset(undefined, BACKGROUND_CONTEXT);
			return json({ ok: true });
		case "POST model": {
			const { model } = await read<{ model: string }>(request);
			if (!MODELS.includes(model)) return json({ error: `unknown model ${model}` }, 400);
			await runtime.setModel(model);
			return json({ ok: true });
		}
		case "POST develop": {
			const { source, summary, requestId } = await read<{ source: string; summary?: string; requestId?: string }>(request);
			const result = await world.develop(source, summary?.trim() || "edited by hand", { by: "operator", ...(requestId ? { requestId } : {}) });
			return json(result, result.status === "accepted" ? 200 : 422);
		}
		case "POST call": {
			if (!arg) return json({ error: "name the function: /call/:name" }, 400);
			const { args = [] } = await read<{ args?: unknown[] }>(request);
			if (!Array.isArray(args)) return json({ error: "args must be an array" }, 400);
			const outcome = await world.call(arg, args);
			const result: CallResult = outcome.ok ? outcome : { ok: false, failure: outcome.failure, error: outcome.error };
			return json(result, outcome.ok ? 200 : 422);
		}
		case "POST execute": {
			const { expression } = await read<{ expression: string }>(request);
			const outcome = await world.execute(expression);
			return json(outcome, outcome.ok ? 200 : 422);
		}
		case "GET functions":
			return arg ? json(world.catalogue().find((entry) => entry.name === arg) ?? { error: `no function ${arg}` }) : json(world.catalogue());
		case "GET revisions": {
			if (arg !== undefined) {
				const revision = await world.revision(Number(arg));
				return revision ? json(revision) : json({ error: `no revision ${arg}` }, 404);
			}
			const before = url.searchParams.get("before");
			return json(await world.history(Number(url.searchParams.get("limit") ?? HISTORY_PAGE), before === null ? undefined : Number(before)));
		}
		case "POST rollback": {
			const { revision, reason } = await read<{ revision: number; reason: string }>(request);
			if (!reason?.trim()) return json({ error: "a rollback needs a reason" }, 400);
			return json(await world.rollback(revision, reason, { by: "operator" }));
		}
		case "GET checks":
			return json(await world.checks());
		case "DELETE checks": {
			if (!arg) return json({ error: "name the check: /checks/:name" }, 400);
			const { reason } = await read<{ reason: string }>(request);
			if (!reason?.trim()) return json({ error: "removing a check needs a reason" }, 400);
			await world.removeCheck(arg, reason);
			return json({ ok: true });
		}
		case "GET data":
			return json(runtime.data.list(url.searchParams.get("prefix") ?? ""));
		case "DELETE data": {
			if (!arg) return json({ error: "name the key: /data/:key" }, 400);
			return json({ deleted: runtime.data.delete(arg) });
		}
		default:
			return json({ error: `no route ${method} /${parts.join("/")}` }, 404);
	}
}

async function read<T>(request: Request): Promise<T> {
	try {
		return (await request.json()) as T;
	} catch {
		throw new Error("the body must be JSON");
	}
}

function json(value: unknown, status: number = 200): Response {
	return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}
