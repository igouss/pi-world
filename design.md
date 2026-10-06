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
