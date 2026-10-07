import { useEffect, useState } from "preact/hooks";
import type { AccountStatus, WorldListing } from "../../src/api/types.ts";
import { api } from "../api.ts";
import { useRoute } from "../route.ts";
import { Sidebar } from "./sidebar.tsx";
import { WorldView } from "./world-view.tsx";
import { Welcome } from "./welcome.tsx";
import { LoginDialog } from "./login-dialog.tsx";

/** Opens the worlds drawer; shown on phones only. */
export function MenuButton(props: { onClick: () => void }) {
	return (
		<button class="menu-button" aria-label="Worlds and account" onClick={props.onClick}>
			☰
		</button>
	);
}

export function App() {
	const { worldId } = useRoute();
	const [worlds, setWorlds] = useState<WorldListing[]>([]);
	const [account, setAccount] = useState<AccountStatus | undefined>();
	const [loggingIn, setLoggingIn] = useState(false);
	const [drawer, setDrawer] = useState(false);
	const openMenu = () => setDrawer(true);
	useEffect(() => setDrawer(false), [worldId]);
	useEffect(() => {
		if (!drawer) return;
		const onKey = (event: KeyboardEvent) => event.key === "Escape" && setDrawer(false);
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [drawer]);
	const openLogin = () => setLoggingIn(true);
	const refreshWorlds = () => void api.worlds().then(setWorlds);
	const refreshAccount = () => void api.account().then(setAccount);
	useEffect(() => {
		refreshWorlds();
		refreshAccount();
	}, []);
	return (
		<div class={`shell${drawer ? " drawer-open" : ""}`}>
			<Sidebar worlds={worlds} current={worldId} account={account} onWorlds={refreshWorlds} onAccount={setAccount} onLogin={openLogin} />
			<div class="scrim" onClick={() => setDrawer(false)} />
			<main class="main">
				{worldId ? (
					<WorldView key={worldId} id={worldId} loggedIn={account?.state !== "none"} onLogin={openLogin} onMenu={openMenu} />
				) : (
					<>
						<header class="phone-bar">
							<MenuButton onClick={openMenu} />
							<span class="brand-mark">π</span>
							<strong>pi-world</strong>
						</header>
						<Welcome account={account} hasWorlds={worlds.length > 0} onLogin={openLogin} />
					</>
				)}
			</main>
			{loggingIn && <LoginDialog onClose={() => setLoggingIn(false)} onChange={setAccount} />}
		</div>
	);
}
