# pi-world: performance

pi-world's limits as measured, against the objectives the operator approved, and what each finding rests on. The
harness that produced every number here is `perf/` (perf/README.md); a result file is named after its scenario and
start time under `perf/results/<target>/`, and every claim below names the file and the build it measured.

Where a number comes from:

- **node**: oracle-arm (aarch64 Neoverse N1, 2 vCPUs, 12 GB, celld 0.6.1 in podman, one node, bucket
  `gs://pi-world-celld`), shared with about twenty other services; client in a `node:25-slim` container on the node,
  over loopback. Builds: `81f37aa` (as deployed before this review), `f177479-dirty` (after the first fixes), `83f5643`
  (current).
- **dev**: `celld dev` 0.6.1 on an x86-64 desktop (31 GB), client on loopback. Its absolute latencies are lower than
  the node's; it is used for proofs of concept and profiles, and its verdicts judge dev, not the node.

## Objectives

Approved 2026-10-14 (bead `pw-djz`); the numbers live in `perf/objectives.ts`.

| Id | Objective | Number |
|---|---|---|
| O1a | Direct call, read-only, warm, at the O6a rate | p50 ≤ 10 ms, p99 ≤ 50 ms |
| O1b | Direct call writing one key, warm, at the O6b rate | p50 ≤ 120 ms, p99 ≤ 250 ms |
| O1c | Cold call, the first after eviction | p99 ≤ 1 s |
| O2 | Chain of three worlds, read-only, 10 calls/s | p50 ≤ 30 ms, p99 ≤ 100 ms |
| O3 | Develop with P plain and Q property checks | p50 ≤ 150 + 10P + 300Q ms, p99 ≤ twice that |
| O4 | Stall one world may cause another | victim's p99 rises ≤ 50 ms |
| O5a | Resident worlds per node | ≥ 300 |
| O5b | Registered worlds per node, mostly evicted | ≥ 5 000, O1c holding |
| O5c | 100 resident worlds at 5 calls/s each | O1a holding |
| O6a / O6b | Sustained read-only / writing calls per world | ≥ 100/s / ≥ 50/s |
| O7 | Errors at or below the rated rate | none |
| O8 | Twice the rated rate | excess refused within 1 s; no wait over 1 s; accepted keep p99 |
| O9 | One operation is bounded | nothing holds a resource over 5 s |

## Where it stands on the node

| Objective | 81f37aa (before) | f177479 (after) | Result files |
|---|---|---|---|
| O1a read call, 100/s | p50 5.2, p99 **119** ms | p50 3.2, p99 **59.6** ms | `node/read-call-…020102Z`, `…022237Z` |
| O1a good calls beside 50 failures/s | p50 **127**, p99 **460** ms | p50 3.2, p99 43 ms | `node/failure-storm-…020859Z`, `…023355Z` |
| O1b write call, 50/s | p50 **170**, p99 **303** ms | p50 **164**, p99 **303** ms | `node/write-call-…020213Z`, `…022348Z` |
| O1c cold call (20 evictions) | not run (harness had no curl) | max 491 ms | `node/cold-call-…023249Z` |
| O2 chain of three, 10/s | p50 14, p99 92 ms | p50 8.7, p99 99 ms | `node/chain-…020324Z`, `…022459Z` |
| O3 develop, no checks | p50 **198** ms | p50 **200**, p99 **305** ms | `node/develop-…020438Z`, `…022613Z` |
| O3 develop, 10 property checks | not run (no REST route then) | p50 281, p99 611 ms | `node/develop-…022613Z` |
| O4 develop computing elsewhere | victim p99 **+464** ms | +23 ms | `node/stall-…020525Z`, `…022952Z` |
| O4 call computing elsewhere | **+129** ms | **+65** ms | same |
| O4 world flooded with 200 calls/s | **+59** ms | **+98** ms | same |
| O5a resident worlds | not run on the node (it would use up all 255 slots until a restart) | — | dev: `dev/worlds-…011908Z` |
| O6a / O6b | 100/s and 50/s held with no failure | same | read-call, write-call |
| O8 200/s into one world | accepted p99 **246** ms | accepted p99 **61** ms | `node/overload-…020823Z`, `…023319Z` |
| O8 computing calls at 2× capacity | accepted waited up to **3.3 s** | **1.34 s**; refusals at 1.2 s | `node/slow-overload-…021010Z`, `…023616Z` |
| O9 | every measured operation under 5 s | same | stall, develop |
| correctness: 20 concurrent read-await-write increments | count **3** | count right, but **8 refused** busy (a bug, since fixed) | `node/lost-update-…020057Z`, `…022232Z` |

Bold is a violation. O5b and O5c were not run: not verified.

