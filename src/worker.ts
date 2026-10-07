import { build } from "./build.ts";
import { BadRequest, errorMessage, json, read } from "./cell/http.ts";
import { WORLD_ID } from "./directory/world-id.ts";
import { ACCOUNT_NAME, DIRECTORY_NAME, type Env } from "./env.ts";

export { AccountCell } from "./account/account-cell.ts";
export { WorldCell } from "./cell/world-cell.ts";
export { DirectoryCell } from "./directory/directory-cell.ts";
export { WorldHost } from "./isolate/host/world-host.ts";

/**
 * Routes: `/api/account/*` to the account cell, `/api/worlds` to the directory, `/api/worlds/:id/*` and `/w/:id/*` to
 * that world's cell. Everything else is the web UI's static assets.
 */
export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		const segments = url.pathname.split("/").slice(1);
		try {
			if (segments[0] === "api" && segments[1] === "version") return json({ build });
			if (segments[0] === "api" && segments[1] === "account") {
				// The account cell's errors describe what the person entered: a bad code, a rejected token.
				return await account(request, env, segments.slice(2).join("/")).catch((error: unknown) => {
					throw error instanceof BadRequest ? error : new BadRequest(errorMessage(error));
				});
			}
			if (segments[0] === "api" && segments[1] === "worlds") {
				const id = segments[2];
				if (!id) return await worlds(request, env);
				if (!WORLD_ID.test(id)) return json({ error: "bad world id" }, 400);
				if (request.method === "DELETE" && segments.length === 3) {
					await env.DIRECTORY.getByName(DIRECTORY_NAME).forget(id);
					return json({ ok: true });
				}
				return await env.WORLD.getByName(id).fetch(request);
			}
			if (segments[0] === "w" && segments[1] && WORLD_ID.test(segments[1])) {
				if (segments.length === 2) return Response.redirect(`${url.origin}/w/${segments[1]}/`, 308);
				return await env.WORLD.getByName(segments[1]).fetch(request);
			}
			return await env.ASSETS.fetch(request);
		} catch (error) {
			return json({ error: errorMessage(error) }, error instanceof BadRequest ? 400 : 500);
		}
	},
} satisfies ExportedHandler<Env>;

async function worlds(request: Request, env: Env): Promise<Response> {
	const directory = env.DIRECTORY.getByName(DIRECTORY_NAME);
	if (request.method === "GET") return json(await directory.list());
	if (request.method === "POST") {
		const { name } = await read<{ name?: string }>(request);
		if (!name?.trim()) throw new BadRequest("a world needs a name");
		const listing = await directory.create(name);
		await env.WORLD.getByName(listing.id).init(listing.id, listing.name);
		return json(listing, 201);
	}
	return json({ error: "method not allowed" }, 405);
}

async function account(request: Request, env: Env, path: string): Promise<Response> {
	const cell = env.ACCOUNT.getByName(ACCOUNT_NAME);
	switch (`${request.method} ${path}`) {
		case "GET ":
			return json(await cell.status());
		case "POST login":
			return json(await cell.startLogin());
		case "POST login/finish":
			return json(await cell.finishLogin((await read<{ code?: string }>(request)).code ?? ""));
		case "POST token":
			return json(await cell.setToken((await read<{ token?: string }>(request)).token ?? ""));
		case "POST logout":
			await cell.logout();
			return json({ ok: true });
		default:
			return json({ error: "not found" }, 404);
	}
}
