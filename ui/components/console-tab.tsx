import { useState } from "preact/hooks";
import type { CallResult } from "../../src/api/types.ts";
import { api, type DevelopResponse } from "../api.ts";

/** Talk to the world directly, without the agent: evaluate an expression, or develop a source by hand. */
export function ConsoleTab(props: { id: string }) {
	const [expression, setExpression] = useState("");
	const [result, setResult] = useState<CallResult | undefined>();
	const [source, setSource] = useState("");
	const [summary, setSummary] = useState("");
	const [developed, setDeveloped] = useState<DevelopResponse | { status: "error"; reason: string } | undefined>();
	const evaluate = async (event: Event) => {
		event.preventDefault();
		try {
			setResult(await api.execute(props.id, expression));
		} catch (e) {
			setResult({ ok: false, failure: "request", error: (e as Error).message });
		}
	};
	const develop = async (event: Event) => {
		event.preventDefault();
		try {
			const response = await api.develop(props.id, source, summary);
			setDeveloped(response);
			if (response.status === "accepted") setSource("");
		} catch (e) {
			setDeveloped({ status: "error", reason: (e as Error).message });
		}
	};
	return (
		<div class="console">
			<form onSubmit={evaluate} class="stack">
				<h4>Evaluate</h4>
				<p class="small muted">An expression against the current world and its data. Heap changes are discarded; data writes are kept.</p>
				<input class="mono" placeholder='shoutBackwards("Hello")' value={expression} onInput={(e) => setExpression(e.currentTarget.value)} />
				<button class="primary" disabled={!expression.trim()}>
					Evaluate
				</button>
			</form>
			{result && <pre class={`tool-result ${result.ok ? "ok" : "error"}`}>{result.ok ? JSON.stringify(result.value, null, 2) : `${result.failure}: ${result.error}`}</pre>}
			<form onSubmit={develop} class="stack">
				<h4>Develop by hand</h4>
				<p class="small muted">The same attempt the agent's develop makes: checkpoint, evaluate, checks, then a new revision or a restore.</p>
				<textarea class="mono" rows={8} placeholder={'define("double", (x) => 2 * x, { doc: "Twice x" });'} value={source} onInput={(e) => setSource(e.currentTarget.value)} />
				<input placeholder="Summary" value={summary} onInput={(e) => setSummary(e.currentTarget.value)} />
				<button class="primary" disabled={!source.trim()}>
					Develop
				</button>
			</form>
			{developed && (
				<pre class={`tool-result ${developed.status === "accepted" ? "ok" : "error"}`}>
					{developed.status === "accepted" ? `Accepted as revision ${developed.revision.n}.` : developed.reason}
				</pre>
			)}
		</div>
	);
}
