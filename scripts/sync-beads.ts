#!/usr/bin/env node
/**
 * Pushes this repo's beads into a Beads board world: every bead with its dependencies, read from `br`, imported by the
 * world's `importBeads` in one call. Usage: `npm run sync-beads -- [world]` (default "Beads board"; PW_SERVER as for pw).
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runMain } from "../cli/run-main.ts";
import { serverFromEnv } from "../cli/server.ts";
import { resolveWorld } from "../cli/world-ref.ts";
import { createClient, type Client } from "../src/api/client.ts";
import { appPath } from "../src/api/paths.ts";
import type { CallResult, WorldListing } from "../src/api/types.ts";

const run = promisify(execFile);

/** `br list --json`: the beads' ids, and how many there are. */
interface BrListing {
	readonly issues: readonly { readonly id: string }[];
	readonly total: number;
}

/** A bead as `br show --json` prints it, with the fields the board reads. */
interface BrBead {
	readonly id: string;
	readonly title: string;
	readonly status: string;
	readonly issue_type: string;
	readonly priority: number;
	readonly labels?: readonly string[];
	readonly updated_at: string;
	readonly description?: string;
	readonly dependencies?: readonly { readonly id: string; readonly dependency_type: string }[];
}

/** A bead as the board's `importBeads` takes it. */
interface BoardBead {
	readonly id: string;
	readonly title: string;
	readonly status: string;
	readonly type: string;
	readonly priority: number;
	readonly labels: readonly string[];
	readonly updatedAt: string;
	readonly description: string;
	readonly deps: readonly { readonly id: string; readonly kind: string }[];
}

const DESCRIPTION_CHARS: number = 300;

async function br(...args: string[]): Promise<unknown> {
	const { stdout } = await run("br", [...args, "--json"], { maxBuffer: 64 * 1024 * 1024 });
	return JSON.parse(stdout);
}

function toBoard(bead: BrBead): BoardBead {
	return {
		id: bead.id,
		title: bead.title,
		status: bead.status,
		type: bead.issue_type,
		priority: bead.priority,
		labels: bead.labels ?? [],
		updatedAt: bead.updated_at,
		description: (bead.description ?? "").slice(0, DESCRIPTION_CHARS),
		deps: (bead.dependencies ?? []).map((dep) => ({ id: dep.id, kind: dep.dependency_type })),
	};
}

runMain("sync-beads", async () => {
	const client: Client = createClient(serverFromEnv());
	const world: WorldListing = resolveWorld(await client.worlds(), process.argv[2] ?? "Beads board");
	const listing: BrListing = (await br("list", "--all", "--limit", "0")) as BrListing;
	if (listing.issues.length !== listing.total) throw new Error(`br listed ${listing.issues.length} of ${listing.total} beads`);
	const beads: readonly BrBead[] = listing.issues.length ? ((await br("show", ...listing.issues.map((issue) => issue.id))) as BrBead[]) : [];
	const result: CallResult = await client.call(world.id, "importBeads", [beads.map(toBoard)]);
	if (!result.ok) throw new Error(`importBeads failed (${result.failure}): ${result.error}`);
	console.log(`${beads.length} beads into ${world.name} (${world.id}): ${JSON.stringify(result.value)}`);
	console.log(`${client.base}${appPath(world.id)}`);
});
