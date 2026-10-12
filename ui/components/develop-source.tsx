import { Code } from "./code.tsx";

/** A develop source as written and, when the host rewrite changed it, as evaluated. */
export function DevelopSource(props: { source: string; written?: string }) {
	return (
		<>
			<Code text={props.written ?? props.source} label="source" />
			{props.written !== undefined && (
				<details>
					<summary class="small muted">as evaluated, after the host rewrite</summary>
					<Code text={props.source} />
				</details>
			)}
		</>
	);
}
