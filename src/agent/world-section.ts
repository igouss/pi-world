import type { World } from "../world/world.ts";

/**
 * Revision-level facts only, so the text changes exactly when the world does and the provider's prompt cache holds
 * between revisions.
 */
export function renderWorld(world: World): string {
	const head = world.head();
	const catalogue = world.catalogue();
	const checks = world.checks().checks;
	const lines = [`Revision ${head.revision}.`];
	lines.push(catalogue.length ? "Definitions:" : "No definitions yet.");
	for (const entry of catalogue) lines.push(`- ${entry.kind === "class" ? "class " : ""}${entry.name}(${entry.params})${entry.doc ? `: ${entry.doc}` : ""}`);
	if (checks.length) {
		lines.push("Checks:");
		for (const check of checks) lines.push(`- ${check.name}: ${check.expression}`);
	}
	return lines.join("\n");
}
