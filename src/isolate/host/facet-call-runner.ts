import type { CallRunner, DataAdmin, ExecuteResult, HeadRef } from "../../world/call-runner.ts";
import type { DataRow } from "../../world/data-port.ts";
import type { Outcome } from "../../world/world-vm.ts";
import type { RuntimeFacetStub } from "./runtime-loader.ts";

/** The host's side of a world's runtime isolate: calls, previews and data administration all go to the facet. */
export class FacetCallRunner implements CallRunner, DataAdmin {
	constructor(private readonly facet: RuntimeFacetStub) {}

	call(name: string, args: readonly unknown[], chain: readonly string[], head: HeadRef): Promise<Outcome> {
		return this.facet.call(name, [...args], [...chain], head);
	}

	execute(expression: string, head: HeadRef): Promise<ExecuteResult> {
		return this.facet.execute(expression, head);
	}

	async list(prefix: string): Promise<readonly DataRow[]> {
		return this.facet.dataList(prefix);
	}

	async delete(key: string): Promise<boolean> {
		return this.facet.dataDelete(key);
	}

	dispose(): void {}
}
