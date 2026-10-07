# pi-world: design constraints

The rules the implementation obeys, each with the fact that forces it.

- **Two commits, one store.** A durable tool can't put its result entry and the world revision in one commit. The
  tool's `api.commit()` runs inside `execute()`, and the Harness appends `pi.tool-result` in a later commit
  (pi-durable spec §8.4). Recovery handles this: the revision manifest records the producing `taskId`/`callId`, and a
  rerun that finds its own revision returns the same answer. Tools are therefore `replay: "safe"`.
- **Revisions go in documents, not raw entries.** Raw appends into a busy conversation "can misplace its system prompt
  entries" (spec §12). Use session-scoped docs: `WorldHead` (singleton) and `WorldRevision` (a family).
- **Write blobs first, then commit the pointer.** Each snapshot is one content-addressed blob in the cell's SQLite,
  gzipped with `gzipSync`, written idempotently before the durable commit, which commits only the manifest and
  pointer. A crash can leave orphan blobs, but never a pointer to a missing blob. Page-level dedupe between
  revisions, and moving old pages to R2, come later (`plan.md`, milestone 9).
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
- **Checks live outside the world.** Invariants and goals are not world code. Their sources are stored on the host
  side, in a `WorldChecks` document, outside the heap. The host evaluates them in the VM after each attempt. No host
  function lets world code read or write them, so a `develop` cannot change a check. jiti keeps its checks with the
  caller for the same reason; there the wall is a filter over the submitted form, here it is the sandbox boundary.
- **A check is enrolled only after it has been seen failing.** The agent proposes a check through its own tool,
  with a counterexample: a small change to the world that the check must reject. The host applies the counterexample
  on a checkpoint, requires the check to fail there, restores, and requires it to pass on the current world. Only
  then is it enrolled. Removing or loosening a check is an operator call with a recorded reason, never an agent
  tool.
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
  alone, so host code cannot leak into it. Develops and checks stay on the cell's main VM: they touch no data and are
  bounded by the time budget. Snapshots reach a runner by content hash from the blob store, so `World` does not
  serve them.
- **`execute` is a preview.** Its data writes go to an overlay that is dropped afterwards (`OverlayDataPort`), and
  the result lists them. An overlay rather than a SQL transaction, because an evaluation can span awaits.
- **Snapshots are tiered.** The head's blob stays in the cell's SQLite; every other blob moves to R2, gzipped, and the
  local copy is deleted only once R2 holds it (`TieredBlobStore`). A pass runs when the head changes; requests during
  a pass collapse into one more. Blobs are content-addressed, so a key never needs
  rewriting and identical snapshots of different worlds share one object.
- **Calls run concurrently, each on its own VM; changes run one at a time on the main VM.** A call takes a VM from the
  world's pool (`VmPool`, 8 by default), restored from the head the call started at, and keeps it until it settles.
  A develop, rollback, check or upgrade holds the world's lock and uses the main VM, which is always at the head
  between changes. One VM cannot serve two calls at once: two evaluations would share one heap, and resetting it after
  one would wipe the other. Consequences:
  - A call that awaits another world does not block the world's other calls or its changes
    (`test/concurrency.test.ts`).
  - A call that started before a new revision finishes on the old one.
  - Data is shared and not isolated: calls interleave at their awaits.
  - Each running call costs a VM of about the snapshot's size (1.4 MB for a small world).
- **Calls between worlds are request and response over Durable Object RPC.** World code calls
  `worlds.call(id, name, ...args)` and gets a QuickJS promise; the evaluation step ends, the host sends `peerCall` to
  the other world's cell, waits outside the VM, then resolves the promise and runs the waiting code
  (`WorldVm.settle`). Consequences:
  - Calls awaited together overlap (`Promise.all` of two 200 ms calls takes about 200 ms, `test/peers.test.ts`).
  - A waiting call holds a VM in each world on its chain, so a cycle could use up a world's VMs and wait for its own.
    The chain travels with the call and a call back into a world on it is refused (`chainedPeers`). A chain is at
    most four worlds.
  - Nothing is durable: no queue, no retry, no idempotency key. A caller that crashes mid-call loses the call; data
    the callee wrote stays. A callee that does not answer within 30 s fails the call (`PEER_DEADLINE_MS`).
  - Any world may call any world; there is no permission model.
  Open decision 14 is what calls between worlds should be.
- **Portable core.** No `node:` modules in the core: celld's Node compatibility is "Partial", and Node-only code sits
  behind separate exports. The `.wasm` import comes from the bundle; the host passes the compiled module in.
- **Streaming cadence.** Each durable write takes about 90 ms, and viewer output is held until its write is durable.
  pi-durable's default 100 ms progress commits will show as streaming lag. Tune `settings.progress` against
  measurements.
