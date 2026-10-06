import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import type { World } from "../../world/world.ts";
import { text } from "./result.ts";

export function developTool(world: World) {
	return defineTool({
		name: "develop",
		description:
			"Change the world: evaluate a JavaScript source of define/state/undefine calls against a checkpoint. Accepted as a new revision when it evaluates cleanly and every check holds; otherwise the world is restored and the reason returned.",
		parameters: Type.Object({
			source: Type.String({ description: "JavaScript source; runs once as a function body" }),
			summary: Type.String({ description: "One line: what this change does" }),
		}),
		replay: "safe",
		executionMode: "sequential",
		execute: async ({ source, summary }, api, context) => {
			const result = await world.develop(source, summary, { by: "agent", taskId: String(api.taskId), callId: api.callId }, (change) =>
				api.commit(change, context),
			);
			if (result.status === "rejected") {
				const what = result.check ? `broke the check "${result.check}"` : result.failure;
				return text(`Rejected (${what}). The world is unchanged at revision ${world.head().revision}.\n${result.reason}`, true);
			}
			const { n, changes } = result.revision;
			const parts = [
				changes.added.length ? `added ${changes.added.join(", ")}` : "",
				changes.changed.length ? `changed ${changes.changed.join(", ")}` : "",
				changes.removed.length ? `removed ${changes.removed.join(", ")}` : "",
			].filter(Boolean);
			return text(`Accepted as revision ${n}${parts.length ? `: ${parts.join("; ")}` : " (no definitions changed)"}.`);
		},
	});
}
