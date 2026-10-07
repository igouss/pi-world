import type { CallRunner, ExecuteResult, HeadRef } from "../world/call-runner.ts";
import type { DataRow } from "../world/data-port.ts";
import type { Outcome } from "../world/world-vm.ts";
import type { RuntimeFacet } from "./runtime-facet.ts";

/** The host's side of a world's runtime isolate: every call, preview and data operation goes to the facet. */
export class FacetCallRunner implements CallRunner {
	constructor(
		private readonly self: string,
		private readonly facet: () => Rpc.DurableObjectBranded & RuntimeFacet,
	) {}

	call(name: string, args: readonly unknown[], chain: readonly string[], head: HeadRef): Promise<Outcome> {
		return this.facet().call(this.self, name, [...args], [...chain], head);
	}

	execute(expression: string, chain: readonly string[], head: HeadRef): Promise<ExecuteResult> {
		return this.facet().execute(this.self, expression, [...chain], head);
	}

	async dataList(prefix: string): Promise<readonly DataRow[]> {
		return this.facet().dataList(prefix);
	}

	async dataDelete(key: string): Promise<boolean> {
		return this.facet().dataDelete(key);
	}

	dispose(): void {}
}
