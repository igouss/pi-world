import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import type { World } from "../../world/world.ts";
import { text } from "./result.ts";

export function proposeCheckTool(world: World) {
	return defineTool({
		name: "propose_check",
		description:
			"Propose a check: an expression that must be exactly true after every future develop. With a generator it is a property check: the expression must be true for every generated `input`. Enrolled only if it holds now and is false (or throws) once the counterexample source is applied.",
		parameters: Type.Object({
			name: Type.String({ description: "What the check protects, in a few words" }),
			expression: Type.String({
				description: "A JavaScript expression. It may use data, which is a fresh empty store for each run, never the world's data. In a property check it reads `input`.",
			}),
			counterexample: Type.String({ description: "A develop source that breaks the behaviour" }),
			generator: Type.Optional(
				Type.Unknown({
					description:
						'For a property check, how `input` is generated, as JSON: {"int":[min,max]}, {"bool":true}, {"string":{"max":10,"alphabet":"ab"}}, {"oneOf":[values]}, {"const":value}, {"array":generator,"min":0,"max":10}, {"record":{"key":generator}}',
				}),
			),
		}),
		replay: "safe",
		executionMode: "sequential",
		execute: async ({ name, expression, counterexample, generator }, api, context) => {
			const origin = { by: "agent", taskId: String(api.taskId), callId: api.callId } as const;
			const result = await world.proposeCheck({ name, expression, counterexample, generator }, origin, (change) => api.commit(change, context));
			return result.status === "enrolled" ? text(`Enrolled the check "${name}".`) : text(`Refused: ${result.rejection.reason}`, true);
		},
	});
}
