# WorldConcurrency: a TLA+ model of a world's concurrency

`WorldConcurrency.tla` models one world as the code runs it. Changes (develop, rollback) run on one VM under the
world's lock; calls run on pooled VMs in the world's runtime facet, over the facet's data. TLC checks it in every
configuration here. `check.sh` (`npm run tla`) runs them all and fails when a result differs from the one it
expects. It needs the TLA+ tools' `tlc` on `PATH`, and takes about 40 minutes.

## Versions

`Version` picks the code the model follows:

| `Version` | Code | Calls | Pool |
|---|---|---|---|
| `deployed` | commit `a781c76` | `OverlayDataPort.commit` commits blindly on success | waits for a VM without bound |
| `fixed` | commit `808bd57` | `commitIfUnchanged` validates what the call read in the commit's transaction; a read-only call is validated when it crossed an await; a stale call reruns in a lane of its own, one at a time, at most `RUNS` times, then fails as `conflict` | a first run waits at most until its start deadline, then is refused as `busy`; a rerun has no deadline and no timer |

In `fixed`, changes do their VM work on a Workbench in the facet, which returns to the head blob the cell names
before each operation (`LocalWorkbench.atBlob`). In `deployed` they use the main VM in the cell, which `accept`
resets after a failed commit. So `deployed` checks `MainAtHead`, and `fixed` checks `WorkbenchAtHead` instead.

`file:line` references below are to `a781c76` for `deployed` and to the `fixed` code above; a function name is given
where the fixed code moved.

## Granularity

Each action is one synchronous stretch of JavaScript between two `await`s. JavaScript is single-threaded per
isolate, so such a stretch is atomic. The cell and the facet are separate isolates that meet only by RPC, which is
an `await`; they share no memory. The facet reads snapshot blobs from the cell by content hash, and only the facet
touches the world's data.

`Scheduling` chooses what may run at an `await`:

- `"await"`: any process. This over-approximates the code, so a property that is green here holds under any
  scheduling. Every configuration except `deployed-event-loop` and the deployed property 5 ones uses it.
- `"event-loop"`: the facet's event loop. A facet step that begins a task runs only when no continuation is queued
  as a microtask. Such a step is an RPC arriving with its snapshot, a peer's answer, or a timer firing. The steps
  after it are microtasks: `slot`, `takeIdle`, `open`, the evaluation, the returns up to the commit, a recycle's
  reset, the rerun lane, and a rerun's cached snapshot.
  - Calls that awaited the same pending snapshot promise resume in the one task that settles it.
  - `QuickJS.restore` settles before the next task in Node (measured: it resolves before a `setTimeout(0)`).
  - Microtask FIFO order is not modelled; the property 5 counterexamples were checked by hand against it.
  - Cell steps are not constrained, because the cell is another isolate.

## Actions

