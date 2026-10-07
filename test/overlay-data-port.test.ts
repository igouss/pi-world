import { describe, expect, it } from "vitest";
import { MemoryDataPort } from "../src/world/data-port.ts";
import { OverlayDataPort } from "../src/world/overlay-data-port.ts";

function base(): MemoryDataPort {
	const data = new MemoryDataPort();
	data.set("todo:1", JSON.stringify({ t: "milk" }));
	data.set("todo:2", JSON.stringify({ t: "eggs" }));
	data.set("meta", JSON.stringify(1));
	return data;
}

describe("OverlayDataPort", () => {
	it("records no changes and reads the base when nothing was written", () => {
		const overlay = new OverlayDataPort(base());
		expect(overlay.get("todo:1")).toBe(JSON.stringify({ t: "milk" }));
		expect(overlay.list("todo:").map((row) => row.key)).toEqual(["todo:1", "todo:2"]);
		expect(overlay.changes()).toEqual({ set: [], deleted: [] });
	});

	it("reads its own write and leaves the base unchanged", () => {
		const data = base();
		const overlay = new OverlayDataPort(data);
		overlay.set("todo:3", JSON.stringify({ t: "tea" }));
		expect(overlay.get("todo:3")).toBe(JSON.stringify({ t: "tea" }));
		expect(data.get("todo:3")).toBeUndefined();
		expect(overlay.changes()).toEqual({ set: ["todo:3"], deleted: [] });
	});

	it("hides deleted rows, overrides changed ones and adds new ones in a listing, in key order", () => {
		const data = base();
		const overlay = new OverlayDataPort(data);
		expect(overlay.delete("todo:1")).toBe(true);
		expect(overlay.delete("todo:9")).toBe(false);
		overlay.set("todo:2", JSON.stringify({ t: "EGGS" }));
		overlay.set("todo:0", JSON.stringify({ t: "first" }));
		expect(overlay.get("todo:1")).toBeUndefined();
		expect(overlay.list("todo:")).toEqual([
			{ key: "todo:0", value: { t: "first" } },
			{ key: "todo:2", value: { t: "EGGS" } },
		]);
		expect(data.list("todo:").length).toBe(2);
		expect(overlay.changes()).toEqual({ set: ["todo:0", "todo:2"], deleted: ["todo:1", "todo:9"] });
	});

	it("treats a set after a delete as a set", () => {
		const overlay = new OverlayDataPort(base());
		overlay.delete("meta");
		overlay.set("meta", JSON.stringify(2));
		expect(overlay.get("meta")).toBe("2");
		expect(overlay.changes()).toEqual({ set: ["meta"], deleted: [] });
	});
});
