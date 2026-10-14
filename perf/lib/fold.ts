/**
 * Folds `perf script` output into stacks and attributes the samples. celld runs V8 with `--perf-basic-prof`, so
 * JavaScript and WebAssembly frames carry names from /tmp/perf-<pid>.map: QuickJS's own functions are wasm frames,
 * pi-world's cell code and its runtime bundle are JavaScript frames, and the rest is V8 and celld's Rust.
 */

export type Layer = "quickjs wasm" | "runtime js" | "cell js" | "other js" | "v8" | "gc" | "celld native" | "libc/kernel";

export interface Profile {
	readonly samples: number;
	/** Samples whose leaf frame is in each layer. */
	readonly selfByLayer: Readonly<Record<string, number>>;
	/** The functions with the most samples at the leaf. */
	readonly topSelf: readonly { readonly frame: string; readonly layer: Layer; readonly samples: number }[];
	/** The functions with the most samples anywhere on the stack, each counted once per sample. */
	readonly topInclusive: readonly { readonly frame: string; readonly layer: Layer; readonly samples: number }[];
	/** Samples by thread name, so the cell isolates and the facet isolates can be told apart. */
	readonly byThread: Readonly<Record<string, number>>;
	/** Folded stacks, root first, for flamegraph.pl. */
	readonly folded: string;
}

/** Which layer a frame belongs to, from its symbol and its object file. */
export function layer(symbol: string, object: string): Layer {
	if (/wasm-function|^Function:\$|\.wasm|wasm-to-js|js-to-wasm/i.test(symbol)) return "quickjs wasm";
	if (/world-runtime\.js/.test(symbol)) return "runtime js";
	if (/^(JS|LazyCompile|Function|Script|InterpretedFunction|Baseline|Maglev|Turbofan):/.test(symbol) || /\.(js|mjs|ts):\d+/.test(symbol)) {
		if (/worker\.js|pi-world|index\.js/.test(symbol)) return "cell js";
		return "other js";
	}
	if (/Heap::|Scavenger|MarkCompact|Sweeper|GC|Mark(ing)?Visitor|Evacuat/i.test(symbol)) return "gc";
	if (/^Builtin:|^Bytecode|^Stub:|^Handler:|v8::|V8|Isolate::|Runtime_/.test(symbol)) return "v8";
	if (/libc|ld-linux|\[kernel|vdso|libpthread|libm\b/.test(object)) return "libc/kernel";
	if (/celld/.test(object)) return /v8::|_v8_|Builtins_/.test(symbol) ? "v8" : "celld native";
	if (/perf-\d+\.map/.test(object)) return "other js";
	return "celld native";
}

/** Parse `perf script` (default output with call graphs): a header line per sample, then one frame per line. */
export function fold(script: string, top: number = 25): Profile {
	const stacks = new Map<string, number>();
	const self = new Map<string, { layer: Layer; samples: number }>();
	const inclusive = new Map<string, { layer: Layer; samples: number }>();
	const byLayer: Record<string, number> = {};
	const byThread: Record<string, number> = {};
	let samples = 0;
	for (const block of script.split(/\n\s*\n/)) {
		const lines = block.split("\n").filter((l) => l.trim() !== "");
		if (lines.length < 2) continue;
		const thread = lines[0]!.trim().split(/\s+\d+(\/\d+)?\s+/)[0] ?? "?";
		const frames = lines.slice(1).map((line) => {
			const m = /^\s*[0-9a-f]+\s+(.*?)\s+\((.*)\)\s*$/.exec(line);
			const symbol = (m?.[1] ?? line.trim()).replace(/\+0x[0-9a-f]+$/, "");
			const object = m?.[2] ?? "";
			return { symbol: symbol === "[unknown]" ? `[unknown ${object.split("/").pop()}]` : symbol, object };
		});
		samples++;
		byThread[thread] = (byThread[thread] ?? 0) + 1;
		const leaf = frames[0]!;
		const leafLayer = layer(leaf.symbol, leaf.object);
		byLayer[leafLayer] = (byLayer[leafLayer] ?? 0) + 1;
		bump(self, leaf.symbol, leafLayer);
		for (const name of new Set(frames.map((f) => f.symbol))) bump(inclusive, name, layer(name, frames.find((f) => f.symbol === name)!.object));
		const folded = [thread, ...frames.map((f) => f.symbol.replaceAll(";", ":")).reverse()].join(";");
		stacks.set(folded, (stacks.get(folded) ?? 0) + 1);
	}
	const ranked = (m: Map<string, { layer: Layer; samples: number }>) =>
		[...m].sort((a, b) => b[1].samples - a[1].samples).slice(0, top).map(([frame, v]) => ({ frame, layer: v.layer, samples: v.samples }));
	return {
		samples,
		selfByLayer: byLayer,
		topSelf: ranked(self),
		topInclusive: ranked(inclusive),
		byThread,
		folded: [...stacks].map(([stack, n]) => `${stack} ${n}`).join("\n"),
	};
}

function bump(map: Map<string, { layer: Layer; samples: number }>, key: string, l: Layer): void {
	const entry = map.get(key);
	if (entry) entry.samples++;
	else map.set(key, { layer: l, samples: 1 });
}
