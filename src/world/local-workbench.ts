import { contentHash } from "../revision/blob-store.ts";
import type { Check } from "../check/check.ts";
import { attemptDevelop, attemptEnrolment, type Enrolment } from "./attempt.ts";
import type { Candidate, Developed, Heap, Workbench } from "./workbench.ts";
import { WorldVm, type AttemptMode, type CatalogueEntry } from "./world-vm.ts";
import type { Snapshot } from "quickjs-wasi";

export interface LocalWorkbenchDeps {
	readonly wasm: WebAssembly.Module;
	/** A snapshot blob by its content hash. */
	readonly blob: (hash: string) => Promise<Uint8Array>;
}

/** A workbench with its VM in this isolate. */
export class LocalWorkbench implements Workbench {
	private vm: WorldVm | undefined;
	/** The blob the VM's heap is: the head it was restored at, or the last heap it made. */
	private at: string | undefined;
	private readonly deps: LocalWorkbenchDeps;

	constructor(deps: LocalWorkbenchDeps) {
		this.deps = deps;
	}

	async genesis(): Promise<Heap> {
		this.vm?.dispose();
		this.vm = await WorldVm.create(this.deps.wasm);
		return this.made(this.vm, this.vm.snapshot());
	}

	async open(head: string, prelude: number): Promise<{ catalogue: readonly CatalogueEntry[]; upgraded: Heap | undefined }> {
		const vm = await this.atBlob(head);
		if (prelude >= WorldVm.preludeVersion) return { catalogue: vm.catalogue(), upgraded: undefined };
		vm.upgrade(prelude);
		const upgraded = await this.made(vm, vm.snapshot());
		return { catalogue: upgraded.catalogue, upgraded };
	}

	async develop(head: string, source: string, checks: readonly Check[], mode: AttemptMode): Promise<Developed> {
		const vm = await this.atBlob(head);
		const attempt = await attemptDevelop(vm, source, checks, mode);
		if (!attempt.accepted) return attempt;
		return { accepted: true, heap: await this.made(vm, attempt.snapshot, attempt.catalogue), changes: attempt.changes };
	}

	async enrol(head: string, candidate: Candidate, mode: AttemptMode): Promise<Enrolment> {
		return attemptEnrolment(await this.atBlob(head), candidate, mode);
	}

	async rollback(target: string, prelude: number): Promise<Heap> {
		const vm = await this.atBlob(target);
		if (prelude < WorldVm.preludeVersion) vm.upgrade(prelude);
		return this.made(vm, vm.snapshot());
	}

	dispose(): void {
		this.vm?.dispose();
		this.vm = undefined;
		this.at = undefined;
	}

	/** The VM, at `blob`'s heap: as it is when it already holds that heap, else restored from the blob. */
	private async atBlob(blob: string): Promise<WorldVm> {
		if (this.vm && this.at === blob) return this.vm;
		const snapshot = WorldVm.deserialize(await this.deps.blob(blob));
		if (this.vm) await this.vm.reset(snapshot);
		else this.vm = await WorldVm.fromSnapshot(snapshot, this.deps.wasm);
		this.at = blob;
		return this.vm;
	}

	/** A heap the VM now holds, serialized and hashed; the VM is at it from here on. */
	private async made(vm: WorldVm, snapshot: Snapshot, catalogue: readonly CatalogueEntry[] = vm.catalogue()): Promise<Heap> {
		const bytes = WorldVm.serialize(snapshot);
		const blob = await contentHash(bytes);
		this.at = blob;
		return { bytes, blob, catalogue };
	}
}
