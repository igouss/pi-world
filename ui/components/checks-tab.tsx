import { useEffect, useState } from "preact/hooks";
import type { Check, WorldSummary } from "../../src/api/types.ts";
import { api } from "../api.ts";
import { Code } from "./code.tsx";

export function ChecksTab(props: { id: string; world: WorldSummary }) {
	const [removed, setRemoved] = useState<{ check: Check; reason: string; removedAt: number }[]>([]);
	useEffect(() => void api.checks(props.id).then((state) => setRemoved(state.removed)), [props.id, props.world.checks.length]);
	return (
		<div class="checks">
			<p class="small muted">
				Every develop must leave each check exactly <code>true</code>. The agent can only add checks, after showing one fails on a counterexample.
				Only you can remove one.
			</p>
			{props.world.checks.length === 0 && <p class="muted pad">No checks. Ask the agent to protect a behaviour: "add a check that …".</p>}
			{props.world.checks.map((check) => (
				<CheckCard key={check.name} id={props.id} check={check} />
			))}
			{removed.length > 0 && (
				<details>
					<summary class="small muted">{removed.length} removed</summary>
					{removed.map((r) => (
						<p key={r.check.name + r.removedAt} class="small">
							<strong>{r.check.name}</strong>: {r.reason}
						</p>
					))}
				</details>
			)}
		</div>
	);
}

function CheckCard(props: { id: string; check: Check }) {
	const [reason, setReason] = useState("");
	const [error, setError] = useState("");
	const remove = async (event: Event) => {
		event.preventDefault();
		try {
			await api.removeCheck(props.id, props.check.name, reason);
		} catch (e) {
			setError((e as Error).message);
		}
	};
	return (
		<div class="card">
			<h4>{props.check.name}</h4>
			<Code text={props.check.expression} label="must stay true" />
			<details>
				<summary class="small muted">counterexample it was seen failing on</summary>
				<Code text={props.check.counterexample} />
			</details>
			<form class="row" onSubmit={remove}>
				<input placeholder="Reason for removing" value={reason} onInput={(e) => setReason(e.currentTarget.value)} />
				<button class="danger" disabled={!reason.trim()}>
					Remove
				</button>
			</form>
			{error && <p class="error small">{error}</p>}
		</div>
	);
}
