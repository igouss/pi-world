/** A readable, URL-safe id: the name's slug and a random suffix, such as "todo-list-3fa9c1". */
export function worldId(name: string, random: Uint8Array): string {
	const slug = name
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40);
	const suffix = [...random].map((b) => b.toString(16).padStart(2, "0")).join("");
	return slug ? `${slug}-${suffix}` : `world-${suffix}`;
}

export const WORLD_ID: RegExp = /^[a-z0-9-]{1,64}$/;
