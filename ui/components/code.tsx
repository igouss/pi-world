export function Code(props: { text: string; label?: string }) {
	return (
		<div class="code">
			{props.label && <div class="code-label">{props.label}</div>}
			<pre>
				<code>{props.text}</code>
			</pre>
		</div>
	);
}
