# pi-world: design constraints

The rules the implementation obeys, each with the fact that forces it.

- **Two commits, one store.** A durable tool can't put its result entry and the world revision in one commit. The
  tool's `api.commit()` runs inside `execute()`, and the Harness appends `pi.tool-result` in a later commit
  (pi-durable spec §8.4). Recovery handles this: the revision manifest records the producing `taskId`/`callId`, and a
  rerun that finds its own revision returns the same answer. Tools are therefore `replay: "safe"`.
- **Revisions go in documents, not raw entries.** Raw appends into a busy conversation "can misplace its system prompt
  entries" (spec §12). Use session-scoped docs: `WorldHead` (singleton) and `WorldRevision` (a family).
- **Write blobs first, then commit the pointer.** Each snapshot is one content-addressed blob, written idempotently
  to the cell's SQLite before the durable commit, which commits only the manifest and pointer. A crash can leave
  orphan blobs, but never a pointer to a missing blob.
- **Only `develop` sources replay.** Merge, rebuild after an upgrade, and promotion between forks replay `develop`
  sources. An `execute` that wrote data replays against different tables in another world and gives a different
  result. The attempt traces host calls, and a `develop` whose evaluation made any is rejected.
- **Direct calls never persist heap changes.** A call that mutates heap state, such as a global counter, loses it on
  the next eviction. Only revisions persist heap state; data a call writes goes through the host database functions.
- **A failed call is an incident.** A call of a defined name that fails is recorded with its arguments (up to 64 KB),
  error, revision and failure kind (`threw`, `budget`, `host-call`, `pending` or `conflict`). While it is open, the
  same definition failing with the same first line of error counts into it. Opening and closing an incident are each
  one durable commit. Repeats of an open incident are counted in memory, shown merged to readers, and written together
  at most every 30 s, or before a retry or a close changes the incident, so a crash loses at most 30 s of repeat
  counts, never an incident. The reason: celld holds every response of a cell until a durability proof covers it, so
  a write per failed call held up the world's good calls (`performance.md`, finding 4). Whether the grouping key
  should stay the definition and first line of error is open (`pw-rxw.5`). Retrying runs the call again at the
  current head; because the failed call wrote nothing, the retry is the call, not a second one. A retry refused as
  busy changes nothing. An incident closes when a retry succeeds, the owner answers it
  with a value, or it is dismissed with a reason. A call of a name the world does not define is the caller's mistake
  and is not recorded. A call refused as busy (see below) did not run and is not recorded either. The agent learns
  of an incident only when the owner asks it to fix one.
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
  after it was taken (`decisions.md`, open decision 8).
- **Instances migrate at redefinition, eagerly and by declaration.** A class is redefined with
  `define(name, impl, { version, migrate })`, like state. The constructor stub records every instance it builds in a
  set of weak references and marks it with the class version. A redefinition whose version differs migrates every
  live instance inside the attempt, with `migrate(instance, { from, to })` mutating it in place, so a migration that
  throws rejects the `develop` and the checkpoint restore puts the instances back, and the invariants see migrated
  instances before accept. There is no default migration: a version bump with live instances and no `migrate` is
  rejected, naming the count. No version bump means the shape is unchanged and only the vtable is patched. Because
  every live instance is migrated at each bump, `migrate` only ever runs one step and a snapshot's instances are
  always at its revision's shape. Only instances built with `new` through the class are tracked; an object made
  with `Object.create` or revived from JSON has no version and no migration. This is affordable because data lives
  in SQLite, so heap instances are few; rows there are data, and a schema change there is a separate migration.
- **State is keep-if-present.** `state(name, init, { version, migrate })` runs `init` once and returns the stored
  object on every later evaluation with the same version, so re-running a source keeps its caches and registries. A
  shape change is a version bump, with an optional `migrate`, which is property-tested like a class migration: for
  every valid old value it returns a valid new value, and the invariants hold on the result. `reset(name)` is the deliberate replacement. The value must be an object, never a
  primitive, because the source binds it with `const` and mutates it. State lives in the heap: checkpoints undo
  attempt writes to it, and a source-log replay re-runs every `init`, so a value that must survive replay is data and
  belongs in SQLite.
- **Sources run in a function scope.** The host wraps every `develop` source in `(() => { ... })()`. Top-level
  bindings are locals of that evaluation, nothing leaks into the global lexical scope, re-evaluation cannot throw a
  redeclaration, and the only exports are `define` and `state`.
- **Top-level declarations are definitions.** Before evaluating, the host parses the source and rewrites each
  top-level `function f` by adding `var f = define("f", f)` to the first line, and each top-level `class C` into
  `const C = define("C", class C …)` in place, with a JSDoc comment as the doc. The local name then holds the stub, so
  references inside the same source, recursion included, follow later redefinitions, and no line moves, so error
  positions point into the source as written. The revision stores the rewritten text as `source`, which is what
  replays, so replay never depends on the rewriter's version; `written` keeps the source as the agent wrote it. A
  source that does not parse is evaluated unchanged and its syntax error reported by QuickJS.
