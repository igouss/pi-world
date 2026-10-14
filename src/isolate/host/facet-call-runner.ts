import type { CallRunner, CallScope, DataAdmin, ExecuteResult, Refused } from "../../world/call-runner.ts";
import type { DataRow } from "../../world/data-port.ts";
import type { Outcome } from "../../world/world-vm.ts";
import type { RuntimeFacetStub } from "./runtime-loader.ts";

/** The host's side of a world's runtime isolate: calls, previews and data administration all go to the facet. */
export class FacetCallRunner implements CallRunner, DataAdmin {
	private readonly facet: RuntimeFacetStub;

	constructor(facet: RuntimeFacetStub) {
		this.facet = facet;
	}

	call(name: string, args: readonly unknown[], chain: readonly string[], scope: CallScope): Promise<Outcome | Refused> {
		return this.facet.call(name, [...args], [...chain], scope);
	}

	execute(expression: string, scope: CallScope): Promise<ExecuteResult | Refused> {
		return this.facet.execute(expression, scope);
	}

	async list(prefix: string): Promise<readonly DataRow[]> {
		return this.facet.dataList(prefix);
	}

	async delete(key: string): Promise<boolean> {
		return this.facet.dataDelete(key);
	}

	dispose(): void {}
}
