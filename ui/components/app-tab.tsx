import { useState } from "preact/hooks";
import { appPath } from "../../src/api/paths.ts";
import type { WorldSummary } from "../../src/api/types.ts";

export function AppTab(props: { id: string; world: WorldSummary }) {
	const [nonce, setNonce] = useState(0);
	const appSource = props.world.functions.find((f) => f.name === "app")?.source ?? "";
	if (!props.world.hasApp)
		return (
			<p class="muted pad">
				This world serves no page yet. Ask the agent: <em>"Make an app page for this."</em> A world serves a page by defining <code>app(path, query)</code>,
				which returns HTML.
			</p>
		);
	return (
		<div class="app-tab">
			<div class="row">
				<a class="button" href={appPath(props.id)} target="_blank" rel="noopener">
					Open in a new tab ↗
				</a>
				<button onClick={() => setNonce(nonce + 1)}>Reload</button>
			</div>
			<iframe key={`${appSource}-${nonce}`} src={appPath(props.id)} title="World app" />
		</div>
	);
}