The `f177479` build still had a bug that refused reruns at once (finding 1), so three scenarios ran again on the
current build `83f5643` (`node/lost-update-…024549Z`, `node/slow-overload-…024554Z`, `node/stall-…024624Z`):

| Objective | 83f5643 |
|---|---|
| correctness: 20 concurrent read-await-write increments | 20 of 20 succeeded, count 20 |
| O8 computing calls at 2× capacity | accepted waited up to **1.25 s**; refusals at **1.08 s** |
| O4 call computing elsewhere | +16 ms |
| O4 world flooded with 200 calls/s | **+89 ms** |
| O4 develop computing elsewhere | +14 ms |
| O4 develop with 3 property checks elsewhere | +4 ms |

## Workload model

The node's traffic is too thin to give rates: celld logs no requests at INFO, its metrics are blackbox probes only, and
the nine days of celld events in VictoriaLogs (2026-10-05 to 2026-10-14, 21 325 events) show deploys, restores and
six overload refusals, not a call pattern. The workload therefore takes its shape from the four live worlds and its
rates from the objectives. The live worlds have 2 to 9 small functions, 0 to 2 data rows, one plain check, no
incidents, and a 1.44 MB snapshot each (the QuickJS linear memory; 123 KB of it is heap). Dashboard → Trip budget →
Currency is a real chain of three worlds. `perf/lib/fixtures.ts` replays their sources.

## Capacity per resource

Each prediction was written before its measurement; a miss is a finding.

| Resource | Prediction | Measured | |
|---|---|---|---|
| Shared cell isolates (up to 32 cells per V8 isolate, celld `runtime.rs:438`) | A develop computing for S s in one cell holds every cell of its isolate for S: the victim waits a residual of S | dev: develop 1.7 s at 1/s raised an unrelated world's p99 by 2.6 s (utilization over 1, so it queued) | hit |
| One facet isolate per world | A call's isolate CPU is restore + evaluate ≈ 2.5 + 0.1 ms, so capacity ≈ 1/S ≈ 300 calls/s | Node bench `perf/bench/call-path.ts`: 3.4 ms per call. celld dev: about 7 ms of celld CPU per call in all isolates at 100/s; the facet is 40 % of it | missed: the facet is less than half of a call's cost; the per-event cost of celld and three hops is the rest |
| Facet isolates on a 2-core node | Separate isolates isolate CPU (README) | node: a call computing in one world raised another's p99 by 129 ms (65 after); a flood of cheap calls by 59 to 98 ms | missed: isolates are not cores |
| VM pool (8 per world) | Little: calls in flight N = X·R; a world whose calls wait R = 300 ms on a peer serves at most 8 / 0.3 ≈ 27 calls/s | `test/concurrency.test.ts`: 3 calls of 300 ms through 2 VMs took 2 × 300 ms | hit |
| Cell SQL queue and durable commits | If commits serialize at the bucket's round trip (~90 to 150 ms), a world records at most ~7 incidents/s, so failing calls queue | node: 50 failing calls/s answered with no timeout (p99 485 ms); instead every response of the cell waited for the bucket | missed: commits share uploads; the cost is the output gate, which holds every response of the cell |
| Durable writes to the bucket | If writes of one world serialize, O6b ≈ 1 / 0.09 ≈ 11/s | node: 50 writes/s, no failure, p50 164 ms; N = X·R ≈ 8 in flight | missed: concurrent writes share one upload (celld docs, testing page) |
| celld per-cell request limit (64) | Little: refusals start when X·R > 64; computing calls at 2× capacity build a backlog of seconds | dev: 225 of 407 refused with `503 cell request limit reached`, accepted calls waited up to 8.3 s | hit; pi-world now refuses first (O8) |
| Loaded workers per process (256; 255 per script and generation, celld `js.rs:7252`) | One per world, released only when its handle is collected, so a node holds at most 255 worlds that have run something since the last deploy, forgotten ones included | dev: world 239 of the run failed, after 16 worlds of earlier runs on the same server: `too many loaded workers for script "pi-world" in generation 1 (limit 255)` | hit; research.md's "about five hundred worlds" was wrong |
| Memory | 16 MB per world on the node (research.md), so ~500 in 9 GB | dev: 4.36 GB at 255 worlds (17 MB each); with `CELLD_IDLE_EVICT_S=5`, 320 worlds peaked at 2.1 GB | the loaded-worker limit binds first |

## Profiles

Linux `perf` at 499 Hz on celld dev's server process, from a celld 0.6.1 built from source to accept
`CELLD_V8_FLAGS=--perf-basic-prof` (frame pointers kept), so JavaScript and WebAssembly frames are named. Folded stacks,
flame graphs and summaries are in `perf/profiles/`.

