# pi-world: research

Written 2026-10-05 against pi commit `28dcce2ba` (pi-durable 1.0.4, quickjs-wasi 3.6.2) and celld v0.6.1 (beta).
`evaluation.md` reviews the intent against those sources; its findings are folded into `design.md` and
`decisions.md`.

## Premise already tested

Three spikes ran against quickjs-wasi 3.6.2 under Node 25.2.1. Nothing has run on celld yet.

- `spike/wasm-world.mjs` (`npm run spike`): checkpoint and restore undo a failed attempt; a paused async job survives
  snapshot, serialize, dispose and restore in a fresh instance; snapshot and restore each take a few milliseconds;
  an instruction budget stops runaway code and the VM stays usable afterwards.
- `spike/determinism.mjs` (`npm run spike:determinism`): with a fixed `wasi` clock and random, the same source on
  the same base gives byte-identical snapshots, and restore then snapshot is identical. Growth is linear, about
  1.5 KB per synthetic definition, so a raw snapshot passes 2 MB at about 410 definitions.
- `spike/registry.mjs` (`npm run spike:registry`): the prelude's registry, eager instance migration and state form
  behave as the constraints in `design.md` describe, including the one hole left, a running frame. With the built-ins
  frozen, a `develop` that reassigns `Array.prototype.every` has no effect in sloppy code and throws in strict
  code; a class can still define `toString`, and assigning `toString` on a plain object throws in strict code.

## Verified on celld, 2026-10-06

`spike/celld/probe.ts` and then the prototype ran under `celld dev` (x86-64) and on the fleet node `oracle-arm`
(aarch64, celld 0.6.1, one node, bucket `gs://pi-world-celld`).

- quickjs-wasi loads from a bundled `.wasm` import, creates a VM, snapshots it, and restores it from a 1.38 MB row
  in the cell's SQLite. A 1.44 MB snapshot row also round-trips (open check 2: no limit hit at this size).
- pi-durable runs over the cell's SQLite through an asynchronous facade (`src/cell/sqlite-database.ts`), and pi-ai's
  Anthropic provider answers through the owner's Claude subscription with an OAuth token (open check 3: settled).
  One answered input took about 1 s end to end on the node, with its durable commits.
- A full session ran on the node through the web UI: the agent defined seven functions over three revisions, enrolled a
  check, and the page it built added a todo that a direct call then read back.
- The copy-code OAuth login was completed by a person from a phone, and the agent then ran on that credential.
- **The OAuth refresh.** On 2026-10-07 the stored access token had expired two hours earlier; one agent message
  answered, and the stored expiry moved eight hours ahead, so the account cell refreshed the credential.
- **Worlds calling worlds.** On the node, the agent built a Currency world, then a Trip budget world that found it with
  `worlds.list()` and `worlds.functions(id)` and called its `convert` from `totals`. A direct call to `totals` answered
  in about 60 ms with the same value as calling `convert` directly, and Currency's error for an unknown currency
  reached the caller as a rejection.
- **Prelude upgrade.** Demo todos, built on prelude 1, opened on prelude 2 as revision 6 ("prelude 1 to 2"). The first
  deploy failed here: a restored heap already had the new host callback registered. `test/world-vm.test.ts` now
  upgrades a restored heap.
- **Direct calls need no model.** On a `celld dev` server with no Claude credential, `POST /call/tip` answered while an
  agent message in the same world failed with "not logged in". On the node, six calls to `stats()` took 62 to 71 ms
  each over the tailnet and left the conversation unchanged (31 items before and after). `test/agent.test.ts` asserts
  that a direct call makes no model request and adds no conversation entry.
- **A run survives a crash.** The celld service was restarted while a run was between tool rounds, in a world no
  browser had open, and nothing was sent to it afterwards. The world cell was active again 3 s after the node came up,
  the run continued from its last committed tool result, and it finished: one more `develop` accepted, no revision
  accepted twice. The same held in a second world. In both runs the cell came back before the heartbeat alarm was due,
  so what woke it (the alarm, or celld reactivating its cells at startup) is not established.