| Action | Code (deployed, `a781c76`) | Fixed, where it differs |
|---|---|---|
| `ChLock` | `World.exclusive`, world.ts:339-341, over `Mutex.run`, mutex.ts:5-12 | |
| `ChAttempt` (develop) | `attemptDevelop` on the main VM, world.ts:169 | `Workbench.develop`, world.ts:165, which first returns to the head blob, local-workbench.ts:36-41, 61-68 |
| `ChAttempt` (rollback) | world.ts:191-192: the target revision; throws when it is the head | |
| `ChChecks` | the checks inside `attemptDevelop` (its awaits at attempt.ts:38-60); accept or reject | |
| `ChRejReset`, `ChRejCommit` | attempt.ts:44 resets the main VM; `World.reject` commits the record, world.ts:172, 379-394 | |
| `ChRbFetch`, `ChRbReset` | `requireBlob` and `vm.reset`, world.ts:193-195 | |
| `ChPut` | `accept`: `await this.deps.blobs.put`, world.ts:353; then `n`, world.ts:354 | world.ts:334-335 |
| `ChCommit` | the durable commit with the head-moved check, world.ts:357-365; it may fail | world.ts:338-346 |
| `ChPublish` | `this.current = head`, world.ts:366-371; the lock is released | world.ts:347-351 |
| `ChFailReset` | the catch, world.ts:372-374: the main VM back to `headSnapshot` | no catch: the VM stays where it is |
| `CStart` | `World.run` takes `scope()` from `this.current`, world.ts:243, 408; the RPC, facet-call-runner.ts:11, runtime-facet.ts:36 | world.ts:227, 383 (adds the start deadline) |
| `CFetch` | `await this.snapshotOf(head)`, local-call-runner.ts:71, 75-86; `VmPool.run` up to its first await: `newest`, vm-pool.ts:35-36, `slot`, vm-pool.ts:81-87 | local-call-runner.ts:98-103: a first run past its deadline is refused as busy; vm-pool.ts:46-48, 93-111 |
| `CTimeout` | none | the waiter's timer, vm-pool.ts:105-108: leaves the queue, refused as busy |
| `CTakeVm` | `takeIdle`, vm-pool.ts:40, 52-59 | vm-pool.ts:51, 63-70 |
| `COpen` | `await this.open(head.snapshot)`, vm-pool.ts:40 | vm-pool.ts:51 |
| `CEval` | `WorldVm.settle`'s first steps, world-vm.ts:204-212: `data.get` through the overlay, overlay-data-port.ts:20-22; a call that does not await also writes (or, a reader, reads `w`) here | `readBase` records the read, overlay-data-port.ts:79-83; a call to another world marks the overlay `crossedAwait` (`awaitsNoted`, local-call-runner.ts) |
| `CPeer` | the await on other worlds, world-vm.ts:215, and the next step, which writes or throws | |
| `CRet` | `return await body(vm)`, then `recycle` up to its first await, vm-pool.ts:41-43, 62-70 | vm-pool.ts:52-54, 73-81 |
| `CCommit`, `CCommit2` | `if (outcome.ok) writes.commit()`, local-call-runner.ts:41-42; `OverlayDataPort.commit`, overlay-data-port.ts:47-55, one `transactionSync`, sql-data-port.ts:25 | `commitIfUnchanged`, overlay-data-port.ts:59-75, 85-89 (a reader: lines 60-63); stale: local-call-runner.ts:58-69 |
| `CLane` | none | `this.reruns.run`, local-call-runner.ts:64: the rerun lane, one rerun at a time |
| `RReset` | the rest of `recycle` and `free`, vm-pool.ts:71-78, 89-94 | `vm.rewind`, vm-pool.ts:82-89; `free`, vm-pool.ts:115-123 |
| `Crash`, `Restart` | the cell is evicted; `World.open` reads the durable head and requires its blob, world.ts:94-104, 426-430 | |

## Properties

| # | Name | What it says |
|---|---|---|
| 1 | `WritesAllOrNone` | a call's writes are all made or none are |
| 1 | `RowsFromOneCommit` | the two rows a call writes always come from the same call's commit |
| 1 | `FailedWritesNothing` | a failed call (`fail`, `busy`, `conflict`) leaves no write |
| 1 | `ConflictWritesNothing` | fixed: a call that ran out of reruns leaves no write |
| 2 | `HeadBlobPresent` | every committed revision's blob, the head's included, is in the blob store |
| 2 | `AcceptedKept` | an accepted change's revision stays in the history with its heap |
| 2 | `OneCommitPerRevision` | two changes never commit the same revision number |
| 2 | `HistoryKept` | action property: the head never moves back, a committed revision never changes, the head moves only to a committed revision |
| 2 | `MainAtHead` | deployed: between changes the main VM is at the head (world.ts:61-62) |
| 2 | `WorkbenchAtHead` | fixed: the workbench VM is at the head blob whenever a change starts its attempt |
| 3 | `CallsOnCommittedHeaps` | a call evaluates on a committed revision's heap, the one of the revision it started at |
| 3 | `CurrentIsCommitted` | `World.current`, which calls start from, is a committed revision |
| 4 | `SlotsBounded` | the pool's `active` counts exactly the slot holders and never exceeds `Max` |
| 4 | `HandedAtAskedRevision` | an idle VM handed to a call is at the revision the call asked for |
| 4 | `RefusedNeverGranted` | fixed: a refused waiter never gets a slot afterwards |
| 4 | `WaitingCallFinishes` | liveness, under weak fairness, without crashes: a call that entered the pool finishes |
| 4 | `WaitingResolved` | fixed, liveness: a waiting call is granted a slot or refused |
| 4 | `VmsExistBounded` | vm-pool.ts:18, "at most `max` VMs exist", counting idle VMs too |
| 5 | `NoLostUpdate` | the counter equals the number of calls that committed an increment |
| 5 | `Serializable` | every commit read exactly what the commits before it left, so commit order is a serial order of the successful calls |
| 5 | `ReadsExisted` | a successful read-only call answered a state the rows held at some moment |

