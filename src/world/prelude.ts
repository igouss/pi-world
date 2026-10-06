/**
 * The prelude installed at revision 0. It is world code: it runs inside the VM and is captured in every snapshot.
 *
 * World code sees `define`, `undefine`, `state`, `data` and `versionOf`. The host reaches the registry through
 * `__world`, a frozen object world code can call but not replace. The registry, the state table and the host
 * bridge are closure locals, so world code cannot reach them except through these functions.
 *
 * Host functions, registered by name before the prelude runs and after every restore:
 * - `__hostData(op, key, json)`: the world's data store; op is get, set, delete or list.
 * - `__hostRandom()`: a number in [0, 1); seeded during an attempt, so attempts stay deterministic.
 */
export const PRELUDE_VERSION: number = 1;

export const PRELUDE: string = String.raw`
(() => {
	"use strict";
	const hostData = globalThis.__hostData;
	const hostRandom = globalThis.__hostRandom;
	delete globalThis.__hostData;
	delete globalThis.__hostRandom;

	const NAME = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
	const VERSION = Symbol("version");
	const RESERVED = new Set(["define", "undefine", "state", "data", "versionOf", "__world"]);
	const defs = new Map();   // name -> { impl, version, doc, instances, removed, stub }
	const states = new Map(); // name -> { value, version }

	const isClass = (impl) => typeof impl === "function" && /^class\b/.test(Function.prototype.toString.call(impl));

	const define = (name, impl, options = {}) => {
		if (typeof name !== "string" || !NAME.test(name)) throw new TypeError("define: name must be an identifier, got " + String(name));
		if (RESERVED.has(name)) throw new TypeError("define: " + name + " is reserved");
		if (typeof impl !== "function") throw new TypeError("define(" + name + "): impl must be a function or a class");
		const { version = 1, migrate, doc } = options;
		if (!Number.isInteger(version) || version < 1) throw new TypeError("define(" + name + "): version must be a positive integer");
		const klass = isClass(impl);
		const entry = defs.get(name);
		if (!entry) {
			if (Object.getOwnPropertyDescriptor(globalThis, name)) throw new TypeError("define: " + name + " is already a global");
			const instances = new Set();
			const stub = function (...args) {
				const current = defs.get(name);
				if (current.removed) throw new ReferenceError(name + " was removed by undefine");
				if (!new.target) return current.impl.apply(this, args);
				const instance = Reflect.construct(current.impl, args, new.target);
				instance[VERSION] = current.version;
				instances.add(new WeakRef(instance));
				return instance;
			};
			Object.defineProperty(stub, "name", { value: name });
			stub.prototype = klass ? impl.prototype : undefined;
			Object.defineProperty(globalThis, name, { value: stub, writable: false, configurable: false, enumerable: true });
			defs.set(name, { impl, version, doc, instances, removed: false, stub, klass });
			return stub;
		}
		if (entry.klass !== klass) throw new TypeError("define(" + name + "): cannot change a " + (entry.klass ? "class" : "function") + " into a " + (klass ? "class" : "function"));
		if (klass && version !== entry.version) {
			const live = [...entry.instances].map((ref) => ref.deref()).filter(Boolean);
			if (live.length > 0 && !migrate)
				throw new Error(name + "@" + entry.version + " -> @" + version + " needs a migrate: " + live.length + " live instance(s)");
			for (const instance of live) {
				migrate(instance, { from: entry.version, to: version });
				instance[VERSION] = version;
			}
		}
		if (klass) {
			const proto = entry.stub.prototype;
			for (const k of Object.getOwnPropertyNames(proto)) if (k !== "constructor" && !(k in impl.prototype)) delete proto[k];
			for (const k of Object.getOwnPropertyNames(impl.prototype))
				if (k !== "constructor") Object.defineProperty(proto, k, Object.getOwnPropertyDescriptor(impl.prototype, k));
		}
		entry.impl = impl;
		entry.version = version;
		entry.doc = doc;
		entry.removed = false;
		return entry.stub;
	};

	const undefine = (name) => {
		const entry = defs.get(name);
		if (!entry || entry.removed) throw new ReferenceError("undefine: " + name + " is not defined");
		entry.removed = true;
	};

	const state = (name, init, options = {}) => {
		if (typeof name !== "string" || name.length === 0) throw new TypeError("state: name must be a non-empty string");
		const { version = 1, migrate } = options;
		const entry = states.get(name);
		if (entry && entry.version === version) return entry.value;
		const value = entry && migrate ? migrate(entry.value, { from: entry.version, to: version }) : init();
		if (value === null || typeof value !== "object") throw new TypeError("state(" + name + "): value must be an object, not " + typeof value);
		states.set(name, { value, version });
		return value;
	};

	const encode = (value) => {
		const text = JSON.stringify(value === undefined ? null : value, replacer);
		return text === undefined ? "null" : text;
	};
	const replacer = (_key, value) => {
		if (value instanceof Map) return Object.fromEntries(value);
		if (value instanceof Set) return [...value];
		if (typeof value === "bigint") return value.toString();
		if (typeof value === "function") return "[function " + (value.name || "anonymous") + "]";
		if (value instanceof Error) return { error: value.name, message: value.message };
		return value;
	};
	const decode = (text) => (text === undefined || text === null ? undefined : JSON.parse(text));

	const data = Object.freeze({
		get: (key) => decode(hostData("get", String(key), null)),
		set: (key, value) => { hostData("set", String(key), encode(value)); return value; },
		delete: (key) => decode(hostData("delete", String(key), null)) === true,
		list: (prefix = "") => decode(hostData("list", String(prefix), null)),
	});

	const versionOf = (instance) => instance?.[VERSION];

	const signature = (impl) => {
		const text = Function.prototype.toString.call(impl);
		const match = /^(?:async\s+)?(?:function\s*\*?\s*[A-Za-z0-9_$]*\s*)?\(([^)]*)\)/.exec(text) ?? /^(?:async\s+)?([A-Za-z_$][A-Za-z0-9_$]*)\s*=>/.exec(text);
		if (match) return match[1].replace(/\s+/g, " ").trim();
		const ctor = /constructor\s*\(([^)]*)\)/.exec(text);
		return ctor ? ctor[1].replace(/\s+/g, " ").trim() : "";
	};

	let pending;
	const world = Object.freeze({
		catalogue: () => encode([...defs].filter(([, e]) => !e.removed).map(([name, e]) => ({
			name,
			kind: e.klass ? "class" : "function",
			version: e.version,
			doc: typeof e.doc === "string" ? e.doc : "",
			params: signature(e.impl),
			source: Function.prototype.toString.call(e.impl),
		}))),
		states: () => encode([...states].map(([name, e]) => ({ name, version: e.version }))),
		has: (name) => defs.has(name) && !defs.get(name).removed,
		invoke: (name, argsJson) => {
			pending = undefined;
			const entry = defs.get(name);
			if (!entry || entry.removed) throw new ReferenceError(name + " is not defined");
			const args = JSON.parse(argsJson);
			if (!Array.isArray(args)) throw new TypeError("args must be a JSON array");
			const result = entry.klass ? new entry.stub(...args) : entry.stub(...args);
			pending = { done: false };
			const box = pending;
			if (result && typeof result.then === "function")
				result.then((value) => { box.done = true; box.value = value; }, (error) => { box.done = true; box.error = error; });
			else { box.done = true; box.value = result; }
		},
		evaluate: (thunk) => {
			pending = { done: false };
			const box = pending;
			const result = thunk();
			if (result && typeof result.then === "function")
				result.then((value) => { box.done = true; box.value = value; }, (error) => { box.done = true; box.error = error; });
			else { box.done = true; box.value = result; }
		},
		take: () => {
			const box = pending;
			pending = undefined;
			if (!box) return encode({ status: "none" });
			if (!box.done) return encode({ status: "pending" });
			if ("error" in box) {
				const e = box.error;
				return encode({ status: "error", error: e instanceof Error ? (e.stack ? e.name + ": " + e.message + "\n" + e.stack : e.name + ": " + e.message) : String(e) });
			}
			return encode({ status: "ok", value: box.value });
		},
	});

	const random = () => hostRandom();
	for (const [name, value] of [["define", define], ["undefine", undefine], ["state", state], ["data", data], ["versionOf", versionOf], ["__world", world]])
		Object.defineProperty(globalThis, name, { value, writable: false, configurable: false, enumerable: false });
	Object.defineProperty(Math, "random", { value: random, writable: false, configurable: false });

	// Lock the built-ins, so world code cannot weaken a check by changing what the check calls.
	for (const ctor of [Object, Function, Array, String, Number, Boolean, Symbol, Map, Set, WeakMap, WeakSet, WeakRef, Promise, RegExp, Date, Error, TypeError, RangeError, ReferenceError, SyntaxError, JSON, Math, Reflect, BigInt])
		for (const target of [ctor, ctor.prototype]) if (target) Object.freeze(target);
	Object.freeze(Object.getPrototypeOf(function* () {}));
	Object.freeze(Object.getPrototypeOf(async function () {}));
})();
`;
