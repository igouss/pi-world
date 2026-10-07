import { useEffect, useRef, useState } from "preact/hooks";
import { appPath } from "../../src/api/paths.ts";
import { MODELS, type WorldSummary } from "../../src/api/types.ts";
import { api } from "../api.ts";
import { useLiveWorld } from "../live.ts";
import { MenuButton } from "./app.tsx";
import { Conversation } from "./conversation.tsx";
import { Inspector } from "./inspector.tsx";

/**
 * A world: its header, the conversation and the inspector. On a phone the header is one row, the panes switch, and
 * the model, the app link and a new conversation sit behind the ⋯ menu.
 */
export function WorldView(props: { id: string; loggedIn: boolean; onLogin: () => void; onMenu: () => void }) {
	const live = useLiveWorld(props.id);
	const [pane, setPane] = useState<"chat" | "inspect">("chat");
	const [more, setMore] = useState(false);
	const menu = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (!more) return;
		const close = (event: Event) => {
			if (!menu.current?.contains(event.target as Node)) setMore(false);
		};
		document.addEventListener("pointerdown", close);
		return () => document.removeEventListener("pointerdown", close);
	}, [more]);
	const world = live.world;
	return (
		<div class="world">
			<header class="world-head">
				<MenuButton onClick={props.onMenu} />
				<div class="title">
					<h2>{world?.name ?? props.id}</h2>
					<span class="badge" title="Head revision">
						rev {world?.revision ?? "…"}
					</span>
					<span class={`dot ${live.connected ? "on" : "off"}`} title={live.connected ? "Live" : "Reconnecting"} />
				</div>
				<div class="tools" ref={menu}>
					<div class="wide-only">
						<WorldActions id={props.id} world={world} />
					</div>
					<div class="pane-switch">
						<button class={pane === "chat" ? "on" : ""} onClick={() => setPane("chat")}>
							Chat
						</button>
						<button class={pane === "inspect" ? "on" : ""} onClick={() => setPane("inspect")}>
							Inspect
						</button>
					</div>
					<button class="more-button" aria-label="More" aria-expanded={more} onClick={() => setMore(!more)}>
						⋯
					</button>
					{more && (
						<div class="more-menu">
							<WorldActions id={props.id} world={world} onReset={() => setMore(false)} />
						</div>
					)}
				</div>
			</header>
			<div class={`world-body show-${pane}`}>
				<Conversation id={props.id} transcript={live.transcript} loggedIn={props.loggedIn} onLogin={props.onLogin} />
				<Inspector id={props.id} world={world} />
			</div>
		</div>
	);
}

/** The model, the world's page, and, in the phone menu, a new conversation. */
function WorldActions(props: { id: string; world?: WorldSummary; onReset?: () => void }) {
	return (
		<div class="world-actions">
			{props.world?.hasApp && (
				<a class="button" href={appPath(props.id)} target="_blank" rel="noopener">
					Open app ↗
				</a>
			)}
			<select value={props.world?.model} title="Model" onChange={(e) => void api.setModel(props.id, e.currentTarget.value)}>
				{MODELS.map((model) => (
					<option key={model} value={model}>
						{model}
					</option>
				))}
			</select>
			{props.onReset && (
				<button
					onClick={() => {
						void api.reset(props.id);
						props.onReset?.();
					}}
				>
					New conversation
				</button>
			)}
		</div>
	);
}
