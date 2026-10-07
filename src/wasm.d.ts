declare module "*.wasm" {
	const module: WebAssembly.Module;
	export default module;
}

/** A bundle read as text, for a Worker Loader's module map. */
declare module "*.txt" {
	const text: string;
	export default text;
}

/** Raw bytes, such as a wasm binary a Worker Loader compiles itself. */
declare module "*.bin" {
	const bytes: ArrayBuffer;
	export default bytes;
}