- **A read-only call at 100/s, as deployed** (`read-call-2026-10-14T012818Z`, 7525 samples in 20 s): `QuickJS.restore`
  31.4 % of all of celld's CPU, of which WebAssembly instantiation 22.2 %; fresh memory and copies 11.9 %; GC 11.0 %;
  QuickJS executing the call 6.1 %. 40.5 % of the samples ran under the facet's runtime bundle, 4.9 % under the
  cell's.
- **The same after the in-place rewind** (`read-call-2026-10-14T013340Z`, 3932 samples): the rewind's 1.4 MB copy
  8.8 %, QuickJS 7.9 %; 56.5 % of samples carry no JavaScript at all: celld's turn driving (`drive_cell_inner` 14.1 %),
  its storage bookkeeping (`celld_ltx::db` 6.7 %, SQLite 4.2 %) and HTTP, paid on each of a call's three hops
  (Worker → cell → facet).
- **Develops with checks** (`develop-2026-10-14T013843Z`, 13 144 samples, in the shared cell isolate as deployed):
  gzip of the archived snapshot 17.4 % plus about 16 % of CompressionStream's JavaScript plumbing; celld's replication
  of the blob write 17.1 %; SQLite 13.4 %; the SHA-256 of the 1.4 MB snapshot 10.0 %; QuickJS evaluating the develop
  and its checks 10.4 %. The checks are not what a develop costs; the snapshot is.

## Findings

Ranked by the objective they violate and how far. "Fixed" means fixed in code and measured where it says; each has a
bead.

1. **Concurrent calls lost updates (correctness). Fixed.** `OverlayDataPort.commit` wrote blindly
   (`git show a781c76:src/world/overlay-data-port.ts`, line 47): 20 concurrent calls that read a key, awaited another
   world and wrote it all succeeded and left the count at 3 (node `lost-update-…020057Z`, dev likewise). Calls now
   record their reads and validate them at commit; a stale call reruns in a per-world lane, one at a time
   (`src/world/local-call-runner.ts`, `src/world/overlay-data-port.ts`). A rerun repeats the calls it made to other
   worlds. The first version of the fix retried all at once and failed 10 of 20 as conflicts; a second bug refused
   reruns at once (`setTimeout(Infinity)` fires immediately); both are fixed with tests. Bead `pw-rxw.2`.
2. **A node holds at most 255 worlds per deploy (O5a).** Each world's runtime is a Dynamic Worker with its own loader
   id (`src/isolate/host/runtime-loader.ts:14`); celld allows 255 per script and generation (`js.rs:7252-7255`) and
   releases one only when its handle is collected. Nothing evicts an idle cell on the node (`CELLD_IDLE_EVICT_S` is
   unset), and `DELETE /api/worlds/:id` only forgets the directory entry (`src/worker.ts:32`), so even forgotten worlds
   hold their slot. Bead `pw-djz.9`. Under celld dev world 239 of the run failed at creation, after 16 worlds of earlier runs on the same server, (`dev/worlds-…011908Z`); with
   `CELLD_IDLE_EVICT_S=5`, 320 of 320 opened and answered and the server peaked at 2.1 GB instead of 4.36 GB
   (`dev/worlds-…022242Z`); the node's cold call after an eviction took at most 491 ms (O1c holds). Operator
   decision.
3. **A develop in one world stalled every world sharing its isolate (O4, O9). Fixed.** Develops, checks, rollbacks
   and upgrades ran on a main VM in the world's cell (`git show a781c76:src/world/world.ts`, line 169), in a V8 isolate
   shared with up to 31 other cells. dev: a develop computing 1.7 s at 1/s raised an unrelated world's p99 by 2.6 s;
   node: +464 ms. All VM work of a change now runs in the world's own runtime isolate behind a `Workbench` port
   (`src/world/workbench.ts`, `src/world/local-workbench.ts`); dev +35 ms, node +23 ms. Bead `pw-rxw.3`.
4. **Failing calls slowed the good calls of their world (O1a). Fixed.** Each repeat of an incident was a durable
   commit in the cell (`git show a781c76:src/incident/incident-log.ts`, line 73), and celld holds every response of
   a cell until a durability proof covers it. Node: next to 50 failing calls/s a good call's p50 went from 4.8 to
   127 ms and its p99 to 460 ms. Two controls showed the cause: failures that record nothing, and data writes in the
   facet, cost nothing. Repeats now count in memory and are written together at most every 30 s
   (`src/incident/incident-log.ts`); node: p50 3.2, p99 43 ms. Bead `pw-rxw.5`.
