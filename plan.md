# pi-world: plan

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
