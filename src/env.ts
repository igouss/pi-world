import type { AccountCell } from "./account/account-cell.ts";
import type { DirectoryCell } from "./directory/directory-cell.ts";
import type { WorldCell } from "./cell/world-cell.ts";

/** The bindings declared in wrangler.jsonc. */
export interface Env {
	readonly WORLD: DurableObjectNamespace<WorldCell>;
	readonly ACCOUNT: DurableObjectNamespace<AccountCell>;
	readonly DIRECTORY: DurableObjectNamespace<DirectoryCell>;
	readonly ASSETS: Fetcher;
	readonly LOADER: { get(id: string, code: () => object): { getDurableObjectClass(name: string): unknown } };
}

export const ACCOUNT_NAME: string = "account";
export const DIRECTORY_NAME: string = "directory";
