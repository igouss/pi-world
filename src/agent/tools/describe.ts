import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import type { World } from "../../world/world.ts";
import { text } from "./result.ts";

const SCANNED_REVISIONS: number = 200;

export function describeTool(world: World) {
	return defineTool({
		name: "describe",
		description: "Show the current source, doc and version of one definition, and the revisions that touched it.",
		parameters: Type.Object({ name: Type.String() }),
		execute: async ({ name }) => {
			const entry = world.catalogue().find((candidate) => candidate.name === name);
			const touched = (await world.history(SCANNED_REVISIONS))
				.filter((r) => r.changes.added.includes(name) || r.changes.changed.includes(name) || r.changes.removed.includes(name))
				.map((r) => `  ${r.n}: ${r.summary}`);
			if (!entry) return text(`${name} is not defined at revision ${world.head().revision}.${touched.length ? `\nRevisions that touched it:\n${touched.join("\n")}` : ""}`, true);
			return text(
				[
					`${entry.kind} ${entry.name}(${entry.params}) @${entry.version}`,
					entry.doc ? `doc: ${entry.doc}` : "doc: (none)",
					"source:",
					entry.source,
					touched.length ? `revisions:\n${touched.join("\n")}` : "",
				]
					.filter(Boolean)
					.join("\n"),
			);
		},
	});
}
