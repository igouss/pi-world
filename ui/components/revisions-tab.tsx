import { useState } from "preact/hooks";
import type { Revision } from "../../src/api/types.ts";
import { api } from "../api.ts";
import { useAction } from "../use-action.ts";
import { Code } from "./code.tsx";
import { DevelopSource } from "./develop-source.tsx";
import { NumberedList } from "./numbered-list.tsx";

export function RevisionsTab(props: { id: string; head: number }) {
	return (
		<div class="revisions">
			<NumberedList
				load={(before?: number) => api.revisions(props.id, before)}
				version={`${props.id}:${props.head}`}
				label={(r: Revision) => ({ n: String(r.n), kind: r.kind, kindClass: r.kind, summary: r.summary })}
				highlight={(r: Revision) => r.n === props.head}
				detail={(r: Revision) => <RevisionDetail id={props.id} revision={r} head={props.head} />}
			/>
		</div>
	);
}

function RevisionDetail(props: { id: string; revision: Revision; head: number }) {
	const r = props.revision;
	const [reason, setReason] = useState("");
	const { error, run } = useAction();
	const rollback = run(async () => {
		await api.rollback(props.id, r.n, reason);
		setReason("");
	});
	const changes = [
		...r.changes.added.map((n) => `+ ${n}`),
		...r.changes.changed.map((n) => `~ ${n}`),
		...r.changes.removed.map((n) => `- ${n}`),
	];
	return (
		<div class="rev-detail">
			<p class="small muted">
				by {r.origin.by}
				{r.origin.by === "agent" ? ` (call ${r.origin.callId.slice(0, 12)}…)` : ""} · {(r.bytes / 1024).toFixed(0)} KB snapshot · blob{" "}
				<code>{r.blob.slice(0, 12)}</code>
			</p>
			{changes.length > 0 && <pre class="changes">{changes.join("\n")}</pre>}
			{r.kind === "develop" && <DevelopSource source={r.source} written={r.written} />}
			{r.kind === "rollback" && (
				<p>
					Restored revision {r.target}: {r.reason}
				</p>
			)}
			{r.n !== props.head && (
				<form class="row" onSubmit={rollback}>
					<input placeholder="Why roll back?" value={reason} onInput={(e) => setReason(e.currentTarget.value)} />
					<button class="danger" disabled={!reason.trim()}>
						Roll back to {r.n}
					</button>
				</form>
			)}
			{error && <p class="error small">{error}</p>}
		</div>
	);
}
