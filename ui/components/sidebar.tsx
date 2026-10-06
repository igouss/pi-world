import { useState } from "preact/hooks";
import type { AccountStatus, WorldListing } from "../../src/api/types.ts";
import { api } from "../api.ts";
import { openWorld } from "../route.ts";
import { worldHash } from "../../src/api/paths.ts";
import { useAction } from "../use-action.ts";
import { AccountBox } from "./account-box.tsx";

export function Sidebar(props: {
	worlds: readonly WorldListing[];
	current?: string;
	account?: AccountStatus;
	onWorlds: () => void;
	onAccount: (status: AccountStatus) => void;
}) {
	const [name, setName] = useState("");
	const [busy, setBusy] = useState(false);
	const { error, run } = useAction();
	const create = run(async () => {
		if (!name.trim()) return;
		setBusy(true);
		try {
			const world = await api.createWorld(name);
			setName("");
			props.onWorlds();
			openWorld(world.id);
		} finally {
			setBusy(false);
		}
	});
	return (
		<nav class="sidebar">
			<a class="brand" href="#/">
				<span class="brand-mark">π</span> pi-world
			</a>
			<form class="new-world" onSubmit={create}>
				<input placeholder="New world name" value={name} onInput={(e) => setName(e.currentTarget.value)} disabled={busy} />
				<button disabled={busy || !name.trim()}>Create</button>
			</form>
			{error && <p class="error small">{error}</p>}
			<ul class="world-list">
				{props.worlds.map((world) => (
					<li key={world.id}>
						<a class={world.id === props.current ? "active" : ""} href={worldHash(world.id)}>
							{world.name}
							<span class="muted small">{world.id}</span>
						</a>
					</li>
				))}
				{props.worlds.length === 0 && <li class="muted small pad">No worlds yet.</li>}
			</ul>
			<AccountBox status={props.account} onChange={props.onAccount} />
		</nav>
	);
}
