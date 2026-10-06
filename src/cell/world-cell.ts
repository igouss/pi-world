import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationView } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { DurableObject } from "cloudflare:workers";
import wasm from "quickjs-wasi/quickjs.wasm";
import { DEFAULT_MODEL, type Transcript, type WorldSummary } from "../api/types.ts";
import { toTranscript } from "../conversation/transcript.ts";
import { ACCOUNT_NAME, type Env } from "../env.ts";
import type { DataPort } from "../world/data-port.ts";
import { appPage } from "./app-page.ts";
import { claudeModels } from "./claude-models.ts";
import { Fanout } from "./fanout.ts";
import { openWorld, type OpenedWorld } from "./open-world.ts";
import { sqlBlobStore } from "./sql-blob-store.ts";
import { sqlDataPort } from "./sql-data-port.ts";
import { cellDatabase } from "./sqlite-database.ts";
import { routeWorld, type WorldRuntime } from "./world-routes.ts";

interface Meta {
	readonly id: string;
	readonly name: string;
}

/** While a run is going, the cell wakes itself at this interval so an evicted cell resumes the run. */
const HEARTBEAT_MS: number = 30_000;

/** Progress commits each wait for the bucket on a single node, so they are spaced out. */
const PROGRESS_MS: number = 400;

/**
 * One world's cell: its storage, its VM, its agent and its sockets. Opened lazily at the first event after a wake;
 * opening resumes any run the previous owner left unfinished.
 */
export class WorldCell extends DurableObject<Env> {
	private runtime: Promise<WorldRuntime> | undefined;

	async init(id: string, name: string): Promise<void> {
		await this.ctx.storage.put("meta", { id, name } satisfies Meta);
		await this.live();
	}

	async fetch(request: Request): Promise<Response> {
		const meta = await this.meta();
		if (!meta) return Response.json({ error: "no such world" }, { status: 404 });
		return routeWorld(request, await this.live());
	}

	async alarm(): Promise<void> {
		if (!(await this.meta())) return;
		const runtime = await this.live();
		if (runtime.transcript().busy) await this.ctx.storage.setAlarm(Date.now() + HEARTBEAT_MS);
	}

	private async meta(): Promise<Meta | undefined> {
		return this.ctx.storage.get<Meta>("meta");
	}

	private live(): Promise<WorldRuntime> {
		this.runtime ??= this.open().catch((error: unknown) => {
			this.runtime = undefined;
			throw error;
		});
		return this.runtime;
	}

	private async open(): Promise<WorldRuntime> {
		const meta = await this.meta();
		if (!meta) throw new Error("the world was not initialised");
		const db = cellDatabase(this.ctx.storage);
		const data = sqlDataPort(this.ctx.storage.sql);
		const account = this.env.ACCOUNT.getByName(ACCOUNT_NAME);
		const opened = await openWorld({
			storage: await SqliteStorage.open(db),
			blobs: await sqlBlobStore(db),
			data,
			wasm,
			models: claudeModels(() => account.accessToken()),
			model: { provider: "anthropic", modelId: DEFAULT_MODEL },
			settings: { progress: { partialIntervalMs: PROGRESS_MS, outputIntervalMs: PROGRESS_MS } },
		});
		const view = await opened.root.viewState(BACKGROUND_CONTEXT);
		return this.runtimeFor(meta, opened, view.value, (listener) => view.subscribe(async (value) => listener(value)), data);
	}

	private runtimeFor(
		meta: Meta,
		opened: OpenedWorld,
		initial: ConversationView,
		subscribe: (listener: (view: ConversationView) => void) => () => void,
		data: DataPort,
	): WorldRuntime {
		const fanout = new Fanout();
		let view = initial;
		let model = DEFAULT_MODEL;
		const transcript = (): Transcript => toTranscript(view);
		const summary = async (): Promise<WorldSummary> => {
			const catalogue = opened.world.catalogue();
			return {
				id: meta.id,
				name: meta.name,
				revision: opened.world.head().revision,
				functions: catalogue,
				checks: (await opened.world.checks()).checks,
				hasApp: catalogue.some((entry) => entry.name === "app"),
				model,
			};
		};
		let latestSummary: WorldSummary | undefined;
		const refreshSummary = () =>
			void summary().then((value) => {
				latestSummary = value;
				fanout.publish("world", () => ({ type: "world", world: value }));
			});
		subscribe((next) => {
			view = next;
			fanout.publish("transcript", () => ({ type: "transcript", transcript: transcript() }));
		});
		opened.world.subscribe(refreshSummary);
		void opened.root.agent(BACKGROUND_CONTEXT).then((agent) => {
			model = agent.model?.modelId ?? DEFAULT_MODEL;
		});
		return {
			id: meta.id,
			opened,
			data,
			fanout,
			transcript,
			summary: async () => (latestSummary = await summary()),
			setModel: async (modelId) => {
				await opened.root.configure({ model: { provider: "anthropic", modelId } }, BACKGROUND_CONTEXT);
				model = modelId;
				refreshSummary();
			},
			armHeartbeat: () => this.ctx.storage.setAlarm(Date.now() + HEARTBEAT_MS),
			app: (path, query) => appPage(opened.world, meta.id, path, query),
		};
	}
}
