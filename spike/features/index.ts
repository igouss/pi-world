// Spikes for the celld features pi-world does not use yet: hibernatable WebSockets, alarms as a scheduler,
// Queues, Workflows (sleep, waitForEvent), transactionSync, Dynamic Workers (CPU isolation) and HTMLRewriter.
import { DurableObject, WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";

declare const VERSION: string;

interface Env {
	PROBE: DurableObjectNamespace<Probe>;
	JOBS: Queue<{ id: number; sentAt: number; fail?: boolean }>;
	PAUSE: Workflow;
	LOADER: { get(id: string, code: () => unknown): { getEntrypoint(): Fetcher } };
}

/** CPU work by iteration count: the clock stands still during JavaScript execution. */
const spin = (n: number): number => {
	let x = 0;
	for (let i = 0; i < n; i++) x = (x + i * 7) % 1000003;
	return x;
};

export class Probe extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS log (at INTEGER, what TEXT)");
		ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS jobs (name TEXT PRIMARY KEY, due INTEGER)");
		ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS rows (n INTEGER)");
		this.log(`constructed v${VERSION}`);
	}

	private log(what: string): void {
		this.ctx.storage.sql.exec("INSERT INTO log VALUES (?, ?)", Date.now(), what);
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const q = (k: string) => url.searchParams.get(k);
		switch (url.pathname) {
			case "/version":
				return Response.json({ version: VERSION });
			case "/log":
				return Response.json(this.ctx.storage.sql.exec("SELECT at, what FROM log ORDER BY rowid").toArray());
			case "/ws-hib": {
				const pair = new WebSocketPair();
				this.ctx.acceptWebSocket(pair[1]);
				return new Response(null, { status: 101, webSocket: pair[0] });
			}
			case "/ws-regular": {
				const pair = new WebSocketPair();
				const server = pair[1];
				server.accept();
				server.addEventListener("message", (event) => server.send(`regular:${event.data}:v${VERSION}`));
				return new Response(null, { status: 101, webSocket: pair[0] });
			}
			case "/schedule": {
				// ?jobs=name:ms,name:ms schedules each job ms from now; one alarm at the earliest due job.
				for (const spec of (q("jobs") ?? "").split(",").filter(Boolean)) {
					const [name, ms] = spec.split(":");
					this.ctx.storage.sql.exec("INSERT OR REPLACE INTO jobs VALUES (?, ?)", name!, Date.now() + Number(ms));
				}
				await this.arm();
				return Response.json({ armed: await this.ctx.storage.getAlarm() });
			}
			case "/tx": {
				const before = this.count();
				try {
					this.ctx.storage.transactionSync(() => {
						this.ctx.storage.sql.exec("INSERT INTO rows VALUES (1)");
						this.ctx.storage.sql.exec("INSERT INTO rows VALUES (2)");
						if (q("fail")) throw new Error("fail halfway");
					});
				} catch (error) {
					return Response.json({ before, after: this.count(), threw: String(error) });
				}
				return Response.json({ before, after: this.count() });
			}
			case "/cpu":
				return Response.json({ x: spin(Number(q("n"))) });
			case "/cheap":
				return Response.json({ ok: true });
			default:
				return new Response("probe", { status: 404 });
		}
	}

	async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
		const constructed = this.ctx.storage.sql.exec("SELECT count(*) AS n FROM log WHERE what LIKE 'constructed%'").one().n;
		ws.send(`hib:${String(message)}:v${VERSION}:constructed=${constructed}`);
	}

	async alarm(): Promise<void> {
		const now = Date.now();
		for (const job of this.ctx.storage.sql.exec<{ name: string; due: number }>("SELECT name, due FROM jobs WHERE due <= ?", now).toArray()) {
			this.log(`fired ${job.name} late=${now - job.due}ms`);
			this.ctx.storage.sql.exec("DELETE FROM jobs WHERE name = ?", job.name);
		}
		await this.arm();
	}

	/** One alarm per cell, so a scheduler arms it at the earliest due job. */
	private async arm(): Promise<void> {
		const next = this.ctx.storage.sql.exec<{ due: number | null }>("SELECT min(due) AS due FROM jobs").one().due;
		if (next !== null) await this.ctx.storage.setAlarm(next);
		else await this.ctx.storage.deleteAlarm();
	}

	async receive(id: number, attempts: number, sentAt: number): Promise<void> {
		this.log(`queue id=${id} attempts=${attempts} latency=${Date.now() - sentAt}ms`);
	}

	private count(): number {
		return Number(this.ctx.storage.sql.exec("SELECT count(*) AS n FROM rows").one().n);
	}
}

