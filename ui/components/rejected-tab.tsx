import type { Rejection } from "../../src/api/types.ts";
import { rejectionCause } from "../../src/revision/rejection.ts";
import { api } from "../api.ts";
import { Code } from "./code.tsx";
import { DevelopSource } from "./develop-source.tsx";
import { NumberedList } from "./numbered-list.tsx";

/** Rejected develops and refused checks, newest first. Nothing here changed the world. */
export function RejectedTab(props: { id: string; count: number }) {
	return (
		<div class="revisions">
			<p class="small muted">Attempts the world turned away. Each left the world unchanged.</p>
			{props.count === 0 && <p class="muted pad">Nothing has been rejected.</p>}
			<NumberedList
				load={(before?: number) => api.rejections(props.id, before)}
				version={`${props.id}:${props.count}`}
				label={(r: Rejection) => ({ n: `#${r.n}`, kind: rejectionCause(r), kindClass: r.kind })}
				detail={(r: Rejection) => <RejectionDetail rejection={r} />}
			/>
		</div>
	);
}

function RejectionDetail(props: { rejection: Rejection }) {
	const r = props.rejection;
	return (
		<div class="rev-detail">
			<p class="small muted">
				by {r.origin.by} · against revision {r.base}
			</p>
			<pre class="changes">{r.reason}</pre>
			{r.kind === "develop" ? (
				<DevelopSource source={r.source} written={r.written} />
			) : (
				<>
					<Code text={r.expression} label={`check "${r.name}"`} />
					<Code text={r.counterexample} label="counterexample" />
					{r.generator !== undefined && <Code text={JSON.stringify(r.generator)} label="input generator" />}
				</>
			)}
		</div>
	);
}