- **Checks live outside the world.** Invariants and goals are not world code. Their sources are stored on the host
  side, in a `WorldChecks` document, outside the heap. The host evaluates them in the VM after each attempt. No host
  function lets world code read or write them, so a `develop` cannot change a check. jiti keeps its checks with the
  caller for the same reason; there the wall is a filter over the submitted form, here it is the sandbox boundary.
- **A check is enrolled only after it has been seen failing.** The agent proposes a check through its own tool, and
  the operator through `POST /api/worlds/:id/checks`, each with a counterexample: a small change to the world that
  the check must reject. The host applies the counterexample
  on a checkpoint, requires the check to fail there, restores, and requires it to pass on the current world. Only
  then is it enrolled. Removing or loosening a check is an operator call with a recorded reason, never an agent
  tool.
- **Checks see a scratch data store, never the world's data.** A check runs in attempt mode with a fresh, empty
  in-memory store, so it can set rows up and call functions that read them, and the world's data never decides
  whether a develop is accepted. A develop and a counterexample have no store: touching data fails them as host
  calls, because only `develop` sources replay.
- **A property check is a check with a generator.** The generator is JSON the host interprets, so no world code runs
  on the host. Each run draws 50 inputs from a choice sequence seeded by the attempt, evaluates the expression with
  `input` bound to each on its own scratch store, and on a failure shrinks the choice sequence (delete runs, lower
  single choices) to the smallest input that still fails, which the rejection names. Integers shrink toward 0, so a
  failing input reads as the boundary it crossed. An input the check runs out of budget on is not shrunk, and
  shrinking stops at the first smaller input it runs out of budget on: each such run costs a whole budget in the
  world's isolate, where it holds up the world's calls, so a check runs out of budget at most once per run.
- **Every develop re-runs every counterexample.** After the checks hold on the developed heap, each check's
  counterexample is applied to that heap in turn and the check must fail there. A check that a change made vacuous
  (it calls a redefined function, or reads changed state) rejects the develop, because a check that cannot fail is a
  false green. The accepted snapshot is the heap taken right after the source evaluated, before any check ran, so
  nothing a check or a counterexample does to the heap is kept.
- **Rejections are records.** A rejected develop or a refused check is committed as a numbered `Rejection` document
  in the same commit a tool call would have used for a revision, because a tool result in the conversation can be
  compacted away. The rejection names its base revision, its failure and the check it broke, and a rerun of the same
  tool call after a crash returns the recorded rejection instead of recording a second one.
- **Built-ins are frozen.** The prelude freezes the built-in constructors and prototypes at revision 0, so world
  code cannot weaken a check by changing something the check calls, such as `Array.prototype.every`. The cost:
  assigning a built-in name on a plain object, such as `obj.toString = ...`, is ignored in sloppy code and throws in
  strict code. A class may still define `toString`, because class methods are defined, not assigned.
- **Stable observation text.** A section whose text changes without a real content change appends system deltas and
  misses the provider prompt cache (spec §12). The `world` section renders revision-level facts only; budget left and
  recently used functions are reported by the `status` tool.
- **Snapshots are tied to the exact `quickjs.wasm` build.** Keep the source log. After a runtime upgrade, rebuild by
  replaying accepted `develop` sources.
- **Determinism:** pin the clock, random and timezone through quickjs-wasi's `wasi` and `timezoneOffset` options.
- **Calls run in the world's own isolate.** Calls, previews and data belong to a `CallRunner`. In the cell it is a
  facet loaded through a Worker Loader with a loader id per world, because loaded code with one id shares one isolate,
  and a shared isolate would let one world's CPU work hold up the others. The facet owns the world's data in its own
  SQLite (synchronous, as world code needs), fetches snapshots from the cell by content hash, and reaches other worlds
  only through the `WorldHost` capability. The runtime bundle is built from `src/isolate/runtime/` and the world core
  alone, so host code cannot leak into it. Snapshots reach a runner by content hash from the blob store, so `World`
  does not serve them.
- **Changes do their VM work in the world's own isolate.** Develops, checks, enrolment, rollbacks and prelude
  upgrades evaluate behind a `Workbench` port, which in the cell is the same facet (`FacetWorkbench`), so the CPU they
  spend holds up only that world. The cell keeps durability, documents, the lock and the agent, and does not import
  QuickJS. Every workbench operation names the head blob the cell holds; the workbench keeps its VM at a blob of its
  own and restores the named head when the two differ, so a commit that failed, an evicted isolate or a rollback
  needs no other protocol. Storing the new blob and archiving the previous one to R2 still run in the cell isolate
  that worlds share (`performance.md`, finding 11, bead `pw-djz.7`).
