import { useState } from "preact/hooks";
import type { CallResult, FunctionInfo, WorldSummary } from "../../src/api/types.ts";
import { api } from "../api.ts";
import { Code } from "./code.tsx";

export function FunctionsTab(props: { id: string; world: WorldSummary }) {
	const [selected, setSelected] = useState<string | undefined>();
	const functions = props.world.functions;
	const current = functions.find((f) => f.name === selected);
	if (functions.length === 0) return <p class="muted pad">Nothing defined yet. Ask the agent for a function.</p>;
	return (
		<div class="functions">
			<ul class="fn-list">
				{functions.map((f) => (
					<li key={f.name}>
						<button class={f.name === selected ? "on" : ""} onClick={() => setSelected(f.name === selected ? undefined : f.name)}>
							<code class="sig">
								{f.kind === "class" ? "class " : ""}
								{f.name}({f.params})
							</code>
							{f.version > 1 && <span class="badge">v{f.version}</span>}
							{f.doc && <span class="doc">{f.doc}</span>}
						</button>
						{f.name === selected && current && <FunctionDetail key={`${f.name}-${props.world.revision}`} id={props.id} fn={current} />}
					</li>
				))}
			</ul>
		</div>
	);
}

function paramNames(params: string): string[] {
	return params
		.split(",")
		.map((p) => p.trim().replace(/=.*$/, "").trim())
		.filter(Boolean);
}

/** A typed argument: JSON when it parses, otherwise the text as a string. */
function parseArg(text: string): unknown {
	if (text.trim() === "") return undefined;
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

function FunctionDetail(props: { id: string; fn: FunctionInfo }) {
	const names = paramNames(props.fn.params);
	const simple = names.every((n) => /^[A-Za-z_$][\w$]*$/.test(n));
	const [values, setValues] = useState<string[]>(names.map(() => ""));
	const [raw, setRaw] = useState("[]");
	const [useRaw, setUseRaw] = useState(!simple);
	const [result, setResult] = useState<CallResult | undefined>();
	const [running, setRunning] = useState(false);
	const args = (): unknown[] => {
		if (useRaw) return JSON.parse(raw) as unknown[];
		const parsed = values.map(parseArg);
		while (parsed.length && parsed[parsed.length - 1] === undefined) parsed.pop();
		return parsed;
	};
	const call = async (event: Event) => {
		event.preventDefault();
		setRunning(true);
		try {
			setResult(await api.call(props.id, props.fn.name, args()));
		} catch (e) {
			setResult({ ok: false, failure: "request", error: (e as Error).message });
		} finally {
			setRunning(false);
		}
	};
	let curlArgs = "[]";
	try {
		curlArgs = JSON.stringify(args());
	} catch {
		// shown as [] while the raw JSON is incomplete
	}
	return (
		<div class="fn-detail">
			<form class="call-form" onSubmit={call}>
				{!useRaw &&
					names.map((name, i) => (
						<label key={name}>
							<span>{name}</span>
							<input
								placeholder='JSON or text, e.g. "Hello", 3, [1,2]'
								value={values[i]}
								onInput={(e) => {
									const next = [...values];
									next[i] = e.currentTarget.value;
									setValues(next);
								}}
							/>
						</label>
					))}
				{useRaw && (
					<label>
						<span>args (JSON array)</span>
						<input value={raw} onInput={(e) => setRaw(e.currentTarget.value)} />
					</label>
				)}
				<div class="row">
					<button class="primary" disabled={running}>
						{running ? "Calling…" : `Call ${props.fn.name}`}
					</button>
					<button type="button" class="link small" onClick={() => setUseRaw(!useRaw)}>
						{useRaw ? "per-argument fields" : "raw JSON"}
					</button>
				</div>
			</form>
			{result && (
				<pre class={`tool-result ${result.ok ? "ok" : "error"}`}>
					{result.ok ? JSON.stringify(result.value, null, 2) : `${result.failure}: ${result.error}`}
				</pre>
			)}
			<Code text={props.fn.source} label="source" />
			<details class="curl">
				<summary class="small muted">call it over REST</summary>
				<Code
					text={`curl -X POST ${location.origin}/api/worlds/${props.id}/call/${props.fn.name} \\\n  -H 'content-type: application/json' \\\n  -d '${JSON.stringify({ args: JSON.parse(curlArgs) })}'`}
				/>
			</details>
		</div>
	);
}