A writing call reads the counter `n`, then writes `n + 1` and its own id into `w`. A read-only call (`Readers`)
reads `n`, then `w`, and answers both. A call that awaits (`AwaitPeer`) awaits a peer between the two steps; one
that does not does both in one step. Any call may fail.

## Seeded bugs

Each property was first seen red on a bug seeded through `Bug`, in the version it is checked in:

| `Bug` | What changes |
|---|---|
| `partial-commit` | the overlay's writes are made one at a time, with an await between them |
| `commit-on-failure` | a failed call's overlay is committed |
| `commit-before-blob` | the head is committed before its blob is written |
| `unguarded-commit` | no lock and no head-moved check |
| `head-before-commit` | `World.current` moves before the commit succeeds |
| `main-vm` | a call evaluates on the change VM |
| `slot-off-by-one` | `slot()` admits a call when `max` slots are taken |
| `idle-any-revision` | `takeIdle` hands out an idle VM at any revision |
| `no-free` | a recycled VM that is dropped does not free its slot |
| `free-drops-waiter` | `free()` releases the slot without waking the waiting call |
| `no-validate` | fixed: the commit does not validate what the call read |
| `conflict-commits` | fixed: a call out of reruns commits anyway |
| `timeout-keeps-waiter` | fixed: a timed-out waiter stays in the queue |
| `timeout-no-grant` | fixed: a timed-out waiter leaves the queue but is never answered |
| `skip-readonly-validation` | fixed: a read-only call is not validated even when it awaited (the code before 808bd57) |
| `workbench-trusts-vm` | fixed: the workbench uses its VM as it is, not at the head blob it is named |

## Results

`sh spec/tla/check.sh`, TLC 2.19, one worker, about 40 minutes; it exited 0:

