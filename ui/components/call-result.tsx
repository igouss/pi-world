import type { CallResult } from "../../src/api/types.ts";

export function CallResultView(props: { result: CallResult }) {
	const { result } = props;
	return (
		<pre class={`tool-result ${result.ok ? "ok" : "error"}`}>{result.ok ? JSON.stringify(result.value, null, 2) : `${result.failure}: ${result.error}`}</pre>
	);
}
