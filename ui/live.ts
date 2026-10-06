import { useEffect, useState } from "preact/hooks";
import type { ServerFrame, Transcript, WorldSummary } from "../src/api/types.ts";

export interface LiveWorld {
	readonly world?: WorldSummary;
	readonly transcript?: Transcript;
	readonly connected: boolean;
}

const RETRY_MS: number = 1500;
const PING_MS: number = 25_000;

/** The world's summary and conversation over a WebSocket, reconnecting when the cell moves or the network drops. */
export function useLiveWorld(id: string): LiveWorld {
	const [state, setState] = useState<LiveWorld>({ connected: false });
	useEffect(() => {
		let socket: WebSocket | undefined;
		let closed = false;
		let retry: ReturnType<typeof setTimeout> | undefined;
		let ping: ReturnType<typeof setInterval> | undefined;
		setState({ connected: false });
		const connect = () => {
			const scheme = location.protocol === "https:" ? "wss" : "ws";
			socket = new WebSocket(`${scheme}://${location.host}/api/worlds/${id}/ws`);
			socket.onopen = () => {
				setState((s) => ({ ...s, connected: true }));
				ping = setInterval(() => socket?.readyState === WebSocket.OPEN && socket.send("ping"), PING_MS);
			};
			socket.onmessage = (event) => {
				if (event.data === "pong") return;
				const frame = JSON.parse(event.data as string) as ServerFrame;
				if (frame.type === "world") setState((s) => ({ ...s, world: frame.world }));
				else setState((s) => ({ ...s, transcript: frame.transcript }));
			};
			socket.onclose = () => {
				clearInterval(ping);
				setState((s) => ({ ...s, connected: false }));
				if (!closed) retry = setTimeout(connect, RETRY_MS);
			};
		};
		connect();
		return () => {
			closed = true;
			clearTimeout(retry);
			clearInterval(ping);
			socket?.close();
		};
	}, [id]);
	return state;
}
