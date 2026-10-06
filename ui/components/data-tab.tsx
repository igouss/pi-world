import { useEffect, useState } from "preact/hooks";
import type { DataRow } from "../../src/api/types.ts";
import { api } from "../api.ts";
import { useAction } from "../use-action.ts";

export function DataTab(props: { id: string; revision: number }) {
	const [prefix, setPrefix] = useState("");
	const [rows, setRows] = useState<DataRow[]>([]);
	const { error, run } = useAction();
	const load = () => void run(async () => setRows(await api.data(props.id, prefix)))();
	useEffect(load, [props.id, props.revision, prefix]);
	return (
		<div class="data">
			<div class="row">
				<input placeholder="Key prefix, e.g. todo:" value={prefix} onInput={(e) => setPrefix(e.currentTarget.value)} />
				<button onClick={load}>Refresh</button>
			</div>
			{error && <p class="error">{error}</p>}
			{rows.length === 0 ? (
				<p class="muted pad">No data{prefix ? ` under "${prefix}"` : ""}. Functions write it with data.set(key, value) when they are called.</p>
			) : (
				<table>
					<tbody>
						{rows.map((row) => (
							<tr key={row.key}>
								<td class="key">
									<code>{row.key}</code>
								</td>
								<td>
									<pre>{JSON.stringify(row.value, null, 1)}</pre>
								</td>
								<td>
									<button class="link small" title="Delete this row" onClick={() => void api.deleteData(props.id, row.key).then(load)}>
										✕
									</button>
								</td>
							</tr>
						))}
					</tbody>
				</table>
			)}
		</div>
	);
}