| Config | Version | `Bug` | Result | States generated | Distinct | Trace | s |
|---|---|---|---|---:|---:|---:|---:|
| deployed | deployed | none | green | 966754 | 391468 | - | 35 |
| deployed-wait | deployed | none | green | 563796 | 250393 | - | 23 |
| deployed-event-loop | deployed | none | green | 461036 | 211076 | - | 19 |
| deployed-liveness | deployed | none | green | 826537 | 304149 | - | 605 |
| deployed-pool-vm-count | deployed | none | green | 16365968 | 5398477 | - | 394 |
| deployed-p5-await | deployed | none | `NoLostUpdate` violated | 18414 | 7639 | 18 | 4 |
| deployed-p5-noawait | deployed | none | `NoLostUpdate` violated | 15583 | 6381 | 15 | 3 |
| deployed-p5-serializable | deployed | none | `Serializable` violated | 18414 | 7639 | 18 | 4 |
| fixed | fixed | none | green | 1516323 | 618480 | - | 56 |
| fixed-wait | fixed | none | green | 834610 | 364550 | - | 32 |
| fixed-p5 | fixed | none | green | 3191338 | 1247546 | - | 92 |
| fixed-p5-noawait | fixed | none | green | 2666452 | 1087787 | - | 74 |
| fixed-liveness | fixed | none | green | 487756 | 193541 | - | 619 |
| fixed-readonly | fixed | none | green | 2724821 | 1067335 | - | 71 |
| deployed-readonly | deployed | none | `ReadsExisted` violated | 4860 | 1967 | 16 | 3 |
| bug-partial-commit | deployed | partial-commit | `WritesAllOrNone` violated | 756 | 355 | 8 | 2 |
| bug-partial-commit-rows | deployed | partial-commit | `RowsFromOneCommit` violated | 756 | 355 | 8 | 2 |
| bug-commit-on-failure | deployed | commit-on-failure | `FailedWritesNothing` violated | 747 | 351 | 8 | 2 |
| bug-commit-before-blob | deployed | commit-before-blob | `HeadBlobPresent` violated | 212 | 139 | 6 | 2 |
| bug-unguarded-commit | deployed | unguarded-commit | `OneCommitPerRevision` violated | 7843 | 2807 | 11 | 2 |
| bug-unguarded-accepted | deployed | unguarded-commit | `AcceptedKept` violated | 12813 | 4439 | 12 | 2 |
| bug-unguarded-history | deployed | unguarded-commit | `HistoryKept` violated | 7843 | 2807 | 11 | 3 |
| bug-unguarded-main | deployed | unguarded-commit | `MainAtHead` violated | 100 | 57 | 5 | 2 |
| bug-head-before-commit | deployed | head-before-commit | `CallsOnCommittedHeaps` violated | 1637 | 798 | 10 | 2 |
| bug-head-before-commit-current | deployed | head-before-commit | `CurrentIsCommitted` violated | 58 | 37 | 5 | 2 |
| bug-main-vm | deployed | main-vm | `CallsOnCommittedHeaps` violated | 536 | 266 | 8 | 2 |
| bug-slot-off-by-one | deployed | slot-off-by-one | `SlotsBounded` violated | 123 | 71 | 5 | 2 |
| bug-idle-any-revision | deployed | idle-any-revision | `HandedAtAskedRevision` violated | 15106 | 6196 | 17 | 3 |
| bug-no-free | deployed | no-free | `SlotsBounded` violated | 6998 | 2834 | 13 | 3 |
| bug-free-drops-waiter | deployed | free-drops-waiter | temporal property violated | 4590 | 1968 | 17 | 5 |
| fixed-bug-partial-commit | fixed | partial-commit | `WritesAllOrNone` violated | 1077 | 481 | 8 | 2 |
| fixed-bug-commit-on-failure | fixed | commit-on-failure | `FailedWritesNothing` violated | 1067 | 476 | 8 | 2 |
| fixed-bug-commit-before-blob | fixed | commit-before-blob | `HeadBlobPresent` violated | 268 | 170 | 6 | 2 |
| fixed-bug-unguarded-commit | fixed | unguarded-commit | `OneCommitPerRevision` violated | 11184 | 3864 | 11 | 3 |
| fixed-bug-head-before-commit | fixed | head-before-commit | `CallsOnCommittedHeaps` violated | 2445 | 1132 | 10 | 2 |
| fixed-bug-main-vm | fixed | main-vm | `CallsOnCommittedHeaps` violated | 779 | 368 | 8 | 2 |
| fixed-bug-idle-any-revision | fixed | idle-any-revision | `HandedAtAskedRevision` violated | 23920 | 9384 | 17 | 3 |
| fixed-bug-no-free | fixed | no-free | `SlotsBounded` violated | 9464 | 3729 | 13 | 3 |
| fixed-bug-skip-readonly-validation | fixed | skip-readonly-validation | `ReadsExisted` violated | 5925 | 2343 | 16 | 3 |
| fixed-bug-workbench-trusts-vm | fixed | workbench-trusts-vm | `WorkbenchAtHead` violated | 1248 | 574 | 9 | 2 |
| fixed-bug-no-validate | fixed | no-validate | `NoLostUpdate` violated | 29236 | 10731 | 17 | 4 |
| fixed-bug-no-validate-serial | fixed | no-validate | `Serializable` violated | 29236 | 10731 | 17 | 3 |
| fixed-bug-conflict-commits | fixed | conflict-commits | `ConflictWritesNothing` violated | 1617849 | 602276 | 33 | 42 |
| fixed-bug-timeout-keeps-waiter | fixed | timeout-keeps-waiter | `RefusedNeverGranted` violated | 1646 | 689 | 11 | 2 |
| fixed-bug-timeout-no-grant | fixed | timeout-no-grant | temporal property violated | 10208 | 4328 | 18 | 7 |

`check.sh` was itself seen red: a copy that expected `bug-main-vm` green printed `EXPECTED green` and exited 1. The
two temporal seeded bugs run with `-deadlock`, so TLC reports the starved call as a liveness violation rather than
as a deadlock.

## Findings

**Deployed, property 5: lost updates, with or without an await.** Both counterexamples run under `"event-loop"`.

A call that awaits a peer (deployed-p5-await, 18 states):

1. Call 1 reads `n = 0` (world-vm.ts:206-212) and awaits the peer (world-vm.ts:215).
2. Call 2 arrives, takes a VM, reads `n = 0` through its own overlay, and awaits too.
3. Call 1's answer arrives. It writes `n = 1` into its overlay, returns (vm-pool.ts:41) and commits blindly
   (local-call-runner.ts:42).
4. Call 2's answer arrives, and it does the same.