## Deployment target: celld

celld is "a self-hosted, distributed implementation of Cloudflare Durable Objects". Each world is one cell, a Durable
Object with its own SQLite database. The facts that shape the design, from celld's docs read 2026-10-05:

- **Single writer.** "Exactly one node serves a cell at a time." This matches pi-durable's rule that one process owns
  a storage.
- **Durable writes.** "celld does not answer a write until that write survives a failure". Region-local durable write
  latency is about 90 ms.
- **Output gates.** "A SQL write cursor must finish before a response, an outbound effect, or `storage.sync()`."
  The intent commit is therefore durable before a model call or tool effect leaves the cell, the order pi-durable's
  spec §5.2 relies on.
- **Eviction and moves.** "A cell keeps no in-memory state across an eviction", so the wake loop is still needed.
  Hibernatable WebSockets close when the cell moves, so the web UI must reconnect; a client that reconnects through
  `watch()` starts from the current view. A durable task resumes from its checkpoint on the new owner.
- **WebAssembly.** "A Worker bundle can import a `.wasm` file. The import gives the compiled module." Each module is
  compiled once per process.
- **Operations.** Storage on GCS buckets; `celld dev` uses local SQLite. celld doesn't terminate TLS, so an ingress
  proxy is needed. Peer traffic is plaintext HTTP, so nodes need a private network. "A fleet runs one application."

## Open checks on celld

These are undocumented or unknown. Measure them early, at milestone 6.

1. **Memory and CPU limits per cell.** The limitations page lists none, and balancing "does not measure the CPU or
   memory that one cell uses". Measure a realistic world cell.
2. **Blob size per row.** A 1.44 MB row works on the node; larger is untested. celld's docs state no row or blob
   limit, and a raw snapshot passes 2 MB at about 410 definitions. Measure, and chunk if needed.
3. **pi-ai and pi-durable under celld's runtime.** Settled: both run on the node (see above).
4. **Eviction timing and alarm retry limits.** Tune the heartbeat from measurements, not Cloudflare's numbers.
5. **Streaming lag.** Measure progress commits at about 90 ms per durable write.
6. **Calls between worlds across nodes** (for open decision 14). One node forwards every `peerCall` locally. On a fleet
   of two or more nodes, measure the latency of a forwarded call and what the caller sees when the callee's node dies
   mid-call. celld says a remote RPC "retries only when the failed peer attempt did not start the method".
7. **celld Queues as the durable path** (for open decision 14, option C). Documented: one writer per queue, at most 256
   concurrent producer calls, batches leased and retried, at-least-once delivery, dead-letter queues. Untested here:
   enqueue latency on one node (each write waits for the bucket), and whether a world cell can be a consumer or only a
   Worker.
8. **Deploy cut-over with open sockets.** After a deploy, idle cells moved to the new version at once; a world cell
   with an open WebSocket from the UI moved 60 s later, and a request to it waited 38 s. The UI uses regular
   WebSockets (`server.accept()`), which keep the cell busy. It also stalls other worlds' calls into such a cell: a
   Dashboard call waited out its 30 s deadline on a world that was mid-swap. Fixed on 2026-10-07: the UI's sockets are
   hibernatable (`ctx.acceptWebSocket`); see "Hibernatable sockets on the node" below.
9. **Cell limits under load.** celld refuses a request with `503 cell request limit reached` when a cell has 64 in
   flight (`in_flight=64 limit=64`), and the count appears to include the cell's own calls to other worlds: 40
   concurrent calls that each call another world got 28 answers and 12 refusals. The limit is the node setting
   `CELLD_MAX_CELL_REQUESTS` (default 64).
