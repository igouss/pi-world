import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import type { World } from "../../world/world.ts";
import { text } from "./result.ts";

export function proposeCheckTool(world: World) {
	return defineTool({
		name: "propose_check",
		description:
			"Propose a check: an expression that must be exactly true after every future develop. Enrolled only if it holds now and is false (or throws) once the counterexample source is applied.",
		parameters: Type.Object({
			name: Type.String({ description: "What the check protects, in a few words" }),
			expression: Type.String({ description: "A JavaScript expression; must not touch data" }),
			counterexample: Type.String({ description: "A develop source that breaks the behaviour" }),
		}),
		replay: "safe",
		executionMode: "sequential",
		execute: async ({ name, expression, counterexample }, api, context) => {
			const result = await world.proposeCheck(name, expression, counterexample, (change) => api.commit(change, context));
			return result.status === "enrolled" ? text(`Enrolled the check "${name}".`) : text(`Refused: ${result.reason}`, true);
		},
	});
}
