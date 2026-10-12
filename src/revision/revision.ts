import type { CatalogueChanges } from "../world/catalogue-diff.ts";

/** Who produced a revision: a tool call of the agent, or an operator request over REST. */
export type Origin =
	| { readonly by: "agent"; readonly taskId: string; readonly callId: string }
	| { readonly by: "operator"; readonly requestId?: string }
	| { readonly by: "host" };

/** A develop source as evaluated and, when the host rewrite changed it, as written. */
export interface DevelopSources {
	/** The source as evaluated, after the host rewrite; this is what replays. */
	readonly source: string;
	/** The source as written, when the host rewrite changed it. */
	readonly written?: string;
}

/** Both texts of a develop source as written, keeping `written` only when the rewrite changed it. */
export function developSources(written: string, evaluated: string): DevelopSources {
	return evaluated === written ? { source: evaluated } : { source: evaluated, written };
}

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
	| (RevisionBase & DevelopSources & { readonly kind: "develop" })
	| (RevisionBase & { readonly kind: "rollback"; readonly target: number; readonly reason: string })
	| (RevisionBase & { readonly kind: "upgrade"; readonly from: number });

export interface Head {
	readonly revision: number;
	readonly blob: string;
	/** Tool calls that produced a revision, so a rerun after a crash returns the same revision. */
	readonly calls: Readonly<Record<string, number>>;
}
