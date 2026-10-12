import type { FunctionInfo } from "../../src/api/types.ts";

/** The definitions one definition calls and is called by, as its source names them. */
export function CallGraph(props: { fn: FunctionInfo }) {
	// A cell from an older build sends no call graph until it moves to this one.
	const { calls = [], calledBy = [] } = props.fn;
	const parts = [calls.length ? `calls ${calls.join(", ")}` : "", calledBy.length ? `called by ${calledBy.join(", ")}` : ""].filter(Boolean);
	return parts.length ? <p class="small muted">{parts.join(" · ")}</p> : null;
}
