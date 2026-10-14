import type { Client } from "../src/api/client.ts";
import { socketPath } from "../src/api/paths.ts";
import type { ServerFrame, Transcript, TranscriptItem } from "../src/api/types.ts";

/** Whether the agent has finished the turn begun after `baseline` items: something was added, and it is idle. */
export function settled(transcript: Transcript, baseline: number): boolean {
	return transcript.items.length > baseline && !transcript.busy && transcript.queued === 0 && transcript.streaming === undefined && transcript.tools.length === 0;
}

/** The items of `transcript` not yet shown, by id. */
export function unseen(transcript: Transcript, seen: ReadonlySet<number>): readonly TranscriptItem[] {
	return transcript.items.filter((item) => !seen.has(item.id));
}

/**
 * Sends `content` to the world's agent and follows its transcript over the world's WebSocket until the turn settles,
 * handing each new item to `show`. The socket's first transcript frame is the baseline; the message is sent after it.
 * Resolves with the final transcript.
 */
export function ask(client: Client, worldId: string, content: string, show: (item: TranscriptItem) => void, timeoutMs: number): Promise<Transcript> {
	const socket: WebSocket = new WebSocket(`${client.base.replace(/^http/, "ws")}${socketPath(worldId)}`);
	const seen: Set<number> = new Set();
	let baseline: number | undefined;
	return new Promise<Transcript>((resolve, reject) => {
		const timer: ReturnType<typeof setTimeout> = setTimeout(() => finish(new Error(`the agent did not settle within ${timeoutMs / 1000} s`)), timeoutMs);
		const finish = (outcome: Transcript | Error): void => {
			clearTimeout(timer);
			socket.close();
			if (outcome instanceof Error) reject(outcome);
			else resolve(outcome);
		};
		socket.addEventListener("error", () => finish(new Error(`the WebSocket to ${worldId} failed`)));
		socket.addEventListener("message", (event: MessageEvent) => {
			const frame: ServerFrame = JSON.parse(String(event.data)) as ServerFrame;
			if (frame.type !== "transcript") return;
			if (baseline === undefined) {
				baseline = frame.transcript.items.length;
				for (const item of frame.transcript.items) seen.add(item.id);
				client.send(worldId, content).catch(finish);
				return;
			}
			for (const item of unseen(frame.transcript, seen)) {
				seen.add(item.id);
				show(item);
			}
			if (settled(frame.transcript, baseline)) finish(frame.transcript);
		});
	});
}
