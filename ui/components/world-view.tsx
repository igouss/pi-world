import { useState } from "preact/hooks";
import { MODELS } from "../../src/api/types.ts";
import { api } from "../api.ts";
import { useLiveWorld } from "../live.ts";
import { Conversation } from "./conversation.tsx";
import { Inspector } from "./inspector.tsx";

export function WorldView(props: { id: string; loggedIn: boolean }) {
	const live = useLiveWorld(props.id);
	const [pane, setPane] = useState<"chat" | "inspect">("chat");
	const world = live.world;
	return (
		<div class="world">
			<header class="world-head">
				<div class="title">
					<h2>{world?.name ?? props.id}</h2>
					<span class="badge" title="Head revision">
						rev {world?.revision ?? "…"}
					</span>
					<span class={`dot ${live.connected ? "on" : "off"}`} title={live.connected ? "Live" : "Reconnecting"} />
				</div>
				<div class="tools">
					{world?.hasApp && (
						<a class="button" href={`/w/${props.id}/`} target="_blank" rel="noopener">
							Open app ↗
						</a>
					)}
					<select
						value={world?.model}
						title="Model"
						onChange={(e) => void api.setModel(props.id, e.currentTarget.value)}
					>
						{MODELS.map((model) => (
							<option key={model} value={model}>
								{model}
							</option>
						))}
					</select>
					<div class="pane-switch">
						<button class={pane === "chat" ? "on" : ""} onClick={() => setPane("chat")}>
							Chat
						</button>
						<button class={pane === "inspect" ? "on" : ""} onClick={() => setPane("inspect")}>
							Inspect
						</button>
					</div>
				</div>
			</header>
			<div class={`world-body show-${pane}`}>
				<Conversation id={props.id} transcript={live.transcript} loggedIn={props.loggedIn} />
				<Inspector id={props.id} world={world} />
			</div>
		</div>
	);
}
