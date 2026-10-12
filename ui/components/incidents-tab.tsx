import { useState } from "preact/hooks";
import type { CallResult, Incident } from "../../src/api/types.ts";
import { api } from "../api.ts";
import { parseArg } from "../parse-arg.ts";
import { useAction } from "../use-action.ts";
import { CallResultView } from "./call-result.tsx";
import { Code } from "./code.tsx";
import { NumberedList } from "./numbered-list.tsx";
import { firstLine } from "../../src/api/text.ts";

/** Calls that failed. Fix the definition, then retry the call; or answer it yourself, or dismiss it. */
export function IncidentsTab(props: { id: string; open: number; revision: number }) {
	return (
		<div class="revisions">
			<p class="small muted">
				Calls of this world's definitions that failed. A failed call wrote no data, so retrying it after a fix is safe.
			</p>
			{props.open === 0 && <p class="muted pad">No call is failing.</p>}
			<NumberedList
				load={(before?: number) => api.incidents(props.id, before)}
				version={`${props.id}:${props.open}:${props.revision}`}
				label={(i: Incident) => ({
					n: `#${i.n}`,
					kind: i.resolution ? i.resolution.kind : "open",
					kindClass: i.resolution ? "closed" : "open",
					summary: `${i.name}: ${firstLine(i.error)}${i.count > 1 ? ` (${i.count}×)` : ""}`,
				})}
				detail={(i: Incident) => <IncidentDetail id={props.id} incident={i} />}
			/>
		</div>
	);
}

function IncidentDetail(props: { id: string; incident: Incident }) {
	const i = props.incident;
	const [retried, setRetried] = useState<CallResult | undefined>();
	const [value, setValue] = useState("null");
	const [reason, setReason] = useState("");
	const { error, run } = useAction();
	const retry = run(async () => setRetried(await api.retryIncident(props.id, i.n)));
	const answer = run(() => api.returnFromIncident(props.id, i.n, parseArg(value) ?? null).then(() => undefined));
	const dismiss = run(() => api.dismissIncident(props.id, i.n, reason).then(() => undefined));
	const askAgent = run(() =>
		api
			.send(props.id, `The call ${i.name}(${i.args ? i.args.map((a) => JSON.stringify(a)).join(", ") : "…"}) failed at revision ${i.revision} (incident #${i.n}):\n${firstLine(i.error)}\nFix ${i.name}, then retry the incident.`)
			.then(() => undefined),
	);
	return (
		<div class="rev-detail">
			<p class="small muted">
				failed {i.count}× · last at revision {i.revision} · {new Date(i.lastAt).toLocaleString()}
				{i.retries > 0 && ` · ${i.retries} failed retries`}
			</p>
			<Code text={i.args ? JSON.stringify(i.args, null, 2) : "not kept: too large"} label="arguments" />
			<pre class="changes">{i.error}</pre>
			{i.resolution ? (
				<p class="small">
					Closed by {i.resolution.by}: {i.resolution.kind === "dismissed" ? `dismissed, ${i.resolution.reason}` : `${i.resolution.kind}, ${JSON.stringify(i.resolution.value)}`}
				</p>
			) : (
				<>
					<div class="row">
						<button class="primary" onClick={askAgent}>
							Ask the agent to fix it
						</button>
						<button disabled={!i.args} onClick={retry}>
							Retry now
						</button>
					</div>
					{retried && <CallResultView result={retried} />}
					<form class="row" onSubmit={answer}>
						<input class="mono" placeholder="Answer: JSON or text" value={value} onInput={(e) => setValue(e.currentTarget.value)} />
						<button>Answer with this</button>
					</form>
					<form class="row" onSubmit={dismiss}>
						<input placeholder="Why dismiss it?" value={reason} onInput={(e) => setReason(e.currentTarget.value)} />
						<button class="danger" disabled={!reason.trim()}>
							Dismiss
						</button>
					</form>
				</>
			)}
			{error && <p class="error small">{error}</p>}
		</div>
	);
}
