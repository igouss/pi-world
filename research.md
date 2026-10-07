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

## Not verified

- Which mechanism wakes a cell after a restart (see above), idle eviction, and a run resuming on another node: the
  fleet has one node.
- The OAuth refresh: the credential has not yet reached its expiry on the node.
- Merge-by-replay, tiering and pauses are designs, not code.
- jiti's handling of checks was read in its source at commit `a9f46a6`, not run.