- **`execute` is a preview.** Its data writes go to an overlay that is dropped afterwards (`OverlayDataPort`), and
  the result lists them. An overlay rather than a SQL transaction, because an evaluation can span awaits.
- **Snapshots are tiered.** The head's blob stays in the cell's SQLite; every other blob moves to R2, gzipped, and the
  local copy is deleted only once R2 holds it (`TieredBlobStore`). A pass runs when the head changes; requests during
  a pass collapse into one more. Blobs are content-addressed, so a key never needs
  rewriting and identical snapshots of different worlds share one object.
- **Calls run concurrently, each on its own VM; changes run one at a time on the workbench VM.** A call takes a VM
  from the world's pool (`VmPool`, 8 by default) at the head the call started at, and keeps it until it settles. The
  VM then returns to the newest head by copying the snapshot over its own memory (`quickjs-rewind.ts`), and falls
  back to a full restore when the call grew the memory or quickjs-wasi's layout differs. A develop, rollback, check
  or upgrade holds the world's lock and uses the workbench's VM. One VM cannot serve two calls at once: two
  evaluations would share one heap, and resetting it after one would wipe the other. Consequences:
  - A call that awaits another world does not block the world's other calls or its changes
    (`test/concurrency.test.ts`).
  - A call that started before a new revision finishes on the old one.
  - A call is atomic and serializable. Its data writes go to an overlay it reads back, and the overlay records what
    the call read. When the call succeeds, its commit validates those reads and makes its writes in the same
    transaction of the world's `DataStore` (the runtime's SQLite); a call that fails leaves no write. A call whose
    reads went stale reruns from the start in the world's rerun lane, one rerun at a time, at most 5 times, and then
    fails with failure kind `conflict`, an incident. A call that wrote nothing never conflicts. A rerun repeats the
    calls it made to other worlds, and data those worlds wrote is not rolled back (`overlay-data-port.ts`,
    `local-call-runner.ts`).
  - A call starts within a second or is refused. Each call carries a start deadline one second after the world's cell
    received it. A call that cannot start by then, because no VM is free or the isolate is busy, is refused without
    running: HTTP 503 with `Retry-After: 1` and `{ ok: false, refused: "busy", error }` (`BUSY_REFUSAL` in
    `call-runner.ts`). A refusal is not a failure and opens no incident. Reruns of an admitted call are exempt. The
    longest wait is one second plus one call's service time, because a single-threaded isolate sees a late call only
    when the call before it ends (`performance.md`, finding 7, bead `pw-djz.3`).
  - Each running call costs a VM of about the snapshot's size: 2.4 MB of the server for a world whose snapshot is
    1.4 MB, against about 25 MB for the world's own isolate (research, "Memory per world").
  - The isolate is single-threaded: calls overlap only while they await another world, and a call or a change that
    computes holds the isolate until it returns.
  - Isolates are not cores. On the node (2 vCPUs), a call computing in one world adds 16 to 65 ms to another world's
    p99, a flood of 200 cheap calls/s into one world about 90 ms, and a computing develop 14 to 23 ms
    (`performance.md`, finding 10).
- **Calls between worlds are request and response over Durable Object RPC.** World code calls
  `worlds.call(id, name, ...args)` and gets a QuickJS promise; the evaluation step ends, the runtime asks its
  `WorldHost`, which sends `peerCall` to the other world's cell, and that cell runs the call in the other world's own
  isolate. `WorldVm.settle` waits outside the VM, then resolves the promise and runs the waiting code. Consequences:
  - Calls awaited together overlap (`Promise.all` of two 200 ms calls takes about 200 ms, `test/peers.test.ts`).
  - A waiting call holds a VM in each world on its chain, so a cycle could use up a world's VMs and wait for its own.
    The chain travels with the call and a call back into a world on it is refused (`chainedPeers`). A chain is at
    most four worlds.
  - Nothing is durable: no queue, no retry, no idempotency key. A caller that crashes mid-call loses the call; data
    the callee wrote stays. A callee that does not answer within 30 s fails the call (`PEER_DEADLINE_MS`).
  - A world calls only the worlds its owner granted (`Grants`, "any" until restricted). The grant travels with each
    call into the world's runtime isolate, where `grantedPeers` wraps the peers that world code reaches, so world code
    cannot widen it; `worlds.list()` shows only granted worlds.
  Open decision 14 is what calls between worlds should be.
- **Portable core.** No `node:` modules in the core: celld's Node compatibility is "Partial", and Node-only code sits
  behind separate exports. The `.wasm` import comes from the bundle; the host passes the compiled module in.
- **Streaming cadence.** A one-node fleet proves every durable write in the bucket: on the node, writing calls take
  p50 164 to 170 ms and p99 303 ms at 50/s (`performance.md`, finding 8), and viewer output is held until its write
  is durable.
  pi-durable's default 100 ms progress commits will show as streaming lag. Tune `settings.progress` against
  measurements.
