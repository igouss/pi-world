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
	it("lists only the writes under the prefix asked for, and names its writes in key order", () => {
		const base = new MemoryDataPort();
		const overlay = new OverlayDataPort(base);
		overlay.set("b:2", "2");
		overlay.set("a:1", "1");
		overlay.set("b:1", "1");
		overlay.delete("a:0");
		expect(overlay.list("b:").map((row) => row.key)).toEqual(["b:1", "b:2"]);
		expect(overlay.changes()).toEqual({ set: ["a:1", "b:1", "b:2"], deleted: ["a:0"] });
	});

	it("makes its writes in the base store when committed, in one transaction of it", () => {
		const base = new MemoryDataPort();
		base.set("gone", "0");
		const overlay = new OverlayDataPort(base);
		overlay.set("x", "1");
		overlay.delete("gone");
		let inside = 0;
		base.transaction = (writes) => {
			inside++;
			writes();
		};
		expect(overlay.commitIfUnchanged()).toBe(true);
		expect(inside).toBe(1);
		expect(base.list("").map((row) => row.key)).toEqual(["x"]);
	});

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

	it("does not commit, and writes nothing, when a key it read was changed in the base", () => {
		const data = base();
		const overlay = new OverlayDataPort(data);
		const n = Number(overlay.get("meta"));
		overlay.set("meta", JSON.stringify(n + 1));
		data.set("meta", JSON.stringify(5));
		expect(overlay.commitIfUnchanged()).toBe(false);
		expect(data.get("meta")).toBe("5");
	});

	it("does not commit when a key it found absent was created in the base", () => {
		const data = base();
		const overlay = new OverlayDataPort(data);
		expect(overlay.get("new")).toBeUndefined();
		overlay.set("count", "1");
		data.set("new", "0");
		expect(overlay.commitIfUnchanged()).toBe(false);
		expect(data.get("count")).toBeUndefined();
	});

	it("does not commit when a prefix it listed gained, lost or changed a row", () => {
		for (const change of [(d: MemoryDataPort) => d.set("todo:3", "{}"), (d: MemoryDataPort) => d.delete("todo:1"), (d: MemoryDataPort) => d.set("todo:2", "{}")]) {
			const data = base();
			const overlay = new OverlayDataPort(data);
			overlay.set("count", JSON.stringify(overlay.list("todo:").length));
			change(data);
			expect(overlay.commitIfUnchanged()).toBe(false);
			expect(data.get("count")).toBeUndefined();
		}
	});

	it("commits when only data it did not read changed", () => {
		const data = base();
		const overlay = new OverlayDataPort(data);
		overlay.set("meta", JSON.stringify(Number(overlay.get("meta")) + 1));
		data.set("todo:9", "{}");
		data.set("other", "1");
		expect(overlay.commitIfUnchanged()).toBe(true);
		expect(data.get("meta")).toBe("2");
	});

	it("does not count a read of its own write as a read of the base", () => {
		const data = base();
		const overlay = new OverlayDataPort(data);
		overlay.set("meta", "10");
		expect(overlay.get("meta")).toBe("10");
		data.set("meta", "7");
		expect(overlay.commitIfUnchanged()).toBe(true);
		expect(data.get("meta")).toBe("10");
	});

	it("commits a call that wrote nothing without opening a transaction, whatever changed", () => {
		const data = base();
		let transactions = 0;
		data.transaction = (writes) => {
			transactions++;
			writes();
		};
		const overlay = new OverlayDataPort(data);
		overlay.get("meta");
		data.set("meta", "9");
		expect(overlay.commitIfUnchanged()).toBe(true);
		expect(transactions).toBe(0);
	});

	it("treats a set after a delete as a set", () => {
		const overlay = new OverlayDataPort(base());
		overlay.delete("meta");
		overlay.set("meta", JSON.stringify(2));
		expect(overlay.get("meta")).toBe("2");
		expect(overlay.changes()).toEqual({ set: ["meta"], deleted: [] });
	});
});
