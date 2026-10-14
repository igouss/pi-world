import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import type { Incident } from "../../incident/incident.ts";
import { failureKind } from "../../world/call-runner.ts";
import type { World } from "../../world/world.ts";
import { show, text } from "./result.ts";
import { firstLine } from "../../api/text.ts";

/** Failed calls, open ones first: what the owner asks the agent to fix. */
export function incidentsTool(world: World) {
	return defineTool({
		name: "incidents",
		description:
			"List the calls of this world's definitions that failed and are still open, or show one incident in full: its arguments, error and how often it happened. Fix the definition with develop, then retry_incident.",
		parameters: Type.Object({ n: Type.Optional(Type.Integer({ minimum: 0, description: "One incident to show in full" })) }),
		execute: async ({ n }) => {
			if (n !== undefined) {
				const incident = await world.incidents.get(n);
				return incident ? text(describeIncident(incident)) : text(`No incident ${n}.`, true);
			}
			const open = await world.incidents.openOnes();
			return text(open.length ? open.map(summary).join("\n") : "No open incident.");
		},
	});
}

export function retryIncidentTool(world: World) {
	return defineTool({
		name: "retry_incident",
		description: "Call an open incident's definition again with its arguments, at the current revision. Success closes the incident; a failure keeps it open.",
		parameters: Type.Object({ n: Type.Integer({ minimum: 0 }) }),
		execute: async ({ n }, api, context) => {
			const outcome = await world.retryIncident(n, "agent", (change) => api.commit(change, context));
			return outcome.ok ? text(`Incident ${n} closed: the call returned ${show(outcome.value)}`) : text(`Still failing (${failureKind(outcome)}): ${outcome.error}`, true);
		},
	});
}

function summary(incident: Incident): string {
	return `#${incident.n} ${incident.name} at revision ${incident.revision}, ${incident.count}× (${incident.failure}): ${firstLine(incident.error)}`;
}

function describeIncident(incident: Incident): string {
	const state = incident.resolution ? `closed (${incident.resolution.kind})` : "open";
	return [
		`incident #${incident.n}, ${state}: ${incident.name} failed ${incident.count}× (${incident.failure}), last at revision ${incident.revision}${incident.retries ? `, ${incident.retries} failed retries` : ""}`,
		incident.args ? `args: ${show(incident.args)}` : "args: not kept (too large)",
		"error:",
		incident.error,
	].join("\n");
}
