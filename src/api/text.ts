export function hex(bytes: Uint8Array): string {
	return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function escapeHtml(text: string): string {
	return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** The first line of an error or message, which is what names it. */
export function firstLine(text: string): string {
	return text.split("\n")[0]!;
}
