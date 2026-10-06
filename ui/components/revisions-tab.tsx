import { useEffect, useState } from "preact/hooks";
import type { Revision } from "../../src/api/types.ts";
import { api } from "../api.ts";
import { Code } from "./code.tsx";

export function RevisionsTab(props: { id: string; head: number }) {
	const [revisions, setRevisions] = useState<Revision[]>([]);
	const [open, setOpen] = useState<number | undefined>();
	const [error, setError] = useState("");
	useEffect(() => {
		void api.revisions(props.id).then(setRevisions, (e: Error) => setError(e.message));
	}, [props.id, props.head]);
	const more = async () => {
		const last = revisions[revisions.length - 1];
		if (last) setRevisions([...revisions, ...(await api.revisions(props.id, last.n))]);
	};
	return (
		<div class="revisions">
			{error && <p class="error">{error}</p>}
			<ul>
				{revisions.map((r) => (
					<li key={r.n} class={r.n === props.head ? "head" : ""}>
						<button class={open === r.n ? "on" : ""} onClick={() => setOpen(open === r.n ? undefined : r.n)}>
							<span class="rev-n">{r.n}</span>
							<span class={`kind ${r.kind}`}>{r.kind}</span>
							<span class="rev-summary">{r.summary}</span>
							<span class="muted small">{new Date(r.at).toLocaleString()}</span>
						</button>
						{open === r.n && <RevisionDetail id={props.id} revision={r} head={props.head} />}
					</li>
				))}
			</ul>
			{revisions.length > 0 && revisions[revisions.length - 1]!.n > 0 && (
				<button class="link" onClick={() => void more()}>
					older…
				</button>
			)}
		</div>
	);
}

function RevisionDetail(props: { id: string; revision: Revision; head: number }) {
	const r = props.revision;
	const [reason, setReason] = useState("");
	const [error, setError] = useState("");
	const rollback = async (event: Event) => {
		event.preventDefault();
		setError("");
		try {
			await api.rollback(props.id, r.n, reason);
			setReason("");
		} catch (e) {
			setError((e as Error).message);
		}
	};
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
			{r.kind === "develop" && <Code text={r.source} label="source" />}
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
