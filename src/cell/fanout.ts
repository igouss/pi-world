import type { ServerFrame } from "../api/types.ts";

const FLUSH_MS: number = 120;

/**
 * The web UI's sockets of one world. Frames of one type coalesce: a burst of transcript updates sends the newest
 * transcript once per flush interval.
 */
export class Fanout {
	private readonly sockets: Set<WebSocket> = new Set();
	private readonly pending: Map<ServerFrame["type"], () => ServerFrame> = new Map();
	private timer: ReturnType<typeof setTimeout> | undefined;

	add(socket: WebSocket, initial: readonly ServerFrame[]): void {
		socket.accept();
		this.sockets.add(socket);
		for (const frame of initial) socket.send(JSON.stringify(frame));
		const remove = () => this.sockets.delete(socket);
		socket.addEventListener("close", remove);
		socket.addEventListener("error", remove);
		socket.addEventListener("message", (event) => {
			if (event.data === "ping") socket.send("pong");
		});
	}

	/** Queue a frame; `frame` is built at flush time, so it carries the newest state. */
	publish(type: ServerFrame["type"], frame: () => ServerFrame): void {
		if (this.sockets.size === 0) return;
		this.pending.set(type, frame);
		this.timer ??= setTimeout(() => this.flush(), FLUSH_MS);
	}

	private flush(): void {
		this.timer = undefined;
		const frames = [...this.pending.values()].map((build) => JSON.stringify(build()));
		this.pending.clear();
		for (const socket of this.sockets) {
			for (const frame of frames) {
				try {
					socket.send(frame);
				} catch {
					this.sockets.delete(socket);
				}
			}
		}
	}
}
