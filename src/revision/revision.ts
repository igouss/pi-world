import type { CatalogueChanges } from "../world/catalogue-diff.ts";

/** Who produced a revision: a tool call of the agent, or an operator request over REST. */
export type Origin =
	| { readonly by: "agent"; readonly taskId: string; readonly callId: string }
	| { readonly by: "operator"; readonly requestId?: string }
	| { readonly by: "host" };

interface RevisionBase {
	readonly n: number;
	readonly parent: number | null;
	readonly summary: string;
	readonly blob: string;
	readonly bytes: number;
	readonly at: number;
	readonly prelude: number;
	readonly origin: Origin;
	readonly changes: CatalogueChanges;
}

/**
 * One immutable revision of a world. Only `develop` sources replay; a rollback names the revision it restored; an
 * upgrade brings the heap to a newer prelude.
 */
export type Revision =
	| (RevisionBase & { readonly kind: "genesis" })
	| (RevisionBase & { readonly kind: "develop"; readonly source: string })
	| (RevisionBase & { readonly kind: "rollback"; readonly target: number; readonly reason: string })
	| (RevisionBase & { readonly kind: "upgrade"; readonly from: number });

export interface Head {
	readonly revision: number;
	readonly blob: string;
	/** Tool calls that produced a revision, so a rerun after a crash returns the same revision. */
	readonly calls: Readonly<Record<string, number>>;
}
