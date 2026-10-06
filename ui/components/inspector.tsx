import { useState } from "preact/hooks";
import type { WorldSummary } from "../../src/api/types.ts";
import { AppTab } from "./app-tab.tsx";
import { ChecksTab } from "./checks-tab.tsx";
import { ConsoleTab } from "./console-tab.tsx";
import { DataTab } from "./data-tab.tsx";
import { FunctionsTab } from "./functions-tab.tsx";
import { RevisionsTab } from "./revisions-tab.tsx";

const TABS = ["Functions", "Revisions", "Data", "Checks", "Console", "App"] as const;
type Tab = (typeof TABS)[number];

export function Inspector(props: { id: string; world?: WorldSummary }) {
	const [tab, setTab] = useState<Tab>("Functions");
	const world = props.world;
	return (
		<aside class="inspector">
			<div class="tabs">
				{TABS.map((name) => (
					<button key={name} class={tab === name ? "on" : ""} onClick={() => setTab(name)}>
						{name}
						{name === "Functions" && world ? <span class="count">{world.functions.length}</span> : null}
						{name === "Checks" && world && world.checks.length ? <span class="count">{world.checks.length}</span> : null}
					</button>
				))}
			</div>
			<div class="tab-body">
				{!world ? (
					<p class="muted pad">Loading…</p>
				) : tab === "Functions" ? (
					<FunctionsTab id={props.id} world={world} />
				) : tab === "Revisions" ? (
					<RevisionsTab id={props.id} head={world.revision} />
				) : tab === "Data" ? (
					<DataTab id={props.id} revision={world.revision} />
				) : tab === "Checks" ? (
					<ChecksTab id={props.id} world={world} />
				) : tab === "Console" ? (
					<ConsoleTab id={props.id} />
				) : (
					<AppTab id={props.id} world={world} />
				)}
			</div>
		</aside>
	);
}
