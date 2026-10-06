import { useEffect, useState } from "preact/hooks";
import type { AccountStatus, WorldListing } from "../../src/api/types.ts";
import { api } from "../api.ts";
import { useRoute } from "../route.ts";
import { Sidebar } from "./sidebar.tsx";
import { WorldView } from "./world-view.tsx";
import { Welcome } from "./welcome.tsx";
import { LoginDialog } from "./login-dialog.tsx";

export function App() {
	const { worldId } = useRoute();
	const [worlds, setWorlds] = useState<WorldListing[]>([]);
	const [account, setAccount] = useState<AccountStatus | undefined>();
	const [loggingIn, setLoggingIn] = useState(false);
	const openLogin = () => setLoggingIn(true);
	const refreshWorlds = () => void api.worlds().then(setWorlds);
	const refreshAccount = () => void api.account().then(setAccount);
	useEffect(() => {
		refreshWorlds();
		refreshAccount();
	}, []);
	return (
		<div class="shell">
			<Sidebar worlds={worlds} current={worldId} account={account} onWorlds={refreshWorlds} onAccount={setAccount} onLogin={openLogin} />
			<main class="main">
				{worldId ? <WorldView key={worldId} id={worldId} loggedIn={account?.state !== "none"} onLogin={openLogin} /> : <Welcome account={account} hasWorlds={worlds.length > 0} onLogin={openLogin} />}
			</main>
			{loggingIn && <LoginDialog onClose={() => setLoggingIn(false)} onChange={setAccount} />}
		</div>
	);
}
