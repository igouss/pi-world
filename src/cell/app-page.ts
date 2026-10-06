import { appPath, callPath, worldHash } from "../api/paths.ts";
import { escapeHtml } from "../api/text.ts";
import type { CatalogueEntry } from "../world/world-vm.ts";
import type { World } from "../world/world.ts";

/** The definition a world serves its page from. */
const APP: string = "app";

export function hasApp(catalogue: readonly CatalogueEntry[]): boolean {
	return catalogue.some((entry) => entry.name === APP);
}

/**
 * The page a world serves: the result of its `app(path, query)` definition, with a `world.call` client injected so
 * the page's scripts can call the world's functions.
 */
export async function appPage(world: World, worldId: string, path: string, query: Record<string, string>): Promise<Response> {
	if (!hasApp(world.catalogue())) return html(EMPTY(worldId), 404);
	const outcome = await world.call(APP, [path, query]);
	if (!outcome.ok) return html(FAILED(worldId, `${outcome.failure}: ${outcome.error}`), 500);
	if (typeof outcome.value !== "string") return html(FAILED(worldId, `app returned ${typeof outcome.value}, not an HTML string`), 500);
	return html(inject(outcome.value, CLIENT(worldId)), 200);
}

function inject(page: string, script: string): string {
	const head = /<head[^>]*>/i.exec(page);
	if (head) return page.slice(0, head.index + head[0].length) + script + page.slice(head.index + head[0].length);
	return script + page;
}

function html(body: string, status: number): Response {
	return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

const CLIENT = (worldId: string): string => `<script>
window.world = Object.freeze({
	id: ${JSON.stringify(worldId)},
	async call(name, ...args) {
		const response = await fetch(${JSON.stringify(callPath(worldId, ""))} + encodeURIComponent(name), {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ args }),
		});
		const result = await response.json();
		if (!result.ok) throw new Error(result.error || result.failure || "call failed");
		return result.value;
	},
});
</script>`;

const SHELL = (title: string, body: string): string =>
	`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem;color:#222}pre{white-space:pre-wrap;background:#f4f4f4;padding:1rem;border-radius:6px}a{color:#3b5bdb}</style>
</head><body>${body}</body></html>`;

const EMPTY = (worldId: string): string =>
	SHELL(
		"No app yet",
		`<h1>This world has no page yet</h1><p>Ask the agent for one, for example: <em>"Make an app page that lists my todos and lets me add one."</em></p><p><a href="/${worldHash(worldId)}">Back to the world</a></p>`,
	);

const FAILED = (worldId: string, error: string): string =>
	SHELL("App failed", `<h1>The app failed</h1><pre>${escapeHtml(error)}</pre><p><a href="/${worldHash(worldId)}">Back to the world</a></p>`);
