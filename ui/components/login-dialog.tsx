import { useEffect, useRef, useState } from "preact/hooks";
import type { AccountStatus } from "../../src/api/types.ts";
import { api } from "../api.ts";
import { useAction } from "../use-action.ts";

type Method = "oauth" | "token";

const TOKEN_PREFIX: string = "sk-ant-";

/**
 * Connect the fleet to a Claude subscription: the copy-code OAuth login, or a token from `claude setup-token`.
 * The login URL is fetched when the dialog opens and shown as a link, so opening it is a direct tap; a pop-up opened
 * after a request is blocked by mobile browsers.
 */
export function LoginDialog(props: { onClose: () => void; onChange: (status: AccountStatus) => void }) {
	const [method, setMethod] = useState<Method>("oauth");
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => event.key === "Escape" && props.onClose();
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);
	const done = (status: AccountStatus) => {
		props.onChange(status);
		props.onClose();
	};
	return (
		<div class="overlay" onClick={(e) => e.target === e.currentTarget && props.onClose()}>
			<div class="dialog" role="dialog" aria-modal="true" aria-labelledby="login-title">
				<header class="dialog-head">
					<h3 id="login-title">Connect Claude</h3>
					<button class="link close" aria-label="Close" onClick={props.onClose}>
						✕
					</button>
				</header>
				<p class="muted small">The agent runs on your Claude Pro or Max subscription. Every world on this server uses this one login.</p>
				<div class="segmented" role="tablist">
					<button role="tab" aria-selected={method === "oauth"} class={method === "oauth" ? "on" : ""} onClick={() => setMethod("oauth")}>
						Log in with Claude
					</button>
					<button role="tab" aria-selected={method === "token"} class={method === "token" ? "on" : ""} onClick={() => setMethod("token")}>
						Paste a token
					</button>
				</div>
				{method === "oauth" ? <OAuthLogin onDone={done} /> : <TokenLogin onDone={done} />}
			</div>
		</div>
	);
}

function OAuthLogin(props: { onDone: (status: AccountStatus) => void }) {
	const [url, setUrl] = useState<string | undefined>();
	const [code, setCode] = useState("");
	const start = useAction();
	const finish = useAction();
	useEffect(() => void start.run(async () => setUrl((await api.startLogin()).url))(), []);
	const submit = finish.run(async () => props.onDone(await api.finishLogin(code)));
	return (
		<form class="steps-form" onSubmit={submit}>
			<Step n={1} title="Approve on claude.ai">
				{url ? (
					<a class="button primary wide" href={url} target="_blank" rel="noopener">
						Open claude.ai ↗
					</a>
				) : (
					<button type="button" class="wide" disabled>
						{start.error ? "Could not start" : "Preparing…"}
					</button>
				)}
				{start.error && <p class="error small">{start.error}</p>}
			</Step>
			<Step n={2} title="Paste the code Anthropic shows">
				<input
					class="mono"
					placeholder="code#state"
					autocomplete="off"
					autocapitalize="off"
					spellcheck={false}
					value={code}
					onInput={(e) => setCode(e.currentTarget.value)}
				/>
			</Step>
			{finish.error && <p class="error">{finish.error}</p>}
			<button class="primary wide" disabled={!code.trim() || finish.busy}>
				{finish.busy ? "Connecting…" : "Connect"}
			</button>
		</form>
	);
}

function TokenLogin(props: { onDone: (status: AccountStatus) => void }) {
	const [token, setToken] = useState("");
	const [shown, setShown] = useState(false);
	const input = useRef<HTMLInputElement>(null);
	const save = useAction();
	useEffect(() => input.current?.focus(), []);
	const trimmed = token.trim();
	const malformed = trimmed.length > 0 && !trimmed.startsWith(TOKEN_PREFIX);
	const submit = save.run(async () => props.onDone(await api.setToken(trimmed)));
	const field = {
		ref: input,
		class: "mono",
		placeholder: `${TOKEN_PREFIX}oat01-…`,
		autocomplete: "off",
		autocapitalize: "off" as const,
		spellcheck: false,
		value: token,
		onInput: (e: Event) => setToken((e.currentTarget as HTMLInputElement).value),
	};
	return (
		<form class="steps-form" onSubmit={submit}>
			<Step n={1} title="On a computer with Claude Code, run">
				<CopyLine text="claude setup-token" />
				<p class="muted small">It prints a long-lived token that starts with {TOKEN_PREFIX}.</p>
			</Step>
			<Step n={2} title="Paste the token">
				<div class="secret">
					{shown ? <input type="text" {...field} /> : <input type="password" {...field} />}
					<button type="button" class="link small" onClick={() => setShown(!shown)}>
						{shown ? "Hide" : "Show"}
					</button>
				</div>
				{malformed && <p class="error small">A Claude token starts with {TOKEN_PREFIX}.</p>}
			</Step>
			{save.error && <p class="error">{save.error}</p>}
			<button class="primary wide" disabled={!trimmed || malformed || save.busy}>
				{save.busy ? "Checking with Anthropic…" : "Save token"}
			</button>
		</form>
	);
}

function Step(props: { n: number; title: string; children: preact.ComponentChildren }) {
	return (
		<section class="step">
			<span class="step-n">{props.n}</span>
			<div class="step-body">
				<h4>{props.title}</h4>
				{props.children}
			</div>
		</section>
	);
}

/** A command with a copy button where the clipboard is available; over plain HTTP it is not, and the text selects on tap. */
function CopyLine(props: { text: string }) {
	const [copied, setCopied] = useState(false);
	const canCopy = typeof navigator !== "undefined" && navigator.clipboard !== undefined;
	return (
		<div class="copy-line">
			<code onClick={(e) => getSelection()?.selectAllChildren(e.currentTarget)}>{props.text}</code>
			{canCopy && (
				<button
					type="button"
					class="link small"
					onClick={() =>
						void navigator.clipboard.writeText(props.text).then(() => {
							setCopied(true);
							setTimeout(() => setCopied(false), 1500);
						})
					}
				>
					{copied ? "Copied" : "Copy"}
				</button>
			)}
		</div>
	);
}
