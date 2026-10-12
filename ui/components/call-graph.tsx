import type { FunctionInfo } from "../../src/api/types.ts";

/** The definitions one definition calls and is called by, as its source names them. */
export function CallGraph(props: { fn: FunctionInfo }) {
	const parts = [
		props.fn.calls.length ? `calls ${props.fn.calls.join(", ")}` : "",
		props.fn.calledBy.length ? `called by ${props.fn.calledBy.join(", ")}` : "",
	].filter(Boolean);
	return parts.length ? <p class="small muted">{parts.join(" · ")}</p> : null;
}
