import type { AccountStatus } from "../../src/api/types.ts";

export function Welcome(props: { account?: AccountStatus; hasWorlds: boolean; onLogin: () => void }) {
	const connected = props.account !== undefined && props.account.state !== "none";
	return (
		<div class="welcome">
			<h1>Grow a program by talking to it.</h1>
			<p>
				A <strong>world</strong> is a live JavaScript heap. You ask for changes; the agent writes them with <code>develop</code>. Each change runs
				against a checkpoint and becomes an immutable revision only if it evaluates cleanly and every check still holds. A failed change leaves no trace.
			</p>
			<ol class="steps">
				<li class={connected ? "done" : ""}>
					Connect your Claude subscription.{" "}
					{!connected && (
						<button class="primary small-button" onClick={props.onLogin}>
							Connect Claude
						</button>
					)}
				</li>
				<li class={props.hasWorlds ? "done" : ""}>Create a world (top of the sidebar).</li>
				<li>
					Ask for something: <em>"Add a function that splits a bill between n people, rounding to cents."</em>
				</li>
				<li>
					Call your functions from the <strong>Functions</strong> tab, no model involved, or over REST:{" "}
					<code>POST /api/worlds/:id/call/:fn {"{"}"args": [...]{"}"}</code>.
				</li>
				<li>
					Ask for a page: <em>"Make an app page for it."</em> It is served at <code>/w/:id/</code>.
				</li>
			</ol>
		</div>
	);
}
