// Experiment: the world prelude, a registry with stable stubs (the vtable) and a keep-if-present state form.
// Checks: captured references and old instances follow a redefinition; a subclass follows its redefined base;
// a redefined source keeps its state; a restored checkpoint undoes state writes; a version bump migrates state;
// an active frame keeps the body it was running; a top-level `let` cannot be re-evaluated as a script.
import { readFile } from "node:fs/promises";
import { QuickJS } from "quickjs-wasi";

const wasm = await WebAssembly.compile(await readFile(new URL(import.meta.resolve("quickjs-wasi/quickjs.wasm"))));
let vm = await QuickJS.create({ wasm });
const run = (code) => {
	try {
		return vm.evalCode(code).consume((h) => h.toString());
	} catch (error) {
		const message = error.message ?? String(error);
		error.dispose?.();
		return "THROWS: " + message;
	}
};
const develop = (source) => run(`(() => { ${source} })()`);

const prelude = `
	const defs = new Map();      // name -> implementation; the global is a stable stub that dispatches here
	const states = new Map();    // name -> { value, version, init }
	globalThis.define = (name, impl) => {
		const isClass = typeof impl === "function" && /^class\\b/.test(Function.prototype.toString.call(impl));
		let stub = defs.has(name) ? globalThis[name] : undefined;
		if (!stub) {
			stub = function (...args) {
				const current = defs.get(name);
				return new.target ? Reflect.construct(current, args, new.target) : current.apply(this, args);
			};
			stub.prototype = isClass ? impl.prototype : undefined;
			Object.defineProperty(globalThis, name, { value: stub, writable: false, configurable: false });
		} else if (isClass) {
			const proto = stub.prototype;
			for (const k of Object.getOwnPropertyNames(proto)) if (k !== "constructor" && !(k in impl.prototype)) delete proto[k];
			for (const k of Object.getOwnPropertyNames(impl.prototype))
				if (k !== "constructor") Object.defineProperty(proto, k, Object.getOwnPropertyDescriptor(impl.prototype, k));
		}
		defs.set(name, impl);
	};
	globalThis.state = (name, init, { version = 1, migrate } = {}) => {
		const entry = states.get(name);
		if (entry && entry.version === version) return entry.value;
		const value = entry && migrate ? migrate(entry.value) : init();
		if (value === null || typeof value !== "object") throw new TypeError(name + ": state must be an object, not " + typeof value);
		states.set(name, { value, version, init: init.toString() });
		return value;
	};
	globalThis.listState = () => [...states].map(([n, e]) => n + "@" + e.version).join(",");
`;
run(prelude);

console.log("top-level let twice as scripts:", run("let c = 1; 1"), "|", run("let c = 2; 2"));

develop(`define("greet", (n) => "hi " + n); globalThis.captured = greet; globalThis.table = { h: greet };`);
develop(`define("greet", (n) => "HELLO " + n);`);
console.log("captured reference, table entry:", run("captured('a')"), "|", run("table.h('b')"));

develop(`define("User", class { constructor(n) { this.n = n; } who() { return "user " + this.n; } }); globalThis.u = new User("ann");`);
develop(`define("User", class { constructor(n) { this.n = n; } who() { return "USER " + this.n; } tag() { return "new"; } });`);
console.log("old instance:", run("u.who()"), run("u.tag()"), "instanceof", run("String(u instanceof User)"), "| new:", run("new User('bob').who()"));
develop(`define("Admin", class extends User { who() { return "admin:" + super.who(); } }); globalThis.ad = new Admin("root");`);
develop(`define("User", class { constructor(n) { this.n = n; } who() { return "user3 " + this.n; } });`);
console.log("subclass after base redefined:", run("ad.who()"), "| removed method:", run("String(typeof u.tag)"));

const lookup = (miss) => `const cache = state("lookup.cache", () => new Map());
	define("lookup", (k) => cache.get(k) ?? "${miss}"); define("remember", (k, v) => cache.set(k, v));`;
develop(lookup("miss"));
run(`remember("a", "A")`);
develop(lookup("MISS"));
console.log("redefined source keeps state:", run(`lookup("a")`), "|", run(`lookup("zz")`));

const checkpoint = vm.snapshot();
run(`remember("b", "B"); state("extra", () => ({}))`);
vm.dispose();
vm = await QuickJS.restore(checkpoint, { wasm });
console.log("restored checkpoint: b =", run(`lookup("b")`), "| states:", run("listState()"));

develop(`state("lookup.cache", () => new Map(), { version: 2, migrate: (old) => new Map([...old].map(([k, v]) => [k, v.toLowerCase()])) });`);
console.log("version bump with migrate:", run(`lookup("a")`), "| states:", run("listState()"));
console.log("primitive state:", run(`state("n", () => 0)`));

run(`globalThis.job = (async () => { const before = greet("frame"); await new Promise((r) => (globalThis.resume = r)); globalThis.out = before + " / " + greet("after"); })();`);
vm.executePendingJobs();
develop(`define("greet", (n) => "third " + n);`);
run("resume()");
vm.executePendingJobs();
console.log("active frame across redefinition:", run("out"));
vm.dispose();
