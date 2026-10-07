import type { ServerFrame } from "../api/types.ts";

const FLUSH_MS: number = 120;

/**
 * Frames for the web UI's sockets of one world. The sockets are hibernatable: the cell holds them, not this object,
 * so they outlive a hibernation or a deploy, and `sockets()` lists the ones attached now. Frames of one type coalesce:
 * a burst of transcript updates sends the newest transcript once per flush interval.
 */
export class Fanout {
	private readonly pending: Map<ServerFrame["type"], () => ServerFrame> = new Map();
	private timer: ReturnType<typeof setTimeout> | undefined;

	constructor(private readonly sockets: () => readonly WebSocket[]) {}

	/** Queue a frame; `frame` is built at flush time, so it carries the newest state. */
	publish(type: ServerFrame["type"], frame: () => ServerFrame): void {
		if (this.sockets().length === 0) return;
		this.pending.set(type, frame);
		this.timer ??= setTimeout(() => this.flush(), FLUSH_MS);
	}

	private flush(): void {
		this.timer = undefined;
		const frames = [...this.pending.values()].map((build) => JSON.stringify(build()));
		this.pending.clear();
		for (const socket of this.sockets()) {
			for (const frame of frames) {
				try {
					socket.send(frame);
				} catch {
					// A socket that is closing; the cell drops it.
				}
			}
		}
	}
}
