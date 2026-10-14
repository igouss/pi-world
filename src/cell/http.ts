/** JSON in and out of the HTTP routes. Responses are never cached: they show live world state. */
export function json(value: unknown, status: number = 200, headers: Record<string, string> = {}): Response {
	return Response.json(value, { status, headers: { "cache-control": "no-store", ...headers } });
}

/** The request body as JSON; a body that does not parse is the caller's error. */
export async function read<T>(request: Request): Promise<T> {
	try {
		return (await request.json()) as T;
	} catch {
		throw new BadRequest("the body must be JSON");
	}
}

export class BadRequest extends Error {}
