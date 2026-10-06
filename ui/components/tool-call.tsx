import type { ToolCallItem } from "../../src/api/types.ts";
import { Code } from "./code.tsx";

export interface ToolOutcome {
	readonly state: "ok" | "error" | "running" | "lost";
	readonly text: string;
}

/** One tool call and its result. A develop shows its source; the rest show their arguments. */
export function ToolCallCard(props: { call: ToolCallItem; outcome: ToolOutcome }) {
	const { call, outcome } = props;
	const args = (call.args ?? {}) as Record<string, unknown>;
	const title =
		call.name === "develop"
			? String(args.summary ?? "develop")
			: call.name === "execute"
				? String(args.expression ?? "")
				: call.name === "propose_check"
					? `check: ${String(args.name ?? "")}`
					: call.name === "rollback"
						? `rollback to ${String(args.revision)}`
						: JSON.stringify(args);
	return (
		<details class={`tool ${outcome.state}`} open={call.name === "develop" && outcome.state === "error"}>
			<summary>
				<span class="tool-name">{call.name}</span>
				<span class="tool-title">{title}</span>
				<span class="tool-state">{outcome.state === "running" ? "…" : outcome.state === "ok" ? "✓" : outcome.state === "error" ? "✗" : "?"}</span>
			</summary>
			{call.name === "develop" && typeof args.source === "string" && <Code text={args.source} />}
			{call.name === "propose_check" && (
				<>
					<Code text={String(args.expression ?? "")} label="must stay true" />
					<Code text={String(args.counterexample ?? "")} label="counterexample" />
				</>
			)}
			{!["develop", "execute", "propose_check"].includes(call.name) && <Code text={JSON.stringify(args, null, 2)} />}
			{outcome.text && <pre class={`tool-result ${outcome.state}`}>{outcome.text}</pre>}
		</details>
	);
}
