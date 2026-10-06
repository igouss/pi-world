import type { JSX } from "preact";
import type { ToolCallItem } from "../../src/api/types.ts";
import { Code } from "./code.tsx";

export interface ToolOutcome {
	readonly state: "ok" | "error" | "running" | "lost";
	readonly text: string;
}

type Args = Record<string, unknown>;

interface Presenter {
	title(args: Args): string;
	body(args: Args): JSX.Element | null;
}

const text = (value: unknown): string => (value === undefined ? "" : String(value));

/** How each agent tool's arguments are shown; a tool without an entry shows its arguments as JSON. */
const PRESENTERS: Record<string, Presenter> = {
	develop: { title: (a) => text(a.summary) || "develop", body: (a) => <Code text={text(a.source)} /> },
	execute: { title: (a) => text(a.expression), body: () => null },
	propose_check: {
		title: (a) => `check: ${text(a.name)}`,
		body: (a) => (
			<>
				<Code text={text(a.expression)} label="must stay true" />
				<Code text={text(a.counterexample)} label="counterexample" />
			</>
		),
	},
	rollback: { title: (a) => `rollback to ${text(a.revision)}: ${text(a.reason)}`, body: () => null },
};

const FALLBACK: Presenter = { title: (a) => JSON.stringify(a), body: (a) => <Code text={JSON.stringify(a, null, 2)} /> };

const MARKS: Record<ToolOutcome["state"], string> = { ok: "✓", error: "✗", running: "…", lost: "?" };

/** One tool call and its result. */
export function ToolCallCard(props: { call: ToolCallItem; outcome: ToolOutcome }) {
	const { call, outcome } = props;
	const args = (call.args ?? {}) as Args;
	const presenter = PRESENTERS[call.name] ?? FALLBACK;
	return (
		<details class={`tool ${outcome.state}`} open={call.name === "develop" && outcome.state === "error"}>
			<summary>
				<span class="tool-name">{call.name}</span>
				<span class="tool-title">{presenter.title(args)}</span>
				<span class="tool-state">{MARKS[outcome.state]}</span>
			</summary>
			{presenter.body(args)}
			{outcome.text && <pre class={`tool-result ${outcome.state}`}>{outcome.text}</pre>}
		</details>
	);
}
