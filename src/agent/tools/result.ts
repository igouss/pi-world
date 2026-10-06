import type { ToolExecutionResult } from "@earendil-works/pi-durable";

export function text(body: string, isError: boolean = false): ToolExecutionResult {
	return { content: [{ type: "text", text: body }], ...(isError ? { isError: true } : {}) };
}

/** JSON for the model, cut to a size it can read. */
export function show(value: unknown, limit: number = 8_000): string {
	const json = JSON.stringify(value, null, 2) ?? "undefined";
	return json.length <= limit ? json : `${json.slice(0, limit)}\n... (${json.length - limit} more characters)`;
}
