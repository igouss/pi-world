import { readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The harness's directory and the repository's. */
export const PERF: string = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const REPO: string = resolve(PERF, "..");

export function fail(message: string): never {
	throw new Error(message);
}

/** A time as a file name part: 2026-10-14T012818Z. */
export function fileStamp(at: Date): string {
	return at.toISOString().replaceAll(":", "").replace(/\.\d+Z$/, "Z");
}

/** The entries of a directory, or none when it does not exist. */
export function entries(dir: string): string[] {
	try {
		return readdirSync(dir);
	} catch {
		return [];
	}
}
