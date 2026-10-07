import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import type { ToolCallItem, Transcript, TranscriptItem } from "../../src/api/types.ts";
import { api } from "../api.ts";
import { markdown } from "../markdown.ts";
import { ToolCallCard, type ToolOutcome } from "./tool-call.tsx";

type ToolItem = Extract<TranscriptItem, { kind: "tool" }>;

export function Conversation(props: { id: string; transcript?: Transcript; loggedIn: boolean; onLogin: () => void }) {
	const transcript = props.transcript;
	const results = new Map<string, ToolItem>();
	for (const item of transcript?.items ?? []) if (item.kind === "tool") results.set(item.callId, item);
	const running = new Map((transcript?.tools ?? []).map((tool) => [tool.callId, tool]));
	const outcome = (call: ToolCallItem): ToolOutcome => {
		const result = results.get(call.id);
		if (result) return { state: result.isError ? "error" : "ok", text: result.text };
		const slot = running.get(call.id);
		if (slot) return { state: "running", text: slot.output };
		return { state: transcript?.busy ? "running" : "lost", text: "" };
	};
	const scroller = useRef<HTMLDivElement>(null);
	const pinned = useRef(true);
	useLayoutEffect(() => {
		const el = scroller.current;
		if (el && pinned.current) el.scrollTop = el.scrollHeight;
	});
	const visible = (transcript?.items ?? []).filter((item) => item.kind !== "tool");
	return (
		<section class="conversation">
			<div
				class="messages"
				ref={scroller}
				onScroll={(e) => {
					const el = e.currentTarget;
					pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
				}}
			>
				{!transcript && <p class="muted pad">Connecting…</p>}
				{transcript && visible.length === 0 && !transcript.streaming && (
					<div class="empty-chat">
						<p>Tell the agent what to build. For example:</p>
						<ul>
							<li>
								<em>Add uppercaseString. Return an uppercased copy of the input.</em>
							</li>
							<li>
								<em>Keep a todo list: add, complete, list. Then make an app page for it.</em>
							</li>
						</ul>
					</div>
				)}
				{visible.map((item) => (
					<Message key={`${item.kind}-${item.id}`} item={item} outcome={outcome} />
				))}
				{transcript?.streaming && (
					<Message
						item={{ kind: "assistant", id: -1, at: Date.now(), ...transcript.streaming }}
						outcome={outcome}
						streaming
					/>
				)}
				{transcript?.retry && (
					<p class="notice warn">
						Retrying: {transcript.retry.error}
					</p>
				)}
				{transcript?.busy && !transcript.streaming && <p class="thinking muted">working…</p>}
			</div>
			<Composer id={props.id} busy={transcript?.busy ?? false} queued={transcript?.queued ?? 0} loggedIn={props.loggedIn} onLogin={props.onLogin} />
		</section>
	);
}

function Message(props: { item: TranscriptItem; outcome: (call: ToolCallItem) => ToolOutcome; streaming?: boolean }) {
	const item = props.item;
	if (item.kind === "user") return <div class="msg user">{item.text}</div>;
	if (item.kind === "notice") return <p class="notice">{item.text}</p>;
	if (item.kind !== "assistant") return null;
	return (
		<div class={`msg assistant${props.streaming ? " streaming" : ""}`}>
			{item.thinking && (
				<details class="thinking-block">
					<summary>thinking</summary>
					<pre>{item.thinking}</pre>
				</details>
			)}
			{item.text && <Markdown text={item.text} />}
			{item.toolCalls.map((call) => (
				<ToolCallCard key={call.id} call={call} outcome={props.outcome(call)} />
			))}
			{item.error && <p class="error">The model request failed: {item.error}</p>}
		</div>
	);
}

/** Rendered once per text: the transcript is re-sent on every update, but a settled message's text does not change. */
function Markdown(props: { text: string }) {
	const html = useMemo(() => markdown(props.text), [props.text]);
	return <div class="md" dangerouslySetInnerHTML={{ __html: html }} />;
}

function Composer(props: { id: string; busy: boolean; queued: number; loggedIn: boolean; onLogin: () => void }) {
	const [text, setText] = useState("");
	const [error, setError] = useState("");
	const input = useRef<HTMLTextAreaElement>(null);
	useEffect(() => {
		if (matchMedia("(min-width: 861px)").matches) input.current?.focus();
	}, [props.id]);
	useLayoutEffect(() => {
		const el = input.current;
		if (!el) return;
		el.style.height = "auto";
		el.style.height = `${el.scrollHeight + 2}px`;
	}, [text]);
	const send = async () => {
		const content = text.trim();
		if (!content) return;
		setError("");
		setText("");
		try {
			await api.send(props.id, content);
		} catch (e) {
			setText(content);
			setError((e as Error).message);
		}
	};
	return (
		<div class="composer">
			{!props.loggedIn && (
				<p class="notice warn">
					Connect Claude before talking to the agent.{" "}
					<button class="link small" onClick={props.onLogin}>
						Connect
					</button>
				</p>
			)}
			{error && <p class="error small">{error}</p>}
			<div class="compose-row">
			<textarea
				ref={input}
				rows={1}
				placeholder={props.busy ? "Queued as a follow-up while the agent works" : "Ask for a change…"}
				value={text}
				onInput={(e) => setText(e.currentTarget.value)}
				onKeyDown={(e) => {
					if (e.key === "Enter" && !e.shiftKey && !e.isComposing && !matchMedia("(pointer: coarse)").matches) {
						e.preventDefault();
						void send();
					}
				}}
			/>
				{props.queued > 0 && <span class="muted small">{props.queued} queued</span>}
				{props.busy && (
					<button class="danger" onClick={() => void api.abort(props.id)}>
						Stop
					</button>
				)}
				<button class="primary" disabled={!text.trim()} onClick={() => void send()}>
					Send
				</button>
			</div>
			<div class="row end compose-meta wide-only">
				<span class="muted small">Enter to send, Shift+Enter for a new line</span>
				<button class="link small" title="Start a new context; the world is kept" onClick={() => void api.reset(props.id)}>
					New conversation
				</button>
			</div>
		</div>
	);
}
