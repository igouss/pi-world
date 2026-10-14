import type { Check } from "../../check/check.ts";
import type { Enrolment } from "../../world/attempt.ts";
import type { Candidate, Developed, Heap, Workbench } from "../../world/workbench.ts";
import type { AttemptMode, CatalogueEntry } from "../../world/world-vm.ts";
import type { RuntimeFacetStub } from "./runtime-loader.ts";

/** The host's side of a world's runtime isolate for changes: the VM work of every develop, check and rollback goes to the facet. */
export class FacetWorkbench implements Workbench {
	private readonly facet: RuntimeFacetStub;

	constructor(facet: RuntimeFacetStub) {
		this.facet = facet;
	}

	genesis(): Promise<Heap> {
		return this.facet.workbenchGenesis();
	}

	open(head: string, prelude: number): Promise<{ readonly catalogue: readonly CatalogueEntry[]; readonly upgraded: Heap | undefined }> {
		return this.facet.workbenchOpen(head, prelude);
	}

	develop(head: string, source: string, checks: readonly Check[], mode: AttemptMode): Promise<Developed> {
		return this.facet.workbenchDevelop(head, source, [...checks], mode);
	}

	enrol(head: string, candidate: Candidate, mode: AttemptMode): Promise<Enrolment> {
		return this.facet.workbenchEnrol(head, candidate, mode);
	}

	rollback(target: string, prelude: number): Promise<Heap> {
		return this.facet.workbenchRollback(target, prelude);
	}

	dispose(): void {}
}
