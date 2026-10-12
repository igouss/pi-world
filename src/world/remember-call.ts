/**
 * Record that tool call `callId` produced `n`, keeping only the newest `keep` calls. A rerun of a tool call after a
 * crash finds its result here; a call older than the newest `keep` is long settled.
 */
export function rememberCall(calls: Record<string, number>, callId: string, n: number, keep: number): void {
	calls[callId] = n;
	const keys = Object.keys(calls);
	for (const key of keys.slice(0, Math.max(0, keys.length - keep))) delete calls[key];
}
