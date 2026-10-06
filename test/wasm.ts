import { readFile } from "node:fs/promises";

export const wasm: WebAssembly.Module = await WebAssembly.compile(
	await readFile(new URL(import.meta.resolve("quickjs-wasi/quickjs.wasm"))),
);
