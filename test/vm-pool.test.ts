import { describe, expect, it } from "vitest";
import { VmPool, type PoolHead } from "../src/world/vm-pool.ts";
import { WorldVm } from "../src/world/world-vm.ts";
import { wasm } from "./wasm.ts";

const WARM: number = 2;

interface Counted {
	readonly pool: VmPool;
	readonly head: PoolHead;
	/** The head after `head`. */
	readonly next: PoolHead;
	/** VMs opened and not yet disposed. */
	live(): number;
	opened(): number;
}

/** A pool of up to `max` VMs, `warm` of them kept warm, that counts the VMs it opens and holds. */
async function countedPool(max: number = 4, warm: number = WARM): Promise<Counted> {
	const first: WorldVm = await WorldVm.create(wasm);
	const head: PoolHead = { revision: 0, snapshot: first.snapshot() };
	first.develop(`define("one", () => 1);`, { kind: "attempt", at: 0, seed: 1 });
	const next: PoolHead = { revision: 1, snapshot: first.snapshot() };
	first.dispose();
	let live: number = 0;
	let opened: number = 0;
	const open = async (snapshot: PoolHead["snapshot"]): Promise<WorldVm> => {
		const vm = await WorldVm.fromSnapshot(snapshot, wasm);
		live++;
		opened++;
		const dispose: () => void = vm.dispose.bind(vm);
		vm.dispose = () => {
			live--;
			dispose();
		};
		return vm;
	};
	return { pool: new VmPool(open, max, warm), head, next, live: () => live, opened: () => opened };
}

/** Lets the pool's background recycling finish. */
const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 50));

describe("VmPool", () => {
	it("keeps no more VMs warm than asked when calls finish together", async () => {
		const { pool, head, live } = await countedPool();
		await Promise.all([pool.run(head, async () => 1), pool.run(head, async () => 2), pool.run(head, async () => 3)]);
		await settled();
		expect(live()).toBe(WARM);
	});

	it("keeps one VM warm after one call", async () => {
		const { pool, head, live } = await countedPool();
		await pool.run(head, async () => 1);
		await settled();
		expect(live()).toBe(1);
	});

	it("disposes its warm VMs when it is disposed", async () => {
		const { pool, head, live } = await countedPool();
		await Promise.all([pool.run(head, async () => 1), pool.run(head, async () => 2)]);
		await settled();
		pool.dispose();
		expect(live()).toBe(0);
	});

	it("reuses a warm VM for the next call at the same head", async () => {
		const { pool, head, opened } = await countedPool();
		await pool.run(head, async () => 1);
		await settled();
		await pool.run(head, async () => 2);
		expect(opened()).toBe(1);
	});

	it("keeps a VM warm after each of several calls in turn", async () => {
		const { pool, head, live } = await countedPool(4, 1);
		await pool.run(head, async () => 1);
		await settled();
		await pool.run(head, async () => 2);
		await settled();
		await pool.run(head, async () => 3);
		await settled();
		expect(live()).toBe(1);
	});

	it("frees the slot of a VM it does not keep warm", async () => {
		const { pool, head } = await countedPool(1, 0);
		await pool.run(head, async () => 1);
		await settled();
		await pool.run(head, async () => 2);
		await settled();
		expect(await pool.run(head, async () => 3)).toBe(3);
	});

	it("returns a VM used at an older head to the newest head seen", async () => {
		const { pool, head, next, opened } = await countedPool(4, 1);
		await pool.run(next, async () => 1);
		await settled();
		await pool.run(head, async () => 2);
		await settled();
		await pool.run(next, async () => 3);
		expect(opened()).toBe(2);
	});

	it("disposes a warm VM at an older head when a call needs a newer one", async () => {
		const { pool, head, next, live } = await countedPool(4, 1);
		await pool.run(head, async () => 1);
		await settled();
		await pool.run(next, async () => 2);
		await settled();
		expect(live()).toBe(1);
	});

	it("keeps VMs warm at the newest head once calls move to it", async () => {
		const { pool, head, next, opened } = await countedPool(4, 1);
		await pool.run(head, async () => 1);
		await settled();
		await pool.run(next, async () => 2);
		await settled();
		await pool.run(next, async () => 3);
		expect(opened()).toBe(2);
	});

	it("frees the slot of a call whose VM could not be opened", async () => {
		const { head } = await countedPool();
		let fail: boolean = true;
		const pool = new VmPool(
			async (snapshot) => {
				if (fail) throw new Error("no memory");
				return WorldVm.fromSnapshot(snapshot, wasm);
			},
			1,
			0,
		);
		await expect(pool.run(head, async () => 1)).rejects.toThrow("no memory");
		fail = false;
		expect(await pool.run(head, async () => 2)).toBe(2);
	});
});
