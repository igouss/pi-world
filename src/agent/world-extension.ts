import { defineExtension, section } from "@earendil-works/pi-durable";
import type { World } from "../world/world.ts";
import { PREAMBLE } from "./preamble.ts";
import { describeTool } from "./tools/describe.ts";
import { developTool } from "./tools/develop.ts";
import { executeTool } from "./tools/execute.ts";
import { historyTool } from "./tools/history.ts";
import { proposeCheckTool } from "./tools/propose-check.ts";
import { rollbackTool } from "./tools/rollback.ts";
import { renderWorld } from "./world-section.ts";

/** Everything the agent gets: the standing instructions, the world section and the world tools. */
export function worldExtension(world: World) {
	return defineExtension({
		name: "world",
		sections: [section("preamble", () => PREAMBLE, { tag: false }), section("world", () => renderWorld(world))],
		tools: [developTool(world), executeTool(world), describeTool(world), historyTool(world), rollbackTool(world), proposeCheckTool(world)],
	});
}
