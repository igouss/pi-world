import { WORLD_ID } from "./directory/world-id.ts";
import { ACCOUNT_NAME, DIRECTORY_NAME, type Env } from "./env.ts";

export { AccountCell } from "./account/account-cell.ts";
export { WorldCell } from "./cell/world-cell.ts";
export { DirectoryCell } from "./directory/directory-cell.ts";

/**
 * Routes: `/api/account/*` to the account cell, `/api/worlds` to the directory, `/api/worlds/:id/*` and `/w/:id/*` to
 * that world's cell. Everything else is the web UI's static assets.
 */
export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		const segments = url.pathname.split("/").slice(1);
		try {
			if (segments[0] === "api" && segments[1] === "account") return await account(request, env, segments.slice(2).join("/"));
			if (segments[0] === "api" && segments[1] === "worlds") {
				const id = segments[2];
				if (!id) return await worlds(request, env);
				if (!WORLD_ID.test(id)) return Response.json({ error: "bad world id" }, { status: 400 });
				if (request.method === "DELETE" && segments.length === 3) {
					await env.DIRECTORY.getByName(DIRECTORY_NAME).forget(id);
					return Response.json({ ok: true });
				}
				return await env.WORLD.getByName(id).fetch(request);
			}
			if (segments[0] === "w" && segments[1] && WORLD_ID.test(segments[1])) {
				if (segments.length === 2) return Response.redirect(`${url.origin}/w/${segments[1]}/`, 308);
				return await env.WORLD.getByName(segments[1]).fetch(request);
			}
			return await env.ASSETS.fetch(request);
		} catch (error) {
			return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
		}
	},
} satisfies ExportedHandler<Env>;

async function worlds(request: Request, env: Env): Promise<Response> {
	const directory = env.DIRECTORY.getByName(DIRECTORY_NAME);
	if (request.method === "GET") return Response.json(await directory.list());
	if (request.method === "POST") {
		const { name } = (await request.json()) as { name?: string };
		const listing = await directory.create(name ?? "");
		await env.WORLD.getByName(listing.id).init(listing.id, listing.name);
		return Response.json(listing, { status: 201 });
	}
	return Response.json({ error: "method not allowed" }, { status: 405 });
}

async function account(request: Request, env: Env, path: string): Promise<Response> {
	const cell = env.ACCOUNT.getByName(ACCOUNT_NAME);
	const body = async <T>(): Promise<T> => (await request.json()) as T;
	switch (`${request.method} ${path}`) {
		case "GET ":
			return Response.json(await cell.status());
		case "POST login":
			return Response.json(await cell.startLogin());
		case "POST login/finish":
			return Response.json(await cell.finishLogin((await body<{ code: string }>()).code ?? ""));
		case "POST token":
			return Response.json(await cell.setToken((await body<{ token: string }>()).token ?? ""));
		case "POST logout":
			await cell.logout();
			return Response.json({ ok: true });
		default:
			return Response.json({ error: "not found" }, { status: 404 });
	}
}
