import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { MODELS, type Transcript, type WorldSummary } from "../api/types.ts";
import type { Fanout } from "./fanout.ts";
import { errorMessage, json, read } from "./http.ts";
import type { OpenedWorld } from "./open-world.ts";

/** What the routes need of an open world cell. */
export interface WorldRuntime {
	readonly opened: OpenedWorld;
	readonly fanout: Fanout;
	/** Hand a socket to the cell, which keeps it across hibernation. */
	accept(socket: WebSocket): void;
	transcript(): Transcript;
	summary(): WorldSummary;
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
		return json({ error: errorMessage(error) }, 400);
	}
}

async function routeApi(request: Request, url: URL, parts: string[], runtime: WorldRuntime): Promise<Response> {
	const { world, root } = runtime.opened;
	const method = request.method;
	const [head, arg] = parts;
	const route = `${method} ${head ?? ""}`;
	switch (route) {
		case "GET ":
			return json(runtime.summary());
		case "GET ws": {
			if (request.headers.get("upgrade") !== "websocket") return json({ error: "expected a WebSocket upgrade" }, 426);
			const pair = new WebSocketPair();
			runtime.accept(pair[1]);
			for (const frame of [
				{ type: "world", world: runtime.summary() },
				{ type: "transcript", transcript: runtime.transcript() },
			]) pair[1].send(JSON.stringify(frame));
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
			return json(outcome, outcome.ok ? 200 : 422);
		}
		case "POST execute": {
			const { expression } = await read<{ expression: string }>(request);
			const outcome = await world.execute(expression);
			return json(outcome, outcome.ok ? 200 : 422);
		}
		case "GET functions":
			if (!arg) return json(world.catalogue());
			return json(world.catalogue().find((entry) => entry.name === arg) ?? { error: `no function ${arg}` }, 404);
		case "GET revisions": {
			if (arg !== undefined) {
				const revision = await world.revision(Number(arg));
				return revision ? json(revision) : json({ error: `no revision ${arg}` }, 404);
			}
			const before = url.searchParams.get("before");
			return json(await world.history(Number(url.searchParams.get("limit") ?? HISTORY_PAGE), before === null ? undefined : Number(before)));
		}
		case "POST rollback": {
			const { revision, reason } = await read<{ revision: number; reason?: string }>(request);
			return json(await world.rollback(Number(revision), reason ?? "", { by: "operator" }));
		}
		case "GET checks":
			return json(world.checks());
		case "DELETE checks": {
			if (!arg) return json({ error: "name the check: /checks/:name" }, 400);
			const { reason } = await read<{ reason?: string }>(request);
			await world.removeCheck(arg, reason ?? "");
			return json({ ok: true });
		}
		case "GET data":
			return json(await world.data(url.searchParams.get("prefix") ?? ""));
		case "DELETE data": {
			if (!arg) return json({ error: "name the key: /data/:key" }, 400);
			return json({ deleted: await world.deleteData(arg) });
		}
		default:
			return json({ error: `no route ${method} /${parts.join("/")}` }, 404);
	}
}