10. **CPU in one world slows others.** On the node, a world computing for about 1.5 s delayed calls to unrelated worlds
    by the same time: cells share a small pool of JavaScript isolates (`worker_count=2`). The time budget bounds it. Resolved 2026-10-07 for calls: each world's calls run in an isolate of the world's own (see "Isolation and R2 on the
    node"). Develops and checks still run in the shared cell isolate.

## Hibernatable sockets on the node

2026-10-07, build `a88526e` deployed to `3867c06` while a client held the UI's socket open on Dashboard and on Trip
budget, pinging every 5 s. Both cells served the new build about 23 s after the deploy was written (the node reads the
deployment pointer every 30 s), within 0.2 s of each other. Both sockets stayed open and received a `world` frame from
the new code; their REST summaries changed at the same moment. Before, with regular sockets, such a cell moved 60 s
after the others and its sockets were closed (open check 8).

## Isolation and R2 on the node

2026-10-07, build `df726fb`. Spike first (`spike/isolation/`, on the local spike fleet): QuickJS ran in a facet loaded
through a Worker Loader; a 1.38 MB snapshot crossed host to facet over RPC and restored in 20 ms; the facet fetched
1.5 MB from the host through a capability in 9 ms; the facet's SQLite worked; 9 s of CPU in a host cell held another
cell's request for 9 s, the same work in a facet held it for 2 ms; R2 stored a gzipped snapshot (1.38 MB to 110 KB,
189 ms put, 143 ms get). Then on the node:

- Data: every world's revision, function count and data were identical before and after the deploy that moved the
  data into each world's facet, compared once every world reported the new build.
- CPU: a world computing for 1.75 s; two other worlds answered in 63 to 82 ms over the tailnet. Before the change the
  same test held Demo todos for 1.47 s.
- R2: seven older snapshots archived under `snapshots/<hash>.gz`; a rollback to an archived revision took 0.82 s.
- Preview: `addTodo` inside `execute` reported its write as rolled back, and the todo count stayed the same.

## celld features not yet used

Recorded 2026-10-07 as candidates for later sessions. pi-world uses Workers, SQLite-backed Durable Objects (key-value,
SQL, one alarm as a heartbeat), RPC between cells, regular WebSockets, static assets and WebAssembly. What each
feature is comes from celld's documentation pages; what it would give pi-world is a proposal, not tested.

Closest fits:

| Feature | What it is | What it would give pi-world |
|---|---|---|
| Hibernatable WebSockets (`ctx.acceptWebSocket`) | Sockets that let a cell hibernate and swap to a new deploy | Adopted 2026-10-07 for the UI's sockets |
| Queues | Durable delivery, at least once, with retries and dead-letter queues | Durable messages between worlds, `worlds.send(...)`: open decision 14, option C |
| Alarms, beyond the heartbeat | One scheduled wake-up per cell | Scheduled world code (a daily digest, expiring items); world code has no timers. A per-world schedule fits alarms better than fleet-wide cron |
| Workflows | Durable functions of steps, sleeps and waits for events; each instance is a cell | Pauses (`restart`) as recorded facts with a rerun from the start, the alternative in open decision 8; long jobs that span several worlds |
| `transactionSync` | Several SQL writes that commit together or roll back on a throw | A call's data writes made all-or-nothing within each synchronous stretch; today a call that throws halfway keeps its earlier writes. Cannot span an `await` |

For planned features:

| Feature | What it is | What it would give pi-world |
|---|---|---|
| R2 | Object storage | Adopted 2026-10-07 for every snapshot but the head. Still open: files a world stores or serves |
| Dynamic Workers | Code loaded at runtime into its own isolate, with only the capabilities the loader passes | Adopted 2026-10-07: each world's calls run in an isolate of the world's own (open check 10). Still open: the compiled tier, and effectful host functions granted one capability at a time (open decision 6) |
| Durable Object Facets | A child object with its own SQLite inside a Durable Object, for generated or untrusted code | Adopted 2026-10-07: the world's runtime is a facet, and its data lives in the facet's SQLite |
| HTMLRewriter | Streaming HTML rewriting | Injecting the `world.call` client into world pages; today a regular expression finds `<head>` |
| TCP sockets, EventSource, Streams | Outbound TCP, server-sent events, streamed bodies | Host functions that reach databases or services; streaming a long call's output |

Little or no use now:

| Feature | Why |
|---|---|
| KV | Read-mostly global data; the directory cell already holds the world list |
| D1 | A SQL database shared across Workers; worlds keep their data in their own cells. Only cross-world queries would use it |
| Cron Triggers | Fleet-wide schedules; per-world alarms fit better |
| Containers (experimental) | Heavy tools, such as a build toolchain for the compiled tier |
| Cache | celld's cache always misses |
| `storage.sync()` | The output gate already holds responses until their writes are durable |

Suggested order: hibernatable WebSockets (fixes a stall already seen), alarms for scheduled world code (the most visible
missing capability), then Queues or Workflows once open decision 14 is settled.

### Spike results, 2026-10-07

`spike/features/` (`index.ts`, `ws-check.mjs`) ran on a temporary one-node fleet on the development machine, against
the same GCS bucket under the prefix `spikes/`, with `CELLD_IDLE_EVICT_S=5`, `CELLD_DEPLOY_POLL_S=2`,
`CELLD_TOKIO_THREADS=2` and, for the alarm runs, `CELLD_ALARM_RESIDENT_MS=1000`. The machine is not in the bucket's
region, so latencies are higher than on the node would be.

| Feature | What was run | Result |
|---|---|---|
| Hibernatable WebSockets | A hibernatable and a regular socket held open across 12 s of idle, then across a deploy | The hibernatable socket's cell hibernated (its constructor ran again) and the socket still answered. After the deploy its cell ran the new version at once and the socket stayed open, served by the new code. The regular socket's cell never hibernated, moved to the new version 60 s later, and the socket was closed at the cut-over |
| Alarms as a scheduler | Jobs due at 1.5, 3, 9 and 9 s through one alarm per cell, re-armed at the earliest job | Fired 1 to 76 ms late. A cell whose next alarm is under `CELLD_ALARM_RESIDENT_MS` (1 hour by default) stays resident; with 1 s, a job 12 s out woke a hibernated cell, 164 ms late |
| Alarms after a crash | Node killed with SIGKILL 5 s after scheduling a job 20 s out; no requests afterwards | The job fired 51 s late, once the dead node's lease expired (about a minute). A request to the cell takes it over at once and fires an overdue alarm then |
| Queues | 10 sends from a Worker, one message retried by its consumer | Each `send()` 160 to 430 ms, waiting for the bucket; delivery 0.9 to 1.5 s with a 1 s batch window; the retried message came back with `attempts=2` after 4.4 s. A consumer is a Worker `queue()` handler, not a cell, so it forwards to a world cell by RPC (open check 7 answered) |
| Workflows | Step, 3 s sleep, `waitForEvent`, step; then the same killed with SIGKILL while waiting | Completed with the answer. After the kill and a restart, the answer sent at once completed the instance with its earlier step results intact |
| `transactionSync` | Two inserts, then a throw | Both inserts rolled back |
| Dynamic Workers | 0.57 s of CPU work in a cell, then in a loaded Worker, while timing a request to another cell | Work in a cell held the other cell's request until it finished (0.32 s); work in a loaded Worker did not (2 ms). Cells share an isolate; a loaded Worker has its own |
| HTMLRewriter | Inject a script into `<head>` | Works with any case and attributes on `<head>`; a page without `<head>` gets nothing, so a fallback is still needed |

What this changes:

- Hibernatable WebSockets remove the deploy stall (open check 8) and let idle worlds hibernate. They are the first
  change to make.
- Scheduled world code on alarms works and survives a crash, but a crash delays it by about a minute on one node.
- Pauses as Workflows (open decision 8) keep their state across a crash; the step results are the durable record,
  not a heap continuation.
- Running world code in a Dynamic Worker isolates its CPU from other worlds (open check 10), at the cost of crossing
  an isolate for every host call.
- The 64-request cell limit (open check 9) is the node setting `CELLD_MAX_CELL_REQUESTS`.

## Not verified

- Which mechanism wakes a cell after a restart (see above), idle eviction, and a run resuming on another node: the
  fleet has one node.
- Merge-by-replay, tiering and pauses are designs, not code.
- jiti's handling of checks was read in its source at commit `a9f46a6`, not run.
