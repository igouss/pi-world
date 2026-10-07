/**
 * Prelude upgrades, applied in order after the base prelude. A fresh world runs all of them before its genesis
 * snapshot; a world whose head was built by an older prelude runs the missing ones as an `upgrade` revision.
 *
 * Each upgrade names the host functions it needs; the VM creates them before evaluating the source.
 */
export interface PreludeUpgrade {
	readonly version: number;
	readonly hostFunctions: readonly string[];
	readonly source: string;
}

/**
 * Version 2: `worlds`, the other worlds on this server. `worlds.call(id, name, ...args)` calls a definition of another
 * world and resolves to its result or rejects with its error. Like `data`, it is for calls only: a develop that uses it
 * is rejected.
 */
const PEERS: PreludeUpgrade = {
	version: 2,
	hostFunctions: ["__hostPeer"],
	source: String.raw`
(() => {
	"use strict";
	const hostPeer = globalThis.__hostPeer;
	delete globalThis.__hostPeer;
	const ask = async (op, id, name, args) => {
		let text;
		try {
			text = await hostPeer(op, String(id), String(name), JSON.stringify(args));
		} catch (error) {
			throw new Error(String(error));
		}
		return JSON.parse(text);
	};
	const worlds = Object.freeze({
		call: (id, name, ...args) => ask("call", id, name, args),
		list: () => ask("list", "", "", []),
		functions: (id) => ask("functions", id, "", []),
	});
	Object.defineProperty(globalThis, "worlds", { value: worlds, writable: false, configurable: false, enumerable: false });
})();
`,
};

export const PRELUDE_UPGRADES: readonly PreludeUpgrade[] = [PEERS];
