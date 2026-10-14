import type { CallResult, DevelopResult, EnrolResult, TranscriptItem } from "../src/api/types.ts";

const MAX_TOOL_TEXT: number = 600;

function clip(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max)}… (${text.length - max} more characters)`;
}

/** A develop's outcome in one or two lines: the revision and what it changed, or the rejection's reason. */
export function formatDevelop(result: DevelopResult): string {
	if (result.status === "rejected") return `rejected (#${result.rejection.n}): ${result.rejection.reason}`;
	const { n, changes } = result.revision;
	const parts: readonly string[] = (
		[
			["added", changes.added],
			["changed", changes.changed],
			["removed", changes.removed],
		] as const
	)
		.filter(([, names]) => names.length > 0)
		.map(([verb, names]) => `${verb} ${names.join(", ")}`);
	return `accepted as revision ${n}${parts.length ? `: ${parts.join("; ")}` : ""}${result.replayed ? " (replayed)" : ""}`;
}

/** A call's or an evaluation's value as JSON, or its failure. */
export function formatCall(result: CallResult): string {
	if (!result.ok) return `failed (${result.failure})${result.incident === undefined ? "" : ` as incident ${result.incident}`}: ${result.error}`;
	return JSON.stringify(result.value, null, 2);
}

export function formatEnrol(result: EnrolResult): string {
	return result.status === "enrolled" ? `enrolled "${result.check.name}"` : `refused (#${result.rejection.n}): ${result.rejection.reason}`;
}

/** A transcript item as the terminal shows it while following the agent. */
export function formatItem(item: TranscriptItem): string {
	switch (item.kind) {
		case "user":
			return `you> ${item.text}`;
		case "assistant": {
			const calls: readonly string[] = item.toolCalls.map((call) => `  → ${call.name} ${clip(JSON.stringify(call.args), MAX_TOOL_TEXT)}`);
			return [item.text ? `agent> ${item.text}` : "", ...calls, item.error ? `  ! ${item.error}` : ""].filter(Boolean).join("\n");
		}
		case "tool":
			return `  ${item.isError ? "✗" : "✓"} ${item.name}: ${clip(item.text, MAX_TOOL_TEXT)}`;
		case "notice":
			return `  · ${item.text}`;
	}
}
