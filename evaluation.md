# pi-world: evaluation of the intent

Evaluated 2026-10-05 against `intent.md` at commit bbbd818, pi commit `28dcce2ba` (pi-durable 1.0.4, pi-ai 1.0.4),
quickjs-wasi 3.6.2, Node 25.2.1, and celld's documentation pages (v0.6.1 beta).

## Verdict

The idea is sound and the design is consistent with the sources it cites. The premise is verified in Node only.
Nothing has run on celld, and that remains the single largest unknown. The celld beta risk is hedged by construction:
the cell API is Cloudflare's Durable Object API, so the fleet target can be swapped.

## What was checked

- pi-durable 1.0.4 at commit `28dcce2ba`: spec §4, §5.2, §8.4, §11.2 and §12 say what the intent says. The tool
  execution API exposes `commit`, `taskId` and `callId`, so the two-commit recovery story is implementable as written.
  The `SqliteDatabase` facade is asynchronous with a `transaction(callback)` method, which maps onto a cell's
  `ctx.storage` without a synchronous bridge.
- pi-durable's core exports have no `node:` imports. pi-ai's Anthropic path pulls in only a browser-safe helper, and
  pi-ai ships a Cloudflare provider.
- celld's compatibility page lists `node:zlib` with synchronous gzip and deflate, so `gzipSync` is available.
  celld's Durable Object page states no row or blob size limit.
- quickjs-wasi 3.6.2, `spike/determinism.mjs` under Node 25.2.1:

| Measurement | Result |
|---|---|
| Same source, two VMs, host clock and random | different bytes |
| Same source, two VMs, fixed `wasi` clock and random | byte-identical |
| Restore, then snapshot again | byte-identical |
| Restore one base twice, evaluate the same source | byte-identical |
| 0 / 200 / 2000 definitions, raw | 1.38 MB / 1.64 MB / 4.39 MB |
| 0 / 200 / 2000 definitions, gzipped | 109 KB / 176 KB / 620 KB |

The library's determinism holds in milestone 1's shape: restoring one base twice and evaluating the same source gives
byte-identical snapshots. Snapshot growth is linear, about 1.5 KB per definition.

## Findings

Each finding names the place in `design.md` or `research.md` where it is folded in, and a concrete failure.

1. **Merge by replay is only valid for definitional sources** (`design.md`, "Only `develop` sources
   replay"). An `execute` that wrote SQLite rows replays against
   different data in the other fork and produces a different world. The rule needs enforcing: trace host calls during
   the attempt and accept a `develop` only if its evaluation made none.
2. **Content addressing was stated at two granularities** (`design.md`, "Write blobs first"; `research.md`, open check 2).
   The blob store is content-addressed per snapshot; page-level dedupe is deferred. A raw snapshot passes 2 MB at
   about 410 definitions, and celld states no blob limit, so Cloudflare's 2 MB row limit cannot be assumed either
   way. The cell's blob size limit is an open check.
3. **The observation section defeats prompt caching** (`design.md`, "Stable observation text"). Budget left and recently used functions change every turn.
   Spec §12 ("Unstable prompt text"): a section whose output changes without a real content change appends system
   deltas and misses the provider prompt cache. Render only revision-level facts; put the volatile parts in a tool.
4. **Direct calls must not persist heap changes** (`design.md`, same name). A call that mutates heap state, such as a global counter, loses it
   silently on eviction. Only revisions persist heap state; data goes through the host database functions.
5. **Attempts must be synchronous** (`design.md`, "Attempts are synchronous"). A `develop` whose source awaits anything other than `restart` spans an await,
   and a direct call arriving in that window observes an uncommitted heap. An attempt runs synchronously from
   checkpoint to accept or restore; a pause snapshots into a pending revision and releases the VM.
6. **Redefinition hole** (`design.md`, "Definitions dispatch through a registry" and "The one hole left is
   a running frame"). jiti's README admits active frames can retain earlier definitions. JavaScript has the same
   hole for captured references, and invariants cannot see it. Resolved after this evaluation by the prelude's
   registry with stable stubs, tested in `spike/registry.mjs`; a running frame remains, covered by the one-timeline
   rule.

## Policy questions for the operator

- Which is authoritative, the snapshot or the source log? The intent treats the snapshot as primary and the log as an
  upgrade escape. The inverse removes the wasm-build coupling from the durability story and makes forks and merges a
  log operation. It costs a replay on every runtime upgrade and a purity rule on `develop`.
- Authentication for the REST API: who may call `develop` versus `call`, and how an end user of a world is
  distinguished from its author.
- Secrets for effectful host functions: where they live and which worlds may use them.
- Layout: `vm/`, `store/`, `storage/` and `api/` are technical layers. Capabilities such as `attempt/`, `revision/`,
  `pause/` and `call/` would say what the system does.

## Not verified

- Nothing ran on celld.
- The snapshot measurements used synthetic definitions with small data; real worlds may differ.
