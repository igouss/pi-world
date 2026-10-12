import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import { rejectionCause, type Rejection } from "../../revision/rejection.ts";
import type { World } from "../../world/world.ts";
import { text } from "./result.ts";
import { firstLine } from "../../api/text.ts";

export function historyTool(world: World) {
	return defineTool({
		name: "history",
		description: "List revisions, newest first. With rejected: true, list rejected develops and refused checks instead, with their reasons.",
		parameters: Type.Object({
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
			rejected: Type.Optional(Type.Boolean({ description: "List rejected attempts instead of revisions" })),
		}),
		execute: async ({ limit, rejected }) => {
			if (rejected) {
				const rejections = await world.rejections(limit ?? 20);
				return text(rejections.length ? rejections.map(describeRejection).join("\n") : "No attempt has been rejected.");
			}
			const revisions = await world.history(limit ?? 20);
			return text(revisions.map((r) => `${r.n} ${r.kind}: ${r.summary}`).join("\n"));
		},
	});
}

function describeRejection(r: Rejection): string {
	return `#${r.n} on revision ${r.base}, ${r.kind}: ${r.summary} (${rejectionCause(r)}): ${firstLine(r.reason)}`;
}