5. **Every call rebuilt a WebAssembly instance (O1a, O6a, O8). Fixed.** `VmPool.recycle` restored each VM through
   `QuickJS.restore` (`git show a781c76:src/world/vm-pool.ts`, line 71), 31.4 % of celld's CPU. A pooled VM is now
   rewound by copying the snapshot over its own memory (`src/world/quickjs-rewind.ts`), which a property test checks
   against a fresh restore. dev at 100/s: p99 31 → 12 ms, CPU 70 → 37 % of a core; node: p99 119 → 60 ms, CPU 42 →
   23 %. Bead `pw-djz.1`.
6. **The node's read-call p99 is still 59.6 ms at 23 % CPU (O1a).** Not explained: celld is not CPU-bound, and the
   2-core node runs about twenty other services. Not verified: a profile on the node (the profiling build is x86).
   Bead `pw-djz.2`.
7. **A busy world queued calls without bound (O8). Partly fixed.** `VmPool.slot` waited without a deadline
   (`git show a781c76:src/world/vm-pool.ts`, line 86), and a world whose isolate was saturated queued calls until
   celld's 64-request limit refused them: accepted calls waited up to 8.3 s (dev), 3.3 s (node). Every call now
   carries a start deadline a second after the cell received it, and is refused as busy (503, `Retry-After`, no
   incident) if it cannot start by then (`src/world/call-runner.ts`, `src/world/local-call-runner.ts`). The longest
   wait fell to 1.17 s (dev) and 1.25 to 1.34 s (node): one second plus one call's service time, because a single-threaded
   isolate sees a late call only after the call before it ends. Meeting O8 exactly needs admission predicted in the
   cell. Bead `pw-djz.3`.
8. **Writes wait for the bucket (O1b).** A one-node fleet proves every write in the bucket (celld docs; node logs:
   "fleet durability requested and no peer is available; writes wait for the bucket"). node: p50 164 to 170 ms, p99
   303 ms, unchanged by any fix. A second node would prove writes on its disk (celld documents about 25 ms against
   about 600 ms in its lab). Operator decision. Bead `pw-djz.4`.
9. **Every revision writes, hashes and archives the whole 1.4 MB memory (O3).** `World.accept` stores one blob per
   revision (`src/world/world.ts`, `accept`), and the archive gzips the previous one in the shared cell isolate
   (`src/revision/tiered-blob-store.ts`). A develop with no checks costs about 200 ms on the node (O3's base is
   150 ms). Over 22 revisions of the node's own sources, 4 KB content-addressed pages would write 65 KB per revision
   instead of 1408 KB (`perf/bench/snapshot-pages.ts`). Bead `pw-djz.5`.
10. **Isolates are not cores (O4).** On the 2-core node, a flood of 200 cheap calls/s into one world raised another
    world's p99 by 59 ms before the fixes and 89 to 98 ms after (`node/stall-…020525Z`, `…022952Z`, `…024624Z`); a call
    computing in one world by 129 ms before, 16 to 65 ms after. README's "worlds do not slow
    each other" holds for CPU-light work on a machine with spare cores. celld has no CPU quota per isolate. Bead
    `pw-djz.6`.
11. **What a develop still does in the shared cell isolate (O4).** Storing the blob and gzipping the archive run in
    the cell: dev, a develop with 3 property checks raised another world's p99 by 73 ms after the workbench move.
    Bead `pw-djz.7`.
12. **The time budget counts interrupt ticks (O9).** Known (research.md, open check 11): a budget is not a time. Bead
    `pw-rxw.4`.
13. **Forgotten worlds stay resident (O5a).** `DELETE /api/worlds/:id` removes the directory entry and nothing else,
    so the cell, its facet and its loaded-worker slot stay. Bead `pw-djz.8`.
14. **A failing definition with a varying message opens a new incident per message.** The incident key includes the
    error's first line (`src/incident/incident.ts:47`), so `"no item " + id` commits once per id. Grouping by
    definition and failure kind is the operator's decision; it changes tests that expect a new incident per message.
    Bead `pw-rxw.5`.

## The concurrency protocol, model-checked

See `spec/tla/README.md` for the TLA+ model of develop, call, commit, the VM pool and the data overlay, the seeded
bugs TLC found, and the results table. Status when this file was written: in progress; whatever that README does not
list as checked is not verified.

## Not verified

- O5b (5 000 registered worlds) and O5c (100 worlds at 5 calls/s each): no scenario ran.
- The worlds scenario on the node: excluded, because it would use up all 255 loaded-worker slots until a restart.
- Develop percentiles: each point has 10 to 20 develops (one every two seconds for 40 s), so its p99 is its maximum.
- Profiles on the node: the profiling celld was built for x86-64 only.
- Calls between worlds across nodes: one node.