/** A pause as a Workflow: a step, a sleep, a wait for an answer, a final step. */
export class Pause extends WorkflowEntrypoint<Env, { question: string }> {
	async run(event: WorkflowEvent<{ question: string }>, step: WorkflowStep) {
		const asked = await step.do("ask", async () => ({ at: Date.now(), question: event.payload.question }));
		await step.sleep("nap", "3 seconds");
		const answer = await step.waitForEvent<{ choice: string }>("answer", { type: "answer", timeout: "1 hour" });
		return step.do("finish", async () => ({ question: asked.question, choice: answer.payload.choice, waitedMs: Date.now() - asked.at }));
	}
}

const LOADED_CPU = `export default { async fetch(request) {
	const n = Number(new URL(request.url).searchParams.get("n"));
	let x = 0; for (let i = 0; i < n; i++) x = (x + i * 7) % 1000003;
	return new Response(String(x));
} };`;

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		const [, head, name = "default"] = url.pathname.split("/");
		const q = (k: string) => url.searchParams.get(k);
		switch (head) {
			case "cell": {
				// /cell/<name>/<path> goes to the probe cell <name>.
				const rest = "/" + url.pathname.split("/").slice(3).join("/");
				return env.PROBE.getByName(name).fetch(new Request(new URL(rest + url.search, url), request));
			}
			case "enqueue": {
				const n = Number(q("n") ?? 1);
				const started = Date.now();
				const timings: number[] = [];
				for (let id = 0; id < n; id++) {
					const t = Date.now();
					await env.JOBS.send({ id, sentAt: Date.now(), ...(id === 0 && q("fail") ? { fail: true } : {}) });
					timings.push(Date.now() - t);
				}
				return Response.json({ sent: n, totalMs: Date.now() - started, perSendMs: timings });
			}
			case "wf": {
				if (name === "create") {
					const instance = await env.PAUSE.create({ params: { question: q("question") ?? "merge duplicates?" } });
					return Response.json({ id: instance.id });
				}
				const instance = await env.PAUSE.get(q("id")!);
				if (name === "answer") {
					await instance.sendEvent({ type: "answer", payload: { choice: q("choice") ?? "merge" } });
					return Response.json({ sent: true });
				}
				return Response.json(await instance.status());
			}
			case "dyn": {
				const worker = env.LOADER.get("cpu-v1", () => ({ compatibilityDate: "2026-01-01", mainModule: "w.js", modules: { "w.js": LOADED_CPU } }));
				const started = Date.now();
				const text = await (await worker.getEntrypoint().fetch(new Request(`http://loaded/?n=${q("n")}`))).text();
				return Response.json({ x: text, ms: Date.now() - started });
			}
			case "html": {
				const page = q("page") ?? "<html><head><title>t</title></head><body>hi</body></html>";
				const rewritten = new HTMLRewriter()
					.on("head", { element: (head) => head.prepend("<script>window.world={}</script>", { html: true }) })
					.transform(new Response(page, { headers: { "content-type": "text/html" } }));
				return new Response(await rewritten.text());
			}
			default:
				return new Response("features spike", { status: 404 });
		}
	},

	async queue(batch: MessageBatch<{ id: number; sentAt: number; fail?: boolean }>, env: Env): Promise<void> {
		const sink = env.PROBE.getByName("queue-sink");
		for (const message of batch.messages) {
			await sink.receive(message.body.id, message.attempts, message.body.sentAt);
			if (message.body.fail && message.attempts === 1) message.retry();
			else message.ack();
		}
	},
} satisfies ExportedHandler<Env, { id: number; sentAt: number; fail?: boolean }>;
