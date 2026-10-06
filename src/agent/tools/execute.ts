import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import type { World } from "../../world/world.ts";
import { show, text } from "./result.ts";

export function executeTool(world: World) {
	return defineTool({
		name: "execute",
		description:
			"Evaluate one JavaScript expression against the current world and its data, and return its JSON value. Heap changes are discarded; data writes are kept.",
		parameters: Type.Object({
			expression: Type.String({ description: "An expression, for example shoutBackwards(\"Hello\")" }),
		}),
		executionMode: "sequential",
		execute: async ({ expression }) => {
			const outcome = await world.execute(expression);
			return outcome.ok ? text(show(outcome.value)) : text(`${outcome.failure}: ${outcome.error}`, true);
		},
	});
}
