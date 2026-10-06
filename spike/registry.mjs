// Experiment: the world prelude, a registry with stable stubs (the vtable) and a keep-if-present state form.
// Checks: captured references and old instances follow a redefinition; a subclass follows its redefined base;
// a class version bump migrates every live instance eagerly, and is rejected without a migrate or when the
// migrate throws; a redefined source keeps its state; a restored checkpoint undoes state writes and migrations;
// a version bump migrates state; an active frame keeps the body it was running; a top-level `let` cannot be
// re-evaluated as a script; built-ins are frozen, so world code cannot change what a check calls.
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
	const defs = new Map();      // name -> { impl, version, instances }; the global is a stable stub that dispatches here
	const states = new Map();    // name -> { value, version, init }
	const VERSION = Symbol("version");
	globalThis.define = (name, impl, { version = 1, migrate } = {}) => {
		const isClass = typeof impl === "function" && /^class\\b/.test(Function.prototype.toString.call(impl));
		const entry = defs.get(name);
		if (!entry) {
			const instances = new Set();   // WeakRefs to every instance built through the stub
			const stub = function (...args) {
				const current = defs.get(name);
				if (!new.target) return current.impl.apply(this, args);
				const instance = Reflect.construct(current.impl, args, new.target);
				instance[VERSION] = current.version;
				instances.add(new WeakRef(instance));
				return instance;
			};
			stub.prototype = isClass ? impl.prototype : undefined;
			Object.defineProperty(globalThis, name, { value: stub, writable: false, configurable: false });
			defs.set(name, { impl, version, instances });
			return;
		}
		if (isClass && version !== entry.version) {
			// Eager: every live instance migrates inside the attempt, so a throw here rejects the develop.
			const live = [...entry.instances].map((ref) => ref.deref()).filter(Boolean);
			if (!migrate) throw new Error(name + "@" + entry.version + " -> @" + version + " needs a migrate: " + live.length + " live instance(s)");
			for (const instance of live) {
				migrate(instance, { from: entry.version, to: version });
				instance[VERSION] = version;
			}
		}
		if (isClass) {
			const proto = globalThis[name].prototype;
			for (const k of Object.getOwnPropertyNames(proto)) if (k !== "constructor" && !(k in impl.prototype)) delete proto[k];
			for (const k of Object.getOwnPropertyNames(impl.prototype))
				if (k !== "constructor") Object.defineProperty(proto, k, Object.getOwnPropertyDescriptor(impl.prototype, k));
		}
		entry.impl = impl;
		entry.version = version;
	};
	globalThis.versionOf = (instance) => instance[VERSION];
	globalThis.state = (name, init, { version = 1, migrate } = {}) => {
		const entry = states.get(name);
		if (entry && entry.version === version) return entry.value;
		const value = entry && migrate ? migrate(entry.value) : init();
		if (value === null || typeof value !== "object") throw new TypeError(name + ": state must be an object, not " + typeof value);
		states.set(name, { value, version, init: init.toString() });
		return value;
	};
	globalThis.listState = () => [...states].map(([n, e]) => n + "@" + e.version).join(",");
	// Lock the built-ins, so world code cannot weaken a check by changing what the check calls.
	for (const ctor of [Object, Function, Array, String, Number, Boolean, Symbol, Map, Set, WeakMap, WeakSet, Promise, RegExp, Date, Error, JSON, Math, Reflect])
		for (const target of [ctor, ctor.prototype]) if (target) Object.freeze(target);
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

develop(`define("Point", class { constructor(x, y) { this.x = x; this.y = y; } norm() { return Math.hypot(this.x, this.y); } }); globalThis.p = new Point(3, 4);`);
console.log("class bump without migrate, instance live:", develop(`define("Point", class { norm() { return this.rho; } }, { version: 2 });`));
console.log("class bump, migrate throws:", develop(`define("Point", class { norm() { return this.rho; } }, { version: 2, migrate: () => { throw new Error("no"); } });`), "| instance intact:", run("p.norm()"));
const beforeMigration = vm.snapshot();
develop(`define("Point", class { constructor(rho, theta) { this.rho = rho; this.theta = theta; } norm() { return this.rho; } },
	{ version: 2, migrate: (pt) => { pt.rho = Math.hypot(pt.x, pt.y); pt.theta = Math.atan2(pt.y, pt.x); delete pt.x; delete pt.y; } });`);
console.log("class bump with migrate: slots", run("Object.keys(p).join(',')"), "| norm", run("p.norm()"), "| version", run("String(versionOf(p))"), "| new instance", run("new Point(1, 0).norm()"));
vm.dispose();
vm = await QuickJS.restore(beforeMigration, { wasm });
console.log("checkpoint restored: slots", run("Object.keys(p).join(',')"), "| version", run("String(versionOf(p))"));

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

develop(`Array.prototype.every = () => true; Object.prototype.hasOwnProperty = () => true;`);
console.log("built-in tamper ignored: every =", run("String([1, 2].every((x) => x > 1))"), "| strict tamper:", develop(`"use strict"; Array.prototype.every = () => true;`));
develop(`define("Money", class { constructor(n) { this.n = n; } toString() { return "$" + this.n; } }); globalThis.m = new Money(5);`);
console.log("class may still define toString:", run("String(m)"), "| plain object assignment of toString:", run(`"use strict"; const o = {}; o.toString = () => "x"; String(o)`));

run(`globalThis.job = (async () => { const before = greet("frame"); await new Promise((r) => (globalThis.resume = r)); globalThis.out = before + " / " + greet("after"); })();`);
vm.executePendingJobs();
develop(`define("greet", (n) => "third " + n);`);
run("resume()");
vm.executePendingJobs();
console.log("active frame across redefinition:", run("out"));
vm.dispose();
