import { describe, expect, it } from "vitest";
import { settled, unseen } from "../cli/follow.ts";
import { positiveInteger } from "../cli/positive-integer.ts";
import { resolveWorld } from "../cli/world-ref.ts";
import type { Transcript, TranscriptItem, WorldListing } from "../src/api/types.ts";

const world = (id: string, name: string): WorldListing => ({ id, name, createdAt: 0 });
const KIT: WorldListing = world("kit-e9911c", "Kit");
const KITCHEN: WorldListing = world("kitchen-0a1b2c", "Kitchen");
const TODOS: WorldListing = world("todos-ab5928", "Todos");
const OTHER_TODOS: WorldListing = world("todos-77ff00", "todos");

describe("resolveWorld", () => {
	it("refuses an unknown reference, listing every world by id and name", () => {
		expect(() => resolveWorld([KIT, TODOS], "nope")).toThrow('no world "nope"; the worlds are: kit-e9911c (Kit), todos-ab5928 (Todos)');
	});

	it("finds a world by an exact id that is also a prefix of another id", () => {
		const short: WorldListing = world("a-1", "One");
		expect(resolveWorld([short, world("a-12", "Twelve")], "a-1")).toBe(short);
	});

	it("refuses a name two worlds share even when one id also starts with it", () => {
		expect(() => resolveWorld([world("kit-1", "kit"), world("x-2", "Kit")], "kit")).toThrow('"kit" names 2 worlds: kit-1, x-2');
	});

	it("refuses any reference when there are no worlds, and says so", () => {
		expect(() => resolveWorld([], "kit")).toThrow('no world "kit"; the worlds are: none');
	});

	it("finds a world by its exact id", () => {
		expect(resolveWorld([KIT, KITCHEN], "kit-e9911c")).toBe(KIT);
	});

	it("finds a world by its name in any case", () => {
		expect(resolveWorld([KIT, KITCHEN], "KITCHEN")).toBe(KITCHEN);
	});

	it("finds a world by a prefix of its id that no other id shares", () => {
		expect(resolveWorld([KIT, KITCHEN], "kitc")).toBe(KITCHEN);
	});

	it("refuses a prefix two ids share, naming both", () => {
		expect(() => resolveWorld([KIT, KITCHEN], "kit-")).not.toThrow();
		expect(() => resolveWorld([KIT, KITCHEN], "ki")).toThrow('"ki" names 2 worlds: kit-e9911c, kitchen-0a1b2c');
	});

	it("refuses a name two worlds share, naming both", () => {
		expect(() => resolveWorld([TODOS, OTHER_TODOS], "Todos")).toThrow('"Todos" names 2 worlds: todos-ab5928, todos-77ff00');
	});

	it("prefers an exact name over a prefix of another world's id", () => {
		expect(resolveWorld([KIT, world("kit-2", "Spare")], "kit")).toBe(KIT);
	});
});

const user = (id: number): TranscriptItem => ({ kind: "user", id, text: "hi", at: 0 });
const transcript = (items: readonly TranscriptItem[], busy: boolean): Transcript => ({ items, busy, tools: [], queued: 0 });

describe("following the agent", () => {
	it("is not settled before anything was added, even when idle", () => {
		expect(settled(transcript([user(1)], false), 1)).toBe(false);
	});

	it("is not settled while the agent is busy", () => {
		expect(settled(transcript([user(1), user(2)], true), 1)).toBe(false);
	});

	it("is not settled while a submission is still queued", () => {
		expect(settled({ ...transcript([user(1), user(2)], false), queued: 1 }, 1)).toBe(false);
	});

	it("is not settled while an answer is streaming", () => {
		expect(settled({ ...transcript([user(1), user(2)], false), streaming: { text: "", thinking: "", toolCalls: [] } }, 1)).toBe(false);
	});

	it("is not settled while a tool is running", () => {
		expect(settled({ ...transcript([user(1), user(2)], false), tools: [{ callId: "c", name: "develop", status: "running", output: "" }] }, 1)).toBe(false);
	});

	it("is settled once something was added and the agent is idle", () => {
		expect(settled(transcript([user(1), user(2)], false), 1)).toBe(true);
	});

	it("shows nothing it has already shown", () => {
		expect(unseen(transcript([user(1), user(2)], false), new Set([1, 2]))).toEqual([]);
	});

	it("shows only the items it has not shown, in order", () => {
		expect(unseen(transcript([user(1), user(2), user(3)], false), new Set([1]))).toEqual([user(2), user(3)]);
	});
});

describe("a positive whole-number option", () => {
	it("reads a whole number of one", () => {
		expect(positiveInteger("1")).toBe(1);
	});

	it("reads a whole number of many", () => {
		expect(positiveInteger("900")).toBe(900);
	});

	it("refuses zero", () => {
		expect(() => positiveInteger("0")).toThrow("not a positive whole number: 0");
	});

	it("refuses a number with a unit", () => {
		expect(() => positiveInteger("15m")).toThrow("not a positive whole number: 15m");
	});

	it("refuses a fraction", () => {
		expect(() => positiveInteger("1.5")).toThrow("not a positive whole number: 1.5");
	});

	it("refuses an empty value", () => {
		expect(() => positiveInteger("")).toThrow("not a positive whole number: ");
	});
});
