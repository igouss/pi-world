import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import { useAction } from "../use-action.ts";

interface Numbered {
	readonly n: number;
	readonly summary: string;
	readonly at: number;
}

/**
 * A newest-first list of numbered entries, a page at a time, each opening into its detail. It reloads its first page
 * when `version` changes.
 */
export function NumberedList<T extends Numbered>(props: {
	load: (before?: number) => Promise<T[]>;
	version: unknown;
	label: (entry: T) => { readonly n: string; readonly kind: string; readonly kindClass: string };
	highlight?: (entry: T) => boolean;
	detail: (entry: T) => ComponentChildren;
}) {
	const [entries, setEntries] = useState<T[]>([]);
	const [open, setOpen] = useState<number | undefined>();
	const { error, run } = useAction();
	useEffect(() => void run(async () => setEntries(await props.load()))(), [props.version]);
	const last = entries.at(-1);
	const more = run(async () => {
		if (last) setEntries([...entries, ...(await props.load(last.n))]);
	});
	return (
		<>
			{error && <p class="error">{error}</p>}
			<ul>
				{entries.map((entry) => {
					const label = props.label(entry);
					return (
						<li key={entry.n} class={props.highlight?.(entry) ? "head" : ""}>
							<button class={open === entry.n ? "on" : ""} onClick={() => setOpen(open === entry.n ? undefined : entry.n)}>
								<span class="rev-n">{label.n}</span>
								<span class={`kind ${label.kindClass}`}>{label.kind}</span>
								<span class="rev-summary">{entry.summary}</span>
								<span class="muted small">{new Date(entry.at).toLocaleString()}</span>
							</button>
							{open === entry.n && props.detail(entry)}
						</li>
					);
				})}
			</ul>
			{last && last.n > 0 && (
				<button class="link" onClick={more}>
					older…
				</button>
			)}
		</>
	);
}
