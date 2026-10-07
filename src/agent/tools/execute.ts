import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import type { World } from "../../world/world.ts";
import { show, text } from "./result.ts";

export function executeTool(world: World) {
	return defineTool({
		name: "execute",
		description:
			"Evaluate one JavaScript expression against the current world and its data, and return its JSON value. A preview: heap changes and this world's data writes are rolled back, and the result lists the writes it rolled back. Other worlds it calls write for real.",
		parameters: Type.Object({
			expression: Type.String({ description: "An expression, for example shoutBackwards(\"Hello\")" }),
		}),
		executionMode: "sequential",
		execute: async ({ expression }) => {
			const outcome = await world.execute(expression);
			const { set, deleted } = outcome.rolledBack;
			const writes = [set.length ? `set ${set.join(", ")}` : "", deleted.length ? `deleted ${deleted.join(", ")}` : ""].filter(Boolean);
			const note = writes.length ? `\nData writes rolled back: ${writes.join("; ")}.` : "";
			return outcome.ok ? text(show(outcome.value) + note) : text(`${outcome.failure}: ${outcome.error}${note}`, true);
		},
	});
}
