/** A typed argument: JSON when it parses, otherwise the text as a string. */
export function parseArg(text: string): unknown {
	if (text.trim() === "") return undefined;
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}
