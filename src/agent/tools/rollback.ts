import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import type { World } from "../../world/world.ts";
import { text } from "./result.ts";

export function rollbackTool(world: World) {
	return defineTool({
		name: "rollback",
		description: "Restore the heap of an earlier revision as a new revision. Data is not rolled back.",
		parameters: Type.Object({
			revision: Type.Integer({ minimum: 0 }),
			reason: Type.String(),
		}),
		replay: "safe",
		executionMode: "sequential",
		execute: async ({ revision, reason }, api, context) => {
			const result = await world.rollback(revision, reason, { by: "agent", taskId: String(api.taskId), callId: api.callId }, (change) =>
				api.commit(change, context),
			);
			return text(`Rolled back to revision ${revision} as revision ${result.n}.`);
		},
	});
}
