import type { AssistantMessage, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import type { ConversationView, EntryRecord, LiveState } from "@earendil-works/pi-durable";
import type { ToolCallItem, Transcript, TranscriptItem } from "../api/types.ts";

/** What the web UI shows of a conversation: the messages people read, without system entries. */
export function toTranscript(view: ConversationView): Transcript {
	const items = view.entries.flatMap(toItems);
	const live = view.docs["pi.live"] as LiveState | undefined;
	const inbox = view.docs["pi.inbox"] as { items?: unknown[] } | undefined;
	const partial = live?.generation?.message as AssistantMessage | undefined;
	return {
		items,
		busy: live?.run !== undefined,
		...(partial ? { streaming: assistantParts(partial) } : {}),
		...(live?.generation?.retry ? { retry: live.generation.retry } : {}),
		tools: (live?.tools ?? []).map((slot) => ({ callId: slot.callId, name: slot.name, status: slot.status, output: slot.output ?? "" })),
		queued: inbox?.items?.length ?? 0,
	};
}

function toItems(entry: EntryRecord): TranscriptItem[] {
	const id = entry.id as unknown as number;
	const messages = (entry.model ?? []) as unknown[];
	switch (entry.kind) {
		case "pi.user":
			return messages.map((message) => {
				const user = message as UserMessage;
				return { kind: "user", id, text: textOf(user.content), at: user.timestamp };
			});
		case "pi.assistant":
			return messages.map((message) => {
				const assistant = message as AssistantMessage;
				const parts = assistantParts(assistant);
				const failed = assistant.stopReason === "error" || assistant.stopReason === "aborted";
				return {
					kind: "assistant",
					id,
					...parts,
					...(failed ? { error: assistant.errorMessage ?? assistant.stopReason } : {}),
					at: assistant.timestamp,
				};
			});
		case "pi.tool-result":
			return messages.map((message) => {
				const result = message as ToolResultMessage;
				return { kind: "tool", id, callId: result.toolCallId, name: result.toolName, text: textOf(result.content), isError: result.isError };
			});
		case "pi.reset":
			return [{ kind: "notice", id, text: "The conversation was reset." }];
		case "pi.compaction":
			return [{ kind: "notice", id, text: "Earlier messages were summarised." }];
		default:
			return [];
	}
}

function assistantParts(message: AssistantMessage): { text: string; thinking: string; toolCalls: ToolCallItem[] } {
	let text = "";
	let thinking = "";
	const toolCalls: ToolCallItem[] = [];
	for (const part of message.content ?? []) {
		if (part.type === "text") text += part.text;
		else if (part.type === "thinking") thinking += part.thinking;
		else if (part.type === "toolCall") toolCalls.push({ id: part.id, name: part.name, args: part.arguments });
	}
	return { text, thinking, toolCalls };
}

function textOf(content: string | readonly { type: string; text?: string }[]): string {
	if (typeof content === "string") return content;
	return content.map((part) => (part.type === "text" ? (part.text ?? "") : `[${part.type}]`)).join("");
}
