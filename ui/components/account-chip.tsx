import type { AccountStatus } from "../../src/api/types.ts";
import { api } from "../api.ts";
import { useAction } from "../use-action.ts";

const LABELS: Record<AccountStatus["state"], string> = { none: "Claude: not connected", oauth: "Claude: subscription", token: "Claude: token" };

/** The login state in the sidebar; logging in happens in the login dialog. */
export function AccountChip(props: { status?: AccountStatus; onLogin: () => void; onChange: (status: AccountStatus) => void }) {
	const { error, run } = useAction();
	const state = props.status?.state ?? "none";
	const logout = run(async () => {
		await api.logout();
		props.onChange(await api.account());
	});
	return (
		<div class="account">
			<div class="account-head">
				<span class={`dot ${state === "none" ? "off" : "on"}`} />
				<span>{LABELS[state]}</span>
				{state === "none" ? (
					<button class="primary small-button" onClick={props.onLogin}>
						Connect
					</button>
				) : (
					<button class="link small" onClick={logout}>
						log out
					</button>
				)}
			</div>
			{error && <p class="error small">{error}</p>}
		</div>
	);
}
