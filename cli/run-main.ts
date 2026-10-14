import { errorMessage } from "../src/api/text.ts";

/** Runs a command's `main`; a failure prints `<name>: <message>` and exits with status 1. */
export function runMain(name: string, main: () => Promise<void>): void {
	main().catch((error: unknown) => {
		console.error(`${name}: ${errorMessage(error)}`);
		process.exitCode = 1;
	});
}
