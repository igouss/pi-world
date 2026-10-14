import type { Api } from "./api.ts";

/**
 * The worlds a scenario runs against. Their sources are the node's own worlds (Currency, Trip budget, Dashboard, Demo
 * todos, as read from the node on 2026-10-14), with the world ids they call replaced by the fixture's, so the
 * workload has the shape of what the node actually holds: small functions, a few data rows, a 1.44 MB snapshot, and
 * Dashboard → Trip budget → Currency as a chain of three worlds.
 */

export const CURRENCY: string = `
const table = state("fxRates", () => ({ USD: 1, JPY: 150, EUR: 0.92, CAD: 1.37 }));
define("rates", () => JSON.parse(JSON.stringify(table)), { doc: "Returns the fixed rate table (units per 1 USD)." });
define("convert", (amount, from, to) => {
  if (typeof amount !== "number" || !isFinite(amount)) throw new Error("Invalid amount: " + amount);
  if (!Object.prototype.hasOwnProperty.call(table, from)) throw new Error("Unknown currency: " + from);
  if (!Object.prototype.hasOwnProperty.call(table, to)) throw new Error("Unknown currency: " + to);
  return Math.round((amount / table[from] * table[to] + Number.EPSILON) * 100) / 100;
}, { doc: "Converts amount from one currency to another." });
`;

export function tripBudget(currencyId: string): string {
	return `
define("addExpense", function(label, yen) {
  if (typeof label !== "string" || !label) throw new Error("label required");
  if (typeof yen !== "number" || !isFinite(yen)) throw new Error("yen must be a number");
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const expense = { id, label, yen };
  data.set("expense:" + id, expense);
  return expense;
}, { doc: "Adds an expense." });
define("listExpenses", function() {
  return data.list("expense:").map(e => e.value);
}, { doc: "Lists all expenses." });
define("totals", async function(currency) {
  const totalYen = listExpenses().reduce((s, e) => s + e.yen, 0);
  const converted = await worlds.call(${JSON.stringify(currencyId)}, "convert", totalYen, "JPY", currency);
  return { yen: totalYen, currency, converted };
}, { doc: "Total of all expenses in yen and converted." });
`;
}

export function dashboard(tripId: string): string {
	return `
define("tripIn", async (currency) => {
  try {
    return await worlds.call(${JSON.stringify(tripId)}, "totals", currency);
  } catch (error) {
    return { error: error.message };
  }
}, { doc: "Trip totals in a currency." });
`;
}

export const TODOS: string = `
define("addTodo", (text) => {
  const t = String(text == null ? "" : text).trim();
  if (!t) throw new Error("text required");
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const todo = { id, text: t, done: false, created: Date.now() };
  data.set("todo:" + id, todo);
  return todo;
});
define("setTodo", (id, text) => {
  const todo = { id, text, done: false, created: 1 };
  data.set("todo:" + id, todo);
  return todo;
});
define("toggleTodo", (id) => {
  const todo = data.get("todo:" + id);
  if (!todo) throw new Error("no such todo: " + id);
  todo.done = !todo.done;
  data.set("todo:" + id, todo);
  return todo;
});
define("listTodos", (entries) => {
  const rows = Array.isArray(entries) ? entries : data.list("todo:");
  return rows.map(e => e.value).sort((a, b) => a.created - b.created || (a.id < b.id ? -1 : 1));
});
define("stats", () => {
  const todos = listTodos();
  const done = todos.filter(t => t.done).length;
  return { open: todos.length - done, done, total: todos.length };
});
`;

/** CPU work a call or a develop can be asked to do: `spin(n)` loops n times and returns a number. */
export const SPIN: string = `
define("spin", (n) => { let s = 0; for (let i = 0; i < n; i++) s = (s + i * 7) % 1000003; return s; });
`;

/** A counter whose increment reads, awaits another world, then writes: the shape that loses updates if calls interleave. */
export function counter(peerId: string): string {
	return `
define("bump", async () => {
  const n = data.get("count") ?? 0;
  await worlds.call(${JSON.stringify(peerId)}, "convert", 1, "USD", "USD");
  data.set("count", n + 1);
  return n + 1;
});
define("bumpSync", () => {
  const n = data.get("count") ?? 0;
  data.set("count", n + 1);
  return n + 1;
});
define("count", () => data.get("count") ?? 0);
`;
}

/** A plain check that calls `stats` on a scratch store; it fails once `stats` is broken. */
export function plainCheck(i: number): { name: string; expression: string; counterexample: string } {
	return {
		name: `stats is consistent ${i}`,
		expression: `(() => { const s = stats(); return s.open + s.done === s.total; })()`,
		counterexample: `define("stats", () => ({ open: 1, done: 1, total: 3 }));`,
	};
}

/** A property check over 50 generated todo lists. */
export function propertyCheck(i: number): { name: string; expression: string; counterexample: string; generator: unknown } {
	return {
		name: `listTodos keeps every row ${i}`,
		expression: `listTodos(input.map((t, k) => ({ key: "todo:" + k, value: { id: String(k), text: "x", done: t, created: k } }))).length === input.length`,
		counterexample: `define("listTodos", (entries) => []);`,
		generator: { array: { bool: true }, min: 0, max: 20 },
	};
}

/** The worlds of one run, named so a sweep can find and forget them. */
export class Fixture {
	private readonly ids: string[] = [];

	private readonly api: Api;
	readonly prefix: string;

	constructor(api: Api, prefix: string) {
		this.api = api;
		this.prefix = prefix;
	}

	async world(name: string, source?: string): Promise<string> {
		const id = await this.api.createWorld(`${this.prefix}-${name}`);
		this.ids.push(id);
		if (source) await this.api.mustDevelop(id, source);
		return id;
	}

	async forget(): Promise<void> {
		for (const id of this.ids.splice(0)) await this.api.forgetWorld(id);
	}
}
