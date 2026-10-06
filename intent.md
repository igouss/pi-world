# pi-world: intent

A live application world that an agent grows by talking to it, in the style of
[jiti](https://github.com/ghuntley/jiti), but WASM-native: the world is a snapshotable QuickJS heap
([`quickjs-wasi`](https://www.npmjs.com/package/quickjs-wasi)) driven by
[`@earendil-works/pi-durable`](https://github.com/earendil-works/pi/tree/main/packages/durable). It is deployed on
[celld](https://celld.dev/), a self-hosted implementation of Cloudflare Durable Objects, with GCS buckets for storage.
People use it through a REST API and a web UI. There is no TUI.

Background and reasoning: the article series in `~/preview/pi-durable/`, especially part 5
(`05-wasm-native-jiti.html`). Written 2026-10-05 against pi commit `28dcce2ba` (pi-durable 1.0.4, quickjs-wasi 3.6.2)
and celld v0.6.1 (beta). `evaluation.md` reviews this intent against those sources; its findings are folded in below.

## What it does

- The agent changes the world with `develop(source)`. Each attempt runs against an in-memory checkpoint. Safety
  invariants decide whether it is accepted as a new revision or restored.
- Accepted definitions are ordinary functions. They can be called directly through the REST API, without a model
  request. The agent is needed to grow the application, not to run it.
- Definitions and state go through a prelude installed at revision 0: `define(name, impl)` and
  `state(name, init, { version, migrate })`. A redefinition reaches every caller, and re-evaluating a source keeps
  its state.
- A job can pause on a decision (`await restart(id, question, options)`), and the pause survives crashes, eviction
  and moves between nodes. It is a pending promise in a stored snapshot, and it resumes when an answer arrives.
- Every revision is immutable. Rollback creates a new revision. Worlds fork cheaply, and forks merge by replaying
  accepted `develop` sources.
- Code lives in the heap and is versioned by revisions. Data written by end-user calls lives in SQLite tables, reached
  through host functions.

## Position

pi-world is the fastest possible implement-and-check loop for one kind of artifact: a program that grows through
prompting, where the result is validated and iterated on immediately. It is one station of a larger line, not the
line. What it does not supply, and a surrounding pipeline would: a requirement spine, ownership of the gates by
someone other than the implementing agent, an acceptance stage, and a ledger that outlives the conversation.

## Premise already tested

Three spikes ran against quickjs-wasi 3.6.2 under Node 25.2.1. Nothing has run on celld yet.

- `spike/wasm-world.mjs` (`npm run spike`): checkpoint and restore undo a failed attempt; a paused async job survives
  snapshot, serialize, dispose and restore in a fresh instance; snapshot and restore each take a few milliseconds;
  an instruction budget stops runaway code and the VM stays usable afterwards.
- `spike/determinism.mjs` (`npm run spike:determinism`): with a fixed `wasi` clock and random, the same source on
  the same base gives byte-identical snapshots, and restore then snapshot is identical. Growth is linear, about
  1.5 KB per synthetic definition, so a raw snapshot passes 2 MB at about 410 definitions.
- `spike/registry.mjs` (`npm run spike:registry`): the prelude's registry and state form behave as the constraints
  below describe, including the one hole left, a running frame.

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

## Design constraints found so far

- **Two commits, one store.** A durable tool can't put its result entry and the world revision in one commit. The
  tool's `api.commit()` runs inside `execute()`, and the Harness appends `pi.tool-result` in a later commit
  (pi-durable spec §8.4). Recovery handles this: the revision manifest records the producing `taskId`/`callId`, and a
  rerun that finds its own revision returns the same answer. Tools are therefore `replay: "safe"`.
- **Revisions go in documents, not raw entries.** Raw appends into a busy conversation "can misplace its system prompt
  entries" (spec §12). Use session-scoped docs: `WorldHead` (singleton) and `WorldRevision` (a family).
- **Write blobs first, then commit the pointer.** Each snapshot is one content-addressed blob in the cell's SQLite,
  gzipped with `gzipSync`, written idempotently before the durable commit, which commits only the manifest and
  pointer. A crash can leave orphan blobs, but never a pointer to a missing blob. Page-level dedupe between
  revisions, and moving old pages to R2, come later (milestone 9).
- **Only `develop` sources replay.** Merge, rebuild after an upgrade, and promotion between forks replay `develop`
  sources. An `execute` that wrote data replays against different tables in another world and gives a different
  result. The attempt traces host calls, and a `develop` whose evaluation made any is rejected.
- **Direct calls never persist heap changes.** A call that mutates heap state, such as a global counter, loses it on
  the next eviction. Only revisions persist heap state; data a call writes goes through the host database functions.
- **Attempts are synchronous.** From checkpoint to accept or restore, an attempt never yields to the event loop, so no
  direct call can observe an uncommitted heap. A job that pauses on `restart` is snapshotted into a pending revision,
  which releases the VM.
- **Definitions dispatch through a registry.** `define(name, impl)` never replaces the global binding. The global is a
  stable stub created once; the implementation lives in a registry and a redefinition swaps the entry. A class keeps
  one prototype object per name, patched in place on redefinition: the prototype is the vtable. Captured references,
  callback tables, `.bind`, old instances and subclasses therefore all follow a redefinition. The catalogue, source
  per definition, call counts, budgets, the direct call path and the compiled tier are all operations on registry
  entries. The prelude is installed at revision 0 and versioned in the revision manifest.
- **The one hole left is a running frame.** A job paused inside a function keeps that function's bytecode when it
  resumes. The one-timeline rule covers it, and the `world` section flags a pause whose function was redefined
  after it was taken (open decision 8).
- **State is keep-if-present.** `state(name, init, { version, migrate })` runs `init` once and returns the stored
  object on every later evaluation with the same version, so re-running a source keeps its caches and registries. A
  shape change is a version bump, with an optional `migrate`, which is property-tested: for every valid old value it
  returns a valid new value. `reset(name)` is the deliberate replacement. The value must be an object, never a
  primitive, because the source binds it with `const` and mutates it. State lives in the heap: checkpoints undo
  attempt writes to it, and a source-log replay re-runs every `init`, so a value that must survive replay is data and
  belongs in SQLite.
- **Sources run in a function scope.** The host wraps every `develop` source in `(() => { ... })()`. Top-level
  bindings are locals of that evaluation, nothing leaks into the global lexical scope, re-evaluation cannot throw a
  redeclaration, and the only exports are `define` and `state`. Constructor field changes are not migrated; the rule
  that data lives outside the heap keeps that from mattering.
- **Stable observation text.** A section whose text changes without a real content change appends system deltas and
  misses the provider prompt cache (spec §12). The `world` section renders revision-level facts only; budget left and
  recently used functions are reported by the `status` tool.
- **Snapshots are tied to the exact `quickjs.wasm` build.** Keep the source log. After a runtime upgrade, rebuild by
  replaying accepted `develop` sources.
- **Determinism:** pin the clock, random and timezone through quickjs-wasi's `wasi` and `timezoneOffset` options.
- **Portable core.** No `node:` modules in the core: celld's Node compatibility is "Partial", and Node-only code sits
  behind separate exports. The `.wasm` import comes from the bundle; the host passes the compiled module in.
- **Streaming cadence.** Each durable write takes about 90 ms, and viewer output is held until its write is durable.
  pi-durable's default 100 ms progress commits will show as streaming lag. Tune `settings.progress` against
  measurements.

## Interfaces

- **Agent tools:** develop, execute, preview, save_as, functions, describe, status, reset, history, rollback, answer,
  abort. The `world` observation section shows the revision, a catalogue summary, failing goals and open pauses.
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

## Milestones

1. **World VM.** Port the spikes into `WorldVm`, with deterministic WASI and the prelude. Tests: the same source on
   the same revision gives byte-identical snapshots; the registry and state checks from `spike/registry.mjs`. Runs
   under Node and Vitest.
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
   Dynamic Workers (builds in an experimental container): a stable, hot function gets a version compiled to wasm,
   and the registry swaps it in like any redefinition.

Stop after milestone 6 and review before the fleet deployment.

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

## Operator decision

- "looks good, create a new project in ~/IdeaProjects and save this as intent.md", 2026-10-05.
- "yes update intent.md, I'll set-up it with GCS buckets. TUI will not be used, probably REST and WEB UI.",
  2026-10-05.
- "save it as evaluation.md and fold the findings into intent.md", 2026-10-05.
- "fold the vtable and state form into intent.md", 2026-10-05.
- "OK, let's settle on JavaScript as the world language and TypeScript as the cell shell.", 2026-10-05.
- "Yes, I'm looking at it as a fastest possible implement-and-check loop for one kind of artifact. I program that
  grows thou prompting, where I can immediately validate and iterate on results.", 2026-10-06.
- "ok, commit and push after you apply", 2026-10-06, on the proposed cuts to this document.

This approves:

- the plan above as the project's intent, and this directory;
- celld as the deployment target, with GCS buckets;
- REST and a web UI as the interfaces, with no TUI;
- recording the evaluation's findings here as design constraints and open items. It decides none of the open
  decisions below;
- the prelude: a registry with stable stubs for definitions, the keep-if-present state form, and sources evaluated
  in a function scope;
- JavaScript as the world language and TypeScript as the cell shell. A compiled language cannot be the world
  language: every `develop` would be a recompile into a module with a new memory layout, which invalidates the
  previous snapshot and ends the live image. Compiled code belongs in the compiled tier (milestone 9);
- the position above: one station, the fastest implement-and-check loop for one kind of artifact. It decides none
  of open decisions 4 and 10 to 13.

Nothing else is approved: the package's home (standalone or upstream in pi), the first milestone's scope, the web UI
stack, dependency choices beyond those named here, and every other policy question go back to the operator.

## Open decisions

1. **Where it lives.** Options are this standalone repo depending on published `pi-durable` and `quickjs-wasi`, or
   `packages/world` upstream in pi, which needs the pi maintainers' agreement.
2. **Web UI stack.** Not chosen.
3. **Preview isolation of data writes.** Either a rolled-back transaction around the call, or a scratch copy of the
   touched tables.
4. **Which record is authoritative.** This intent treats the snapshot as primary and the source log as the upgrade
   escape. The inverse, log authoritative with the snapshot as a materialization and the carrier of pauses, removes
   the wasm-build coupling from the durability story and makes forks and merges a log operation. Both designs replay
   on a runtime upgrade and both need the purity rule on `develop`. The difference: with the log authoritative, every
   revision's correctness depends on replay determinism, not only an upgrade's.
5. **REST authentication.** Who may call `develop` versus `call`, and how an end user of a world is distinguished from
   its author. The fleet runs one application, so this is the project's to define.
6. **Secrets for effectful host functions.** Where HTTP, email and payment credentials live, and which worlds may use
   them.
7. **Layout.** Not chosen. Group by capability (`attempt/`, `revision/`, `pause/`, `call/`), which says what the
   system does, rather than by technical layer (`vm/`, `store/`, `api/`).
8. **A pause whose function was redefined.** When the answer arrives, resume the old body, or abort and rerun the
   job against the new one. Rerunning needs the job to be idempotent up to the pause. A pending revision holds a
   continuation no source rebuilds, so it also dies on a runtime upgrade; the alternative that survives both is a
   pause recorded as a fact and a rerun from the job's start.
9. **Explicit `define` or a host rewrite.** The agent writes `define(...)` and `state(...)` by hand, or the host
   rewrites top-level `function`, `class` and `const` declarations into them so the agent writes ordinary
   JavaScript. The rewrite needs a parser on the host.
10. **Checks out of the world.** This intent stores invariants and goals in the world under a reserved name, written
    through `develop` by the same agent that writes the code. A `develop` that weakens a check and then passes it is
    a false green. The alternative: checks are a separate registry kind with their own tool, enrolled only after
    they have been seen failing against a counterexample, and loosened only with a recorded operator reason.
11. **A requirement id on every revision.** The revision manifest records the producing tool call and nothing about
    intent. A revision could carry the requirement or use case it serves, so a shipped function traces back to why
    it exists.
12. **Harness-owned interrupts by change class.** `restart` is a pause the agent's own code decides. The harness has
    no interrupt of its own. A `develop` that touches checks, data schema or effectful host functions could block for
    the operator by change class, decided in harness code rather than by the agent.
13. **Rejections as records.** A rejected attempt is a tool result in the conversation, which compaction can
    summarise away. The alternative is a revision-family record naming the failing check, so rejections stay
    queryable.

## Not verified

- Nothing has run on celld, either `celld dev` or a fleet; its facts come from documentation pages, not tests.
- Merge-by-replay, tiering, the REST API, the web UI, and the durable integration are designs, not code.