The result is two successful increments and `n = 1`.

A call that does not await (deployed-p5-noawait, 15 states):

1. Both calls start before the head's snapshot is cached, so the second gets the first's pending promise
   (local-call-runner.ts:76).
2. When the blob arrives, both resume in that one task, and their microtasks alternate.
3. Each takes a slot (vm-pool.ts:37), opens a VM (vm-pool.ts:40) and evaluates, reading `n = 0`. Neither has reached
   `writes.commit()` yet: it waits behind `return await body(vm)` (vm-pool.ts:41) and two more awaits
   (local-call-runner.ts:71, 41).
4. Both commit `n = 1`.

TLC's trace orders the two calls' microtask hops differently from FIFO, but in both orders each call reads before
the other commits. With the cache warm, each call runs from its arrival to its commit in its own task, and none is
lost. Run on the real code at `a781c76` (three increments, each started in its own task), the lost updates
reproduce:

```
inc, cold snapshot cache (blob fetch 50 ms): 3 calls succeeded, n = 1
inc, warm snapshot cache and pool: 3 calls succeeded, n = 3
incViaPeer, warm snapshot cache and pool: 3 calls succeeded, n = 1
```

**Fixed, property 5 holds** for writing calls. TLC finds no lost update and no non-serializable commit with three
read-await-write calls, or with three read-modify-write calls, each given one rerun. Some of them run out of reruns
(`fixed-bug-conflict-commits` reaches that path), and a conflict writes nothing. `call-concurrency-demo.ts` runs
the same increments on the fixed code:

```
npx esbuild spec/tla/call-concurrency-demo.ts --bundle --platform=node --format=esm --packages=external \
  --outfile=dist/call-concurrency-demo.mjs --log-level=warning && node dist/call-concurrency-demo.mjs
inc, cold snapshot cache: [1,2,3], n = 3
inc, warm snapshot cache: [1,2,3], n = 3
incViaPeer: [1,2,3], n = 3
read-only skew: bump "bumped", pair [1,1], rows a = 1, b = 1
rerun waits for a VM: [1,2,"held","held"], n = 2
```

**A read-only call was not serializable** when it read across an await; 808bd57 fixed it. `commitIfUnchanged` used
to return true for a call with no writes, without validating. `pair` reads `a`, awaits a peer, then reads `b`, while
`bump` sets both to 1; before 808bd57, `pair` succeeded with `[0,1]`, a state the store never held. Now it reruns and
answers `[1,1]` (the demo's fourth line). The demo found this first; the model now checks it as `ReadsExisted`, red
on deployed and on `skip-readonly-validation`, green on fixed.

**An infinite wait refused a rerun at once**; 3e34ae7 fixed it. A rerun's start deadline is
`Number.POSITIVE_INFINITY` (local-call-runner.ts:63). Before vm-pool.ts:103 checked `Number.isFinite`, that became
`setTimeout(..., Infinity)`, which Node clamps to 1 ms, so a rerun that had to wait for a VM was refused as busy. The
model follows the current code, where a rerun has no timer. The demo's last line shows the stale rerun now waits
for a VM and commits.

## Abstractions

- **Heaps are named by content**, as blobs are. The snapshot cache in `LocalCallRunner.snapshotOf` returns the
  snapshot of the blob asked for, because a blob's hash names its bytes. The cache matters only to scheduling,
  where `"event-loop"` models it.
- **The tiered blob store is one set of blobs.** `archiveAllBut` puts a blob in the archive before it deletes the
  local copy (tiered-blob-store.ts:46-47), and `get` reads both tiers, so a blob once written is always readable.
- **The cell's SQL queue and the durable commit are atomic steps.** The queue only orders operations, and the
  world's lock already orders a world's changes.
- **One crash at most.** It loses the cell's memory and the facet's; durable state stays. A call or change cut off
  by it never resumes. A rerun of an agent's tool call after a crash is not modelled.
- **Left out:** the genesis revision, prelude upgrades, check enrolment, grants and incidents. None of them changes
  the head outside `accept` under the lock, or the data outside the call commit.
- **A develop's checks are one interleaving point.** The change VM stays on the developed heap throughout.
- **The start deadline is a nondeterministic refusal.** In fixed, a first run may be refused before the pool or
  while it waits, because time is not modelled. `RUNS` is `Reruns`, 1 in every configuration; 5 in the code.
