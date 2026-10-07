import type { AccountCell } from "./account/account-cell.ts";
import type { DirectoryCell } from "./directory/directory-cell.ts";
import type { WorldCell } from "./cell/world-cell.ts";

/** The bindings declared in wrangler.jsonc. */
export interface Env {
	readonly WORLD: DurableObjectNamespace<WorldCell>;
	readonly ACCOUNT: DurableObjectNamespace<AccountCell>;
	readonly DIRECTORY: DurableObjectNamespace<DirectoryCell>;
	readonly ASSETS: Fetcher;
	/** Snapshot blobs other than each world's head. */
	readonly SNAPSHOTS: R2Bucket;
	readonly LOADER: WorkerLoader;
}

declare global {
	namespace Cloudflare {
		/** Types `ctx.exports`: the loopback bindings of the main module's exports. */
		interface GlobalProps {
			mainModule: typeof import("./worker.ts");
			durableNamespaces: "WorldCell" | "AccountCell" | "DirectoryCell";
		}
	}
}

export const ACCOUNT_NAME: string = "account";
export const DIRECTORY_NAME: string = "directory";
