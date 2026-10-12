import { useEffect, useState } from "preact/hooks";
import type { WorldListing, WorldSummary } from "../../src/api/types.ts";
import { api } from "../api.ts";
import { useAction } from "../use-action.ts";

/** Which other worlds this world's code may call. Only the owner sets it; the agent cannot. */
export function AccessTab(props: { id: string; world: WorldSummary }) {
	const granted = props.world.grants.calls;
	const list = granted === "any" ? undefined : granted;
	const [others, setOthers] = useState<WorldListing[]>([]);
	const { error, run } = useAction();
	useEffect(() => void run(async () => setOthers((await api.worlds()).filter((w) => w.id !== props.id)))(), [props.id]);
	const set = (calls: "any" | string[]) => run(() => api.setGrants(props.id, { calls }).then(() => undefined));
	const toggle = (current: readonly string[], id: string) => set(current.includes(id) ? current.filter((g) => g !== id) : [...current, id]);
	return (
		<div class="access">
			<p class="small muted">Which other worlds this world's code may call with worlds.call. Only you can change this; the agent cannot.</p>
			<label class="row">
				<input type="radio" checked={granted === "any"} onChange={set("any")} /> Any world on this server
			</label>
			<label class="row">
				<input type="radio" checked={granted !== "any"} onChange={set([])} /> Only the worlds checked below
			</label>
			{list &&
				(others.length === 0 ? (
					<p class="muted pad">There are no other worlds.</p>
				) : (
					others.map((w) => (
						<label key={w.id} class="row">
							<input type="checkbox" checked={list.includes(w.id)} onChange={toggle(list, w.id)} /> {w.name} <code class="small">{w.id}</code>
						</label>
					))
				))}
			{error && <p class="error small">{error}</p>}
		</div>
	);
}
