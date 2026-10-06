import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AgentDoc, type AgentState } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { DurableObject } from "cloudflare:workers";
import wasm from "quickjs-wasi/quickjs.wasm";
import { DEFAULT_MODEL, type Transcript, type WorldSummary } from "../api/types.ts";
import { toTranscript } from "../conversation/transcript.ts";
import { ACCOUNT_NAME, type Env } from "../env.ts";
import { appPage, hasApp } from "./app-page.ts";
import { claudeModels } from "./claude-models.ts";
import { Fanout } from "./fanout.ts";
import { openWorld } from "./open-world.ts";
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
		const { world, root } = opened;
		const view = await root.viewState(BACKGROUND_CONTEXT);
		const fanout = new Fanout();
		const summary = (): WorldSummary => {
			const catalogue = world.catalogue();
			const agent = view.value.docs[AgentDoc.definition.kind] as AgentState | undefined;
			return {
				id: meta.id,
				name: meta.name,
				revision: world.head().revision,
				functions: catalogue,
				checks: world.checks().checks,
				hasApp: hasApp(catalogue),
				model: agent?.model?.modelId ?? DEFAULT_MODEL,
			};
		};
		const transcript = (): Transcript => toTranscript(view.value);
		view.subscribe(async () => {
			fanout.publish("transcript", () => ({ type: "transcript", transcript: transcript() }));
			fanout.publish("world", () => ({ type: "world", world: summary() }));
		});
		world.subscribe(() => fanout.publish("world", () => ({ type: "world", world: summary() })));
		return {
			opened,
			data,
			fanout,
			transcript,
			summary,
			setModel: (modelId) => root.configure({ model: { provider: "anthropic", modelId } }, BACKGROUND_CONTEXT),
			armHeartbeat: () => this.ctx.storage.setAlarm(Date.now() + HEARTBEAT_MS),
			app: (path, query) => appPage(world, meta.id, path, query),
		};
	}
}
