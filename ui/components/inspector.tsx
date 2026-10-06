import type { JSX } from "preact";
import { useState } from "preact/hooks";
import type { WorldSummary } from "../../src/api/types.ts";
import { AppTab } from "./app-tab.tsx";
import { ChecksTab } from "./checks-tab.tsx";
import { ConsoleTab } from "./console-tab.tsx";
import { DataTab } from "./data-tab.tsx";
import { FunctionsTab } from "./functions-tab.tsx";
import { RevisionsTab } from "./revisions-tab.tsx";

type TabProps = { id: string; world: WorldSummary };

const TABS = {
	Functions: (p: TabProps) => <FunctionsTab id={p.id} world={p.world} />,
	Revisions: (p: TabProps) => <RevisionsTab id={p.id} head={p.world.revision} />,
	Data: (p: TabProps) => <DataTab id={p.id} revision={p.world.revision} />,
	Checks: (p: TabProps) => <ChecksTab id={p.id} world={p.world} />,
	Console: (p: TabProps) => <ConsoleTab id={p.id} />,
	App: (p: TabProps) => <AppTab id={p.id} world={p.world} />,
} satisfies Record<string, (p: TabProps) => JSX.Element>;
type Tab = keyof typeof TABS;

export function Inspector(props: { id: string; world?: WorldSummary }) {
	const [tab, setTab] = useState<Tab>("Functions");
	const world = props.world;
	return (
		<aside class="inspector">
			<div class="tabs">
				{(Object.keys(TABS) as Tab[]).map((name) => (
					<button key={name} class={tab === name ? "on" : ""} onClick={() => setTab(name)}>
						{name}
						{name === "Functions" && world ? <span class="count">{world.functions.length}</span> : null}
						{name === "Checks" && world && world.checks.length ? <span class="count">{world.checks.length}</span> : null}
					</button>
				))}
			</div>
			<div class="tab-body">
				{world ? TABS[tab]({ id: props.id, world }) : <p class="muted pad">Loading…</p>}
			</div>
		</aside>
	);
}
