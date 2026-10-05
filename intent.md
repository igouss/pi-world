# pi-world: intent

A live application world that an agent grows by talking to it, in the style of
[jiti](https://github.com/ghuntley/jiti), but WASM-native: the world is a snapshotable QuickJS heap
([`quickjs-wasi`](https://www.npmjs.com/package/quickjs-wasi)) driven by
[`@earendil-works/pi-durable`](https://github.com/earendil-works/pi/tree/main/packages/durable). It is deployed on
[celld](https://celld.dev/), a self-hosted implementation of Cloudflare Durable Objects, with GCS buckets for storage.
People use it through a REST API and a web UI. There is no TUI.

Background and reasoning: the article series in `~/preview/pi-durable/`, especially part 5
(`05-wasm-native-jiti.html`). Written 2026-10-05 against pi commit `28dcce2ba` (pi-durable 1.0.4, quickjs-wasi 3.6.2)
and celld v0.6.1 (beta).

## What it does

- The agent changes the world with `develop(source)`. Each attempt runs against an in-memory checkpoint. Safety
  invariants decide whether it is accepted as a new revision or restored.
- Accepted definitions are ordinary functions. They can be called directly through the REST API, without a model
  request. The agent is needed to grow the application, not to run it.
- A job can pause on a decision (`await restart(id, question, options)`), and the pause survives crashes, eviction
  and moves between nodes. It is a pending promise in a stored snapshot, and it resumes when an answer arrives.
- Every revision is immutable. Rollback creates a new revision. Worlds fork cheaply, and forks merge by replaying
  accepted sources.
- Code lives in the heap and is versioned by revisions. Data written by end-user calls lives in SQLite tables, reached
  through host functions.

## Premise already tested

`spike/wasm-world.mjs` (`npm run spike`) runs against quickjs-wasi 3.6.2 under Node 25.2.1. Output from the run in
this project:

```
develop: countDuplicates() = 1
attempt broke invariant: true
after restore: countDuplicates() = 1
paused: [{"id":"p1","question":"1 duplicate emails"}] result = undefined
snapshot: 1376284 bytes raw, 112853 gzipped, 3.4 ms
restored in 4.8 ms; result = merge 1
budget: interrupted; VM still usable: 3
```

It showed four things:

- Checkpoint and restore undo a failed attempt.
- A paused async job survives snapshot → serialize → dispose → restore in a fresh instance.
- Snapshot and restore each take a few milliseconds.
- An instruction budget stops runaway code, and the VM stays usable afterwards.

It ran in Node only; nothing has run on celld yet.

## Deployment target: celld

celld is "a self-hosted, distributed implementation of Cloudflare Durable Objects". Each world is one cell, a Durable
Object with its own SQLite database. Facts below are from celld's docs, read 2026-10-05:

- **Single writer.** "Writers per cell (epoch-fenced): 1". "Exactly one node serves a cell at a time." This matches
  pi-durable's rule that one process owns a storage.
- **Durable writes.** "celld does not answer a write until that write survives a failure". RPO=0. Region-local durable
  write latency is about 90 ms.
- **Output gates.** "A SQL write cursor must finish before a response, an outbound effect, or `storage.sync()`."
  The intent commit is therefore durable before a model call or tool effect leaves the cell, the order pi-durable's
  spec §5.2 relies on.
- **SQLite API.** `ctx.storage.sql.exec()`, `transactionSync()` with nesting, and async transactions. Transactions and
  `blockConcurrencyWhile()` have a 30-second limit.
- **Alarms.** `setAlarm`/`getAlarm`/`deleteAlarm`, with `alarm(alarmInfo)` receiving `retryCount` and `isRetry`.
  "A cell keeps no in-memory state across an eviction", so the wake loop is still needed.
- **WebAssembly.** "A Worker bundle can import a `.wasm` file. The import gives the compiled module." Each module is
  compiled once per process. Runtime compilation is undocumented and not needed by this design.
- **WebSockets.** Hibernatable sockets survive hibernation on the same node and close when the cell moves. The web
  UI must reconnect, and `watch()` is built for that: a client that reconnects starts from the current view.
- **Failover.** About 20 s. "A request already sent to the previous owner can remain incomplete". The durable task
  resumes from its checkpoint on the new owner.
- **Also available.** Cron Triggers; Dynamic Workers (`{ wasm: bytes }` modules, at most 256 live per process);
  experimental Containers that run `@cloudflare/sandbox` "as published" on ephemeral disk.
- **Operations.**
  - Storage on **GCS buckets**; `celld dev` uses local SQLite.
  - celld doesn't terminate TLS, so an ingress proxy is needed.
  - Peer traffic is plaintext HTTP, so nodes need a private network.
  - "A fleet runs one application."
  - Linux and macOS only.
- **Density.** "RAM per resident cell: 0.47 MB"; waking a hibernated cell takes about 4 ms. Real pi-world cells will be
  heavier: a QuickJS heap of about 1.4 MB plus pi-durable and pi-ai.

## Design constraints found so far

- **Two commits, one store.** A durable tool can't put its result entry and the world revision in one commit. The
  tool's `api.commit()` runs inside `execute()`, and the Harness appends `pi.tool-result` in a later commit
  (pi-durable spec §8.4). Recovery handles this: the revision manifest records the producing `taskId`/`callId`, and a
  rerun that finds its own revision returns the same answer. Tools are therefore `replay: "safe"`.
- **Revisions go in documents, not raw entries.** Raw appends into a busy conversation "can misplace its system prompt
  entries" (spec §12). Use session-scoped docs: `WorldHead` (singleton) and `WorldRevision` (a family).
- **Write blobs first, then commit the pointer.** Snapshots are content-addressed blobs in the cell's SQLite, written
  idempotently before the durable commit, which commits only the manifest and pointer. A crash can leave orphan
  blobs, but never a pointer to a missing blob. Old pages can move to R2 later.
- **Snapshots are tied to the exact `quickjs.wasm` build.** Keep the source log. After a runtime upgrade, rebuild by
  replaying accepted sources.
- **Determinism:** pin the clock, random and timezone through quickjs-wasi's `wasi` and `timezoneOffset` options.
- **Portable core.** No `node:` modules in the core: celld's Node compatibility is "Partial", and Node-only code sits
  behind separate exports. The `.wasm` import comes from the bundle; the host passes the compiled module in.
- **Streaming cadence.** Each durable write takes about 90 ms, and viewer output is held until its write is durable.
  pi-durable's default 100 ms progress commits will show as streaming lag. Tune `settings.progress` against
  measurements.

## Interfaces

- **REST API** (Worker routes, forwarding to the world's cell):
  - `POST /worlds` creates a world; `POST /worlds/:id/fork` forks one.
  - `POST /worlds/:id/messages` submits to the agent, with a `requestId` so retries don't submit twice.
  - `POST /worlds/:id/call/:fn` is the direct call path (no model).
  - `POST /worlds/:id/pauses/:pauseId/answer` answers a pause, with a `requestId`.
  - `GET /worlds/:id/revisions`, `GET /worlds/:id/functions`, and `POST /worlds/:id/rollback` cover history and the
    catalogue.
- **Web UI** (static assets):
  - Conversation view over a WebSocket fed by `Conversation.watch()`, or `watchEvents()` for message-style events.
  - World inspector: revisions, catalogue, failing goals, open pauses with answer buttons.
  - Task graph panel from `harness.watchTaskGraph()`.

## Layout

```
src/
  vm/world-vm.ts          QuickJS wrapper: create/restore, budget, deterministic WASI, host fns by name
  vm/snapshot.ts          serialize, compression (see open checks), page hashing
  store/blob-store.ts     interface: put(hash, bytes) idempotent, get(hash)
  store/node-blobs.ts     Node implementation for unit tests (separate export)
  store/cell-blobs.ts     Durable Object SQLite implementation
  storage/cell-sqlite.ts  pi-durable SqliteDatabase adapter over ctx.storage
  docs.ts                 WorldHead, WorldRevision (family), WorldPauses
  attempt.ts              checkpoint → eval → checks → accept | restore
  tools/                  develop, execute, preview, save_as, functions, describe, history, rollback, answer, abort
  section.ts              "world" observation section: revision, catalogue summary, failing goals, pauses, budget
  extension.ts            defineExtension({ name: "world", tools, sections, hooks })
  call.ts                 direct call path (no model)
  data/data-store.ts      host db.query / db.run over the cell's SQLite
  cell/world-object.ts    the Durable Object: Harness, wake alarm, WebSocket viewers
  api/routes.ts           REST routes in the Worker
  testing/                blob-store and world conformance suites
web/                      web UI (static assets)
spike/                    premise experiment
test/
```

## Milestones

1. **World VM.** Port the spike into `WorldVm`, with deterministic WASI. Test: the same source on the same revision
   gives byte-identical snapshots. Runs under Node and Vitest.
2. **Blob store and docs.** Test: blob-store conformance; no pointer to a missing blob after a crash between put and
   commit.
3. **`develop` and `execute` as durable tools.** Uses pi-durable's memory or Node SQLite storage and the faux
   provider. Test: kill at each phase, then reopen. No revision may exist without its pointer, and nothing may be
   accepted twice.
4. **Pauses.** Test: pause, kill, reopen, answer. The job finishes with its pre-pause locals intact.
5. **Section, catalogue, checks.** Invariants run in the attempt; goals run through an `onYield` hook.
6. **Cell on `celld dev`.**
   - The `cell-sqlite` adapter, which must pass pi-durable's `registerStorageConformance()`.
   - The `World` Durable Object with a heartbeat alarm, and the REST routes.
   - A minimal web UI with a conversation view and pause answering.
   - Tests: storage conformance; a REST round trip; a pause that survives a cell restart.
7. **Source-log replay.** Test: replaying a world's log into a fresh VM gives the same catalogue, and invariants pass.
8. **celld fleet on GCS.** Ingress with TLS, a private network for peers, GCS buckets. Tests:
   - Kill the owning node mid-turn; failover completes and the task resumes.
   - A pending pause survives a move to another node.
9. **Later.** Content-addressed pages and R2 offload, per-user forks with promotion by replay, and a compiled tier via
   Dynamic Workers (builds in an experimental container).

Stop after milestone 6 and review before the fleet deployment.

## Open checks on celld

These are undocumented or unknown. Measure them early, at milestone 6.

1. **Memory and CPU limits per cell.** The limitations page lists none, and balancing "does not measure the CPU or
   memory that one cell uses". Measure a realistic world cell.
2. **`CompressionStream`.** Not in celld's compatibility list. If it's missing, use a pure-JS fallback or store
   snapshots uncompressed.
3. **pi-ai and pi-durable under celld's runtime.** Node compatibility is "Partial".
4. **Eviction timing and alarm retry limits.** Tune the heartbeat from measurements, not Cloudflare's numbers.
5. **Streaming lag.** Measure progress commits at about 90 ms per durable write.

## Operator decision

- "looks good, create a new project in ~/IdeaProjects and save this as intent.md", 2026-10-05.
- "yes update intent.md, I'll set-up it with GCS buckets. TUI will not be used, probably REST and WEB UI.",
  2026-10-05.

This approves:

- the plan above as the project's intent, and this directory;
- celld as the deployment target, with GCS buckets;
- REST and a web UI as the interfaces, with no TUI.

Nothing else is approved: the package's home (standalone or upstream in pi), the first milestone's scope, the web UI
stack, dependency choices beyond those named here, and every other policy question go back to the operator.

## Open decisions

1. **Where it lives.** Options are this standalone repo depending on published `pi-durable` and `quickjs-wasi`, or
   `packages/world` upstream in pi, which needs the pi maintainers' agreement.
2. **First milestone scope.** The proposal is milestones 1–6.
3. **Web UI stack.** Not chosen.
4. **Part 5 correction.** The article says "one commit"; it should say "one store, two commits, idempotent recovery".
5. **Preview isolation of data writes.** Either a rolled-back transaction around the call, or a scratch copy of the
   touched tables.
6. **World languages beyond JavaScript.** Pyodide is a candidate, but whether its snapshots capture suspended
   coroutines is unknown.

## Not verified

- Nothing has run on celld, either `celld dev` or a fleet.
- celld facts come from its documentation pages, not from tests.
- Snapshot sizes for realistic worlds are unmeasured.
- Merge-by-replay, tiering, the REST API, the web UI, and the durable integration are designs, not code.
