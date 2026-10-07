import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AgentDoc, type AgentState } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { DurableObject } from "cloudflare:workers";
import wasm from "quickjs-wasi/quickjs.wasm";
import { DEFAULT_MODEL, type Transcript, type WorldSummary } from "../api/types.ts";
import { build } from "../build.ts";
import { toTranscript } from "../conversation/transcript.ts";
import { ACCOUNT_NAME, type Env } from "../env.ts";
import type { DataRecord } from "../isolate/host-api.ts";
import { FacetCallRunner } from "../isolate/facet-call-runner.ts";
import { runtimeFacet } from "../isolate/runtime-loader.ts";
import type { CatalogueEntry, Outcome } from "../world/world-vm.ts";
import { appPage, hasApp } from "./app-page.ts";
import { claudeModels } from "./claude-models.ts";
import { Fanout } from "./fanout.ts";
import { openWorld } from "./open-world.ts";
import { TieredBlobStore } from "../revision/tiered-blob-store.ts";
import { Mutex } from "../world/mutex.ts";
import { r2Archive } from "./r2-archive.ts";
import { sqlBlobStore } from "./sql-blob-store.ts";
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

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		// Keep-alive pings are answered by celld without waking a hibernated cell.
		ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
	}

	/** A socket message that the auto-response did not answer: the UI sends nothing else, so it is ignored. */
	async webSocketMessage(): Promise<void> {}

	/** Codes 1005, 1006 and 1015 report what happened and must not be sent back. */
	async webSocketClose(socket: WebSocket, code: number): Promise<void> {
		socket.close([1005, 1006, 1015].includes(code) ? 1000 : code);
	}

	async init(id: string, name: string): Promise<void> {
		await this.ctx.storage.put("meta", { id, name } satisfies Meta);
		await this.live();
	}

	/** A call from another world; `chain` lists the worlds it passed through, the caller last. */
	async peerCall(name: string, args: unknown[], chain: string[]): Promise<Outcome> {
		if (!(await this.meta())) return { ok: false, failure: "threw", error: "no such world" };
		return (await this.live()).opened.world.call(name, args, chain);
	}

	async peerFunctions(): Promise<readonly CatalogueEntry[]> {
		if (!(await this.meta())) throw new Error("no such world");
		return (await this.live()).opened.world.catalogue();
	}

	/** The capability this world's runtime isolate calls back through. */
	private hostFor(worldId: string): unknown {
		const exports = this.ctx.exports as unknown as { WorldHost(options: { props: { worldId: string } }): unknown };
		return exports.WorldHost({ props: { worldId } });
	}

	/** A snapshot blob for this world's runtime isolate. */
	async blobBytes(hash: string): Promise<Uint8Array> {
		return (await this.live()).opened.world.blobBytes(hash);
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

	/**
	 * Data written before calls ran in the world's own isolate lives in this cell's `world_data` table; the runtime
	 * takes it over once. The table is left in place.
	 */
	private async moveDataToRuntime(facet: { importData(records: DataRecord[]): Promise<number> | number }): Promise<void> {
		if (await this.ctx.storage.get<boolean>("dataMovedToRuntime")) return;
		const table = this.ctx.storage.sql.exec<{ n: number }>("SELECT count(*) AS n FROM sqlite_master WHERE name = 'world_data'").one().n;
		const records = table ? this.ctx.storage.sql.exec<{ key: string; value: string }>("SELECT key, value FROM world_data").toArray() : [];
		await facet.importData(records.map(({ key, value }) => ({ key, json: value })));
		await this.ctx.storage.put("dataMovedToRuntime", true);
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
		const account = this.env.ACCOUNT.getByName(ACCOUNT_NAME);
		const facet = () => runtimeFacet(this.env.LOADER, this.ctx.facets as never, meta.id, this.hostFor(meta.id));
		await this.moveDataToRuntime(facet());
		const blobs = new TieredBlobStore(await sqlBlobStore(db), r2Archive(this.env.SNAPSHOTS));
		const opened = await openWorld({
			storage: await SqliteStorage.open(db),
			blobs,
			calls: new FacetCallRunner(meta.id, facet),
			wasm,
			models: claudeModels(() => account.accessToken()),
			model: { provider: "anthropic", modelId: DEFAULT_MODEL },
			settings: { progress: { partialIntervalMs: PROGRESS_MS, outputIntervalMs: PROGRESS_MS } },
		});
		const { world, root } = opened;
		const view = await root.viewState(BACKGROUND_CONTEXT);
		const fanout = new Fanout(() => this.ctx.getWebSockets());
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
				build,
			};
		};
		const transcript = (): Transcript => toTranscript(view.value);
		view.subscribe(async () => {
			fanout.publish("transcript", () => ({ type: "transcript", transcript: transcript() }));
			fanout.publish("world", () => ({ type: "world", world: summary() }));
		});
		world.subscribe(() => fanout.publish("world", () => ({ type: "world", world: summary() })));
		const archiving = new Mutex();
		const archive = () =>
			void archiving
				.run(() => blobs.archiveAllBut(world.head().blob))
				.catch((error: unknown) => console.warn(`archiving snapshots of ${meta.id} failed; the next revision retries`, error));
		world.subscribe(archive);
		archive();
		// Sockets that outlived a hibernation or a deploy get the current state from this version of the code.
		fanout.publish("world", () => ({ type: "world", world: summary() }));
		fanout.publish("transcript", () => ({ type: "transcript", transcript: transcript() }));
		return {
			opened,
			fanout,
			transcript,
			summary,
			setModel: (modelId) => root.configure({ model: { provider: "anthropic", modelId } }, BACKGROUND_CONTEXT),
			accept: (socket) => this.ctx.acceptWebSocket(socket),
			armHeartbeat: () => this.ctx.storage.setAlarm(Date.now() + HEARTBEAT_MS),
			app: (path, query) => appPage(world, meta.id, path, query),
		};
	}
}
