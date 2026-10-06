import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import type { World } from "../../world/world.ts";
import { text } from "./result.ts";

export function historyTool(world: World) {
	return defineTool({
		name: "history",
		description: "List revisions, newest first.",
		parameters: Type.Object({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) }),
		execute: async ({ limit }) => {
			const revisions = await world.history(limit ?? 20);
			return text(revisions.map((r) => `${r.n} ${r.kind}: ${r.summary}`).join("\n"));
		},
	});
}
