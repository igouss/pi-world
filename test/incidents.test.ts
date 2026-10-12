import { describe, expect, it } from "vitest";
import { World } from "../src/world/world.ts";
import { worldDeps } from "./world-deps.ts";

const operator = { by: "operator" } as const;
const at = 1_750_000_000_000;
const fixture = () => worldDeps({ now: () => at });

async function failing(): Promise<World> {
	const world = await World.open(fixture());
	await world.develop(`function half(n) { if (n % 2) throw new Error("odd: " + n); data.set("last", n / 2); return n / 2; }\nfunction whole(n) { return n; }`, "half", operator);
	return world;
}

describe("incidents", () => {
	it("are not recorded for calls that succeed, or for names the world does not define", async () => {
		const world = await failing();
		expect(await world.call("half", [4])).toEqual({ ok: true, value: 2 });
		expect((await world.call("nothing", [])).ok).toBe(false);
		expect(world.incidents.openCount()).toBe(0);
		expect(await world.incidents.list(10)).toEqual([]);
	});

	it("record a failed call with its arguments, error and revision, and name it in the outcome", async () => {
		const world = await failing();
		const outcome = await world.call("half", [3]);
		expect(outcome).toMatchObject({ ok: false, failure: "threw", incident: 0 });
		expect(await world.incidents.get(0)).toMatchObject({ n: 0, name: "half", args: [3], failure: "threw", revision: 1, at, lastAt: at, count: 1, retries: 0 });
		expect((await world.incidents.get(0))?.error).toMatch(/^Error: odd: 3/);
		expect(world.incidents.openCount()).toBe(1);
	});

	it("count a repeat of the same failure into the open incident, and open a new one for another error", async () => {
		const world = await failing();
		await world.call("half", [3]);
		expect((await world.call("half", [3])).ok === false && (await world.incidents.get(0))?.count).toBe(2);
		expect(await world.call("half", [5])).toMatchObject({ incident: 1 });
		expect((await world.incidents.list(10)).map((incident) => incident.n)).toEqual([1, 0]);
	});

	it("close with the retried call's value once the definition is fixed, and the retry's writes are made", async () => {
		const world = await failing();
		await world.call("half", [3]);
		await world.develop(`function half(n) { data.set("last", n / 2); return n / 2; }`, "allow odd", operator);
		expect(await world.retryIncident(0, "agent")).toEqual({ ok: true, value: 1.5 });
		expect((await world.incidents.get(0))?.resolution).toEqual({ kind: "retried", at, by: "agent", revision: 2, value: 1.5 });
		expect(world.incidents.openCount()).toBe(0);
		expect(await world.execute(`data.get("last")`)).toMatchObject({ ok: true, value: 1.5 });
	});

	it("stay open after a retry that fails, counting it", async () => {
		const world = await failing();
		await world.call("half", [3]);
		expect((await world.retryIncident(0, "operator")).ok).toBe(false);
		expect(await world.incidents.get(0)).toMatchObject({ retries: 1 });
		expect((await world.incidents.get(0))?.resolution).toBeUndefined();
	});

	it("close with a value the owner answers, or when dismissed with a reason, and refuse closing twice", async () => {
		const world = await failing();
		await world.call("half", [3]);
		await world.call("half", [5]);
		await world.incidents.close(0, "operator", { kind: "returned", value: 1.5 });
		expect((await world.incidents.get(0))?.resolution).toEqual({ kind: "returned", at, by: "operator", value: 1.5 });
		await expect(world.incidents.close(1, "operator", { kind: "dismissed", reason: " " })).rejects.toThrow("needs a reason");
		await world.incidents.close(1, "operator", { kind: "dismissed", reason: "a test input" });
		expect((await world.incidents.get(1))?.resolution).toEqual({ kind: "dismissed", at, by: "operator", reason: "a test input" });
		await expect(world.retryIncident(0, "operator")).rejects.toThrow("incident 0 is already closed (returned)");
		await expect(world.incidents.close(0, "operator", { kind: "dismissed", reason: "again" })).rejects.toThrow("already closed");
	});

	it("number a new incident after the last, even when an earlier one counted a repeat in between", async () => {
		const world = await failing();
		await world.call("half", [3]);
		await world.call("half", [5]);
		await world.call("half", [3]);
		expect(await world.call("half", [7])).toMatchObject({ incident: 2 });
		expect((await world.incidents.list(10)).map((incident) => [incident.n, incident.count])).toEqual([
			[2, 1],
			[1, 1],
			[0, 2],
		]);
	});

	it("tell subscribers when the open incidents change: opened or closed, not repeated or retried in vain", async () => {
		const world = await failing();
		let seen = 0;
		world.subscribe(() => seen++);
		await world.call("half", [3]);
		expect(seen).toBe(1);
		await world.call("half", [3]);
		await world.retryIncident(0, "operator");
		expect(seen).toBe(1);
		await world.incidents.close(0, "operator", { kind: "returned", value: 1.5 });
		expect(seen).toBe(2);
	});

	it("leave the open index right when a retry fails with another error and the incident is then closed", async () => {
		const world = await failing();
		await world.call("half", [3]);
		await world.develop(`function half(n) { throw new Error("broken differently"); }`, "worse", operator);
		await world.retryIncident(0, "operator");
		expect((await world.incidents.get(0))?.error).toMatch(/^Error: broken differently/);
		await world.incidents.close(0, "operator", { kind: "dismissed", reason: "rewriting it" });
		expect(world.incidents.openCount()).toBe(0);
		expect(await world.incidents.openOnes()).toEqual([]);
	});

	it("list every open incident, however old", async () => {
		const world = await World.open(fixture());
		await world.develop(`function fail(n) { throw new Error("e" + n); }`, "fail", operator);
		await Promise.all(Array.from({ length: 25 }, (_, i) => world.call("fail", [i])));
		await world.incidents.close(24, "operator", { kind: "dismissed", reason: "newest" });
		const open = await world.incidents.openOnes();
		expect(open).toHaveLength(24);
		expect(open.map((incident) => incident.n)).toEqual(Array.from({ length: 24 }, (_, i) => 23 - i));
	});

	it("refuse to close or retry an incident that does not exist, and record nothing", async () => {
		const world = await failing();
		await expect(world.incidents.close(0, "operator", { kind: "dismissed", reason: "none" })).rejects.toThrow("no incident 0");
		await world.call("half", [3]);
		await expect(world.incidents.close(1, "operator", { kind: "returned", value: 1 })).rejects.toThrow("no incident 1");
		await expect(world.retryIncident(9, "operator")).rejects.toThrow("no incident 9");
		expect(await world.incidents.get(1)).toBeUndefined();
		expect(await world.call("half", [5])).toMatchObject({ incident: 1 });
	});

	it("open a new incident when a closed one's failure happens again", async () => {
		const world = await failing();
		await world.call("half", [3]);
		await world.incidents.close(0, "operator", { kind: "dismissed", reason: "seen" });
		expect(await world.call("half", [3])).toMatchObject({ incident: 1 });
	});

	it("keep no arguments too large to store, and then cannot be retried", async () => {
		const world = await failing();
		await world.call("half", [3, "x".repeat(70 * 1024)]);
		expect((await world.incidents.get(0))?.args).toBeUndefined();
		await expect(world.retryIncident(0, "operator")).rejects.toThrow("kept no arguments");
	});

	it("survive reopening the world and tell its subscribers", async () => {
		const deps = fixture();
		const world = await World.open(deps);
		await world.develop(`function boom() { throw new Error("no"); }`, "boom", operator);
		const seen: number[] = [];
		world.subscribe(() => seen.push(world.incidents.openCount()));
		await world.call("boom", []);
		expect(seen).toEqual([1]);
		world.dispose();
		const reopened = await World.open(deps);
		expect(reopened.incidents.openCount()).toBe(1);
		expect(await reopened.call("boom", [])).toMatchObject({ incident: 0 });
	});
});
