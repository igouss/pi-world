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
  behave as the constraints in `design.md` describe, including the one hole left, a running frame.

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
2. **Blob size per row.** celld's Durable Object docs state no row or blob limit, and Cloudflare's 2 MB cannot be
   assumed either way. A raw snapshot passes 2 MB at about 410 definitions. Measure, and chunk if needed.
3. **pi-ai and pi-durable under celld's runtime.** Node compatibility is "Partial", but pi-durable's core exports
   have no `node:` imports, and pi-ai's Anthropic path pulls in only a browser-safe helper. One run should settle it.
4. **Eviction timing and alarm retry limits.** Tune the heartbeat from measurements, not Cloudflare's numbers.
5. **Streaming lag.** Measure progress commits at about 90 ms per durable write.

## Not verified

- Nothing has run on celld, either `celld dev` or a fleet; its facts come from documentation pages, not tests.
- Merge-by-replay, tiering, the REST API, the web UI, and the durable integration are designs, not code.
