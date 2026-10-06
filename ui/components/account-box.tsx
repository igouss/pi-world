import { useState } from "preact/hooks";
import type { AccountStatus } from "../../src/api/types.ts";
import { api } from "../api.ts";
import { useAction } from "../use-action.ts";

/** Claude subscription login: the copy-code OAuth flow, or a pasted `claude setup-token` token. */
export function AccountBox(props: { status?: AccountStatus; onChange: (status: AccountStatus) => void }) {
	const [url, setUrl] = useState<string | undefined>();
	const [code, setCode] = useState("");
	const [token, setToken] = useState("");
	const [mode, setMode] = useState<"idle" | "oauth" | "token">("idle");
	const { error, run: guard } = useAction();
	const start = guard(async () => {
		const { url } = await api.startLogin();
		setUrl(url);
		setMode("oauth");
		window.open(url, "_blank", "noopener");
	});
	const finish = guard(async () => {
		props.onChange(await api.finishLogin(code));
		setMode("idle");
		setCode("");
	});
	const paste = guard(async () => {
		props.onChange(await api.setToken(token));
		setMode("idle");
		setToken("");
	});
	const logout = guard(async () => {
		await api.logout();
		props.onChange(await api.account());
	});
	const state = props.status?.state ?? "none";
	return (
		<div class="account">
			<div class="account-head">
				<span class={`dot ${state === "none" ? "off" : "on"}`} />
				{state === "none" ? "Claude: not logged in" : state === "oauth" ? "Claude: subscription" : "Claude: token"}
				{state !== "none" && (
					<button class="link small" onClick={logout}>
						log out
					</button>
				)}
			</div>
			{state === "none" && mode === "idle" && (
				<div class="account-actions">
					<button class="primary" onClick={start}>
						Log in with Claude
					</button>
					<button class="link small" onClick={() => setMode("token")}>
						or paste a token
					</button>
				</div>
			)}
			{mode === "oauth" && (
				<form onSubmit={finish} class="stack">
					<p class="small">
						Approve in the tab that opened (<a href={url} target="_blank" rel="noopener">open it again</a>), then paste the code Anthropic shows.
					</p>
					<input placeholder="code#state" value={code} onInput={(e) => setCode(e.currentTarget.value)} />
					<div class="row">
						<button class="primary" disabled={!code.trim()}>
							Finish
						</button>
						<button type="button" class="link small" onClick={() => setMode("idle")}>
							cancel
						</button>
					</div>
				</form>
			)}
			{mode === "token" && (
				<form onSubmit={paste} class="stack">
					<p class="small">
						Run <code>claude setup-token</code> and paste the token it prints.
					</p>
					<input type="password" placeholder="sk-ant-oat01-…" value={token} onInput={(e) => setToken(e.currentTarget.value)} />
					<div class="row">
						<button class="primary" disabled={!token.trim()}>
							Save
						</button>
						<button type="button" class="link small" onClick={() => setMode("idle")}>
							cancel
						</button>
					</div>
				</form>
			)}
			{error && <p class="error small">{error}</p>}
		</div>
	);
}
