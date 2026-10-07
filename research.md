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
   WebSockets (`server.accept()`), which keep the cell busy. Hibernatable WebSockets (`ctx.acceptWebSocket`) would let
   it swap and hibernate, at the cost of re-subscribing the view when the cell wakes. Not yet changed. It also stalls
   other worlds' calls into such a cell: a Dashboard call waited out its 30 s deadline on a world that was mid-swap.
9. **Cell limits under load.** celld refuses a request with `503 cell request limit reached` when a cell has 64 in
   flight (`in_flight=64 limit=64`), and the count appears to include the cell's own calls to other worlds: 40
   concurrent calls that each call another world got 28 answers and 12 refusals. Not documented; the 64 is from the
   log line.
10. **CPU in one world slows others.** On the node, a world computing for about 1.5 s delayed calls to unrelated worlds
    by the same time: cells share a small pool of JavaScript isolates (`worker_count=2`). The time budget bounds it.

## celld features not yet used

Recorded 2026-10-07 as candidates for later sessions. pi-world uses Workers, SQLite-backed Durable Objects (key-value,
SQL, one alarm as a heartbeat), RPC between cells, regular WebSockets, static assets and WebAssembly. What each
feature is comes from celld's documentation pages; what it would give pi-world is a proposal, not tested.

Closest fits:

| Feature | What it is | What it would give pi-world |
|---|---|---|
| Hibernatable WebSockets (`ctx.acceptWebSocket`) | Sockets that let a cell hibernate and swap to a new deploy | Removes the deploy cut-over stall (open check 8); idle worlds with an open page can hibernate. Cost: the transcript subscription must be re-attached when the cell wakes |
| Queues | Durable delivery, at least once, with retries and dead-letter queues | Durable messages between worlds, `worlds.send(...)`: open decision 14, option C |
| Alarms, beyond the heartbeat | One scheduled wake-up per cell | Scheduled world code (a daily digest, expiring items); world code has no timers. A per-world schedule fits alarms better than fleet-wide cron |
| Workflows | Durable functions of steps, sleeps and waits for events; each instance is a cell | Pauses (`restart`) as recorded facts with a rerun from the start, the alternative in open decision 8; long jobs that span several worlds |
| `transactionSync` | Several SQL writes that commit together or roll back on a throw | A call's data writes made all-or-nothing within each synchronous stretch; today a call that throws halfway keeps its earlier writes. Cannot span an `await` |

For planned features:

| Feature | What it is | What it would give pi-world |
|---|---|---|
| R2 | Object storage | Old snapshot blobs moved out of the cell's SQLite (`plan.md`, milestone 9); files a world stores or serves |
| Dynamic Workers | Code loaded at runtime into its own isolate, with only the capabilities the loader passes | The compiled tier (`plan.md`, milestone 9); effectful host functions such as `fetch` or email granted one capability at a time (open decision 6). Possibly isolates a world's CPU from other worlds (open check 10); untested |
| Durable Object Facets | A child object with its own SQLite inside a Durable Object, for generated or untrusted code | Storage for code loaded through Dynamic Workers, separate from the world cell's tables |
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

## Not verified

- Which mechanism wakes a cell after a restart (see above), idle eviction, and a run resuming on another node: the
  fleet has one node.
- The OAuth refresh: the credential has not yet reached its expiry on the node.
- Merge-by-replay, tiering and pauses are designs, not code.
- jiti's handling of checks was read in its source at commit `a9f46a6`, not run.
