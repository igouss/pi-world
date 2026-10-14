--------------------------- MODULE WorldConcurrency ---------------------------
(***************************************************************************)
(* The concurrency protocol of one world: changes (develop, rollback) on   *)
(* one VM under the world's lock, and calls on pooled VMs in the world's   *)
(* runtime facet, over the facet's data. Version picks the code: deployed *)
(* (blind commits, unbounded waits) or fixed (validated commits, reruns,   *)
(* bounded waits).                                                         *)
(*                                                                         *)
(* Each action is one synchronous stretch of JavaScript between two        *)
(* awaits; an await is where another process may run. README.md maps each  *)
(* action to the source lines it models in each version; file:line in the  *)
(* comments here are of the deployed version.                              *)
(***************************************************************************)
EXTENDS Integers, Sequences, FiniteSets

CONSTANTS
    Version,        \* "deployed" or "fixed" (README.md, "Versions")
    Bug,            \* "none", or the seeded bug this run checks (README.md, "Seeded bugs")
    NCalls,         \* how many calls the model runs
    NChangers,      \* how many changes: 1 develops; 2, when there, develops or rolls back
    AwaitPeer,      \* the calls that await another world between read and write
    Max,            \* VmPool max: calls that hold a slot at once
    Warm,           \* VmPool warm: idle VMs kept ready
    MaxCrashes,     \* how many times the cell may crash
    CommitMayFail,  \* whether a durable commit may fail for a storage reason
    Scheduling,     \* "await": any await lets any process run; "event-loop": the facet's (README.md)
    Reruns,         \* fixed: how many times a stale call runs again in the rerun lane (RUNS)
    Readers         \* the calls that only read: n, maybe an await, then w

Calls == 1..NCalls
Changers == 1..NChangers
None == -1
MaxRev == NChangers         \* revision 0 plus one per changer
Revs == 0..MaxRev
\* A heap is named by its content, as its blob is: 0 is revision 0's heap, ch
\* the heap changer ch's develop builds. A rollback rebuilds an older heap.
DevHeap(ch) == ch
Heaps == {0} \cup Changers
NoHead == [rev |-> None, heap |-> None]
NoHand == [asked |-> None, rev |-> None, heap |-> None]
NoPair == [n |-> None, w |-> None]
Keys == {"n", "w"}          \* "n": a counter; "w": who wrote last

VARIABLES
    revs, dhead, blobs,        \* durable, cell: WorldRevision docs, WorldHead, blob store
    nVal, nBy, wBy,            \* durable, facet: row n (value, writer), row w (writer)
    cur, mainHeap, lock,       \* cell memory: World.current, the main VM, the world's Mutex
    cpc, ctarget, cheap, cn,   \* changers: pc, rollback target, heap to accept, revision n
    pc, scope, snap, vmHeap, readv, ok, slotted,  \* calls
    res, runs,                 \* calls: outcome; reruns started
    active, waiting, idle, resetting, newest,     \* facet memory: VmPool
    cache, wave,               \* facet memory: LocalCallRunner.newest; calls waiting on the snapshot that settled in this task
    rpc, rtarget,              \* VmPool.recycle tasks, one per call
    laneQ,                     \* fixed: the rerun lane's Mutex, holder first
    crashes,
    accepted, commits, written, ranOn, handed,    \* history variables for the properties
    refused, serial,
    readw, awaited,            \* calls: what a reader read of w; whether the run awaited another world
    rets, states, wbOk         \* history: readers' answers; every state the rows held; the workbench check

durable == <<revs, dhead, blobs, nVal, nBy, wBy>>
changer == <<cpc, ctarget, cheap, cn>>
call == <<pc, scope, snap, vmHeap, readv, ok, slotted, res, runs>>
pool == <<active, waiting, idle, resetting, newest, rpc, rtarget, cache, wave, laneQ>>
ghost == <<accepted, commits, written, ranOn, handed, refused, serial>>
extra == <<readw, awaited, rets, states, wbOk>>
vars == <<durable, cur, mainHeap, lock, changer, call, pool, crashes, ghost, extra>>

Init ==
    /\ revs = [i \in Revs |-> IF i = 0 THEN 0 ELSE None]
    /\ dhead = 0
    /\ blobs = {0}
    /\ nVal = 0 /\ nBy = 0 /\ wBy = 0
    /\ cur = [rev |-> 0, heap |-> 0]
    /\ mainHeap = 0
    /\ lock = 0
    /\ cpc = [ch \in Changers |-> "Idle"]
    /\ ctarget = [ch \in Changers |-> None]
    /\ cheap = [ch \in Changers |-> None]
    /\ cn = [ch \in Changers |-> None]
    /\ pc = [c \in Calls |-> "Idle"]
    /\ scope = [c \in Calls |-> NoHead]
    /\ snap = [c \in Calls |-> None]
    /\ vmHeap = [c \in Calls |-> None]
    /\ readv = [c \in Calls |-> 0]
    /\ ok = [c \in Calls |-> FALSE]
    /\ slotted = [c \in Calls |-> FALSE]
    /\ res = [c \in Calls |-> "none"]
    /\ runs = [c \in Calls |-> 0]
    /\ laneQ = <<>>
    /\ active = 0 /\ waiting = <<>> /\ idle = <<>> /\ resetting = 0 /\ newest = NoHead
    /\ cache = NoHead /\ wave = {}
    /\ rpc = [c \in Calls |-> "None"]
    /\ rtarget = [c \in Calls |-> NoHead]
    /\ crashes = 0
    /\ accepted = {} /\ commits = {}
    /\ written = [c \in Calls |-> {}]
    /\ ranOn = [c \in Calls |-> None]
    /\ handed = [c \in Calls |-> NoHand]
    /\ refused = [c \in Calls |-> FALSE]
    /\ serial = TRUE
    /\ readw = [c \in Calls |-> 0]
    /\ awaited = [c \in Calls |-> FALSE]
    /\ rets = [c \in Calls |-> NoPair]
    /\ states = {[n |-> 0, w |-> 0]}
    /\ wbOk = TRUE

-----------------------------------------------------------------------------
(* Changers: World.develop and World.rollback, under World.exclusive.      *)

SetC(f, ch, v) == [f EXCEPT ![ch] = v]
Release(ch, next) == lock' = 0 /\ cpc' = SetC(cpc, ch, next)

ChLock(ch) ==
    /\ cpc[ch] = "Idle"
    /\ cur.rev # None
    /\ (lock = 0 \/ Bug = "unguarded-commit")
    /\ lock' = ch
    /\ cpc' = SetC(cpc, ch, "Attempt")
    /\ UNCHANGED <<durable, cur, mainHeap, ctarget, cheap, cn, call, pool, crashes, ghost, extra>>

\* Fixed: the workbench first returns to the head the cell names, which the
\* model folds into the attempt's first step.
\* WorkbenchBase: the heap the change VM holds when the attempt starts. Fixed:
\* LocalWorkbench.atBlob returns the VM as it is when it holds the head blob the
\* cell names, else restores that blob (local-workbench.ts:61-68).
WorkbenchBase ==
    IF Version = "fixed" /\ Bug # "workbench-trusts-vm" THEN cur.heap ELSE mainHeap
ChAttempt(ch) ==
    /\ cpc[ch] = "Attempt"
    /\ \/ /\ mainHeap' = DevHeap(ch)
          /\ wbOk' = (wbOk /\ WorkbenchBase = cur.heap)
          /\ cpc' = SetC(cpc, ch, "Checks")
          /\ UNCHANGED <<lock, ctarget>>
       \/ /\ ch = 2
          /\ \E t \in 0..cur.rev :
                IF t = cur.rev
                THEN Release(ch, "Done") /\ UNCHANGED <<mainHeap, ctarget>>
                ELSE /\ ctarget' = SetC(ctarget, ch, t)
                     /\ cpc' = SetC(cpc, ch, "RbFetch")
                     /\ UNCHANGED <<lock, mainHeap>>
          /\ UNCHANGED wbOk
    /\ UNCHANGED <<durable, cur, cheap, cn, call, pool, crashes, ghost, readw, awaited, rets, states>>

ChChecks(ch) ==
    /\ cpc[ch] = "Checks"
    /\ \/ cheap' = SetC(cheap, ch, DevHeap(ch)) /\ cpc' = SetC(cpc, ch, "Put")
       \/ cpc' = SetC(cpc, ch, "RejReset") /\ UNCHANGED cheap
    /\ UNCHANGED <<durable, cur, mainHeap, lock, ctarget, cn, call, pool, crashes, ghost, extra>>

ChRejReset(ch) ==
    /\ cpc[ch] = "RejReset"
    /\ mainHeap' = cur.heap
    /\ cpc' = SetC(cpc, ch, "RejCommit")
    /\ UNCHANGED <<durable, cur, lock, ctarget, cheap, cn, call, pool, crashes, ghost, extra>>

ChRejCommit(ch) ==
    /\ cpc[ch] = "RejCommit"
    /\ Release(ch, "Done")
    /\ UNCHANGED <<durable, cur, mainHeap, ctarget, cheap, cn, call, pool, crashes, ghost, extra>>

ChRbFetch(ch) ==
    /\ cpc[ch] = "RbFetch"
    /\ IF revs[ctarget[ch]] \in blobs
       THEN cpc' = SetC(cpc, ch, "RbReset") /\ UNCHANGED lock
       ELSE Release(ch, "Done")
    /\ UNCHANGED <<durable, cur, mainHeap, ctarget, cheap, cn, call, pool, crashes, ghost, extra>>

ChRbReset(ch) ==
    /\ cpc[ch] = "RbReset"
    /\ mainHeap' = revs[ctarget[ch]]
    /\ cheap' = SetC(cheap, ch, revs[ctarget[ch]])
    /\ cpc' = SetC(cpc, ch, "Put")
    /\ UNCHANGED <<durable, cur, lock, ctarget, cn, call, pool, crashes, ghost, extra>>

ChPut(ch) ==
    /\ cpc[ch] = "Put"
    /\ blobs' = IF Bug = "commit-before-blob" THEN blobs ELSE blobs \cup {cheap[ch]}
    /\ cn' = SetC(cn, ch, cur.rev + 1)
    /\ cur' = IF Bug = "head-before-commit" THEN [rev |-> cur.rev + 1, heap |-> cheap[ch]] ELSE cur
    /\ cpc' = SetC(cpc, ch, "Commit")
    /\ UNCHANGED <<revs, dhead, nVal, nBy, wBy, mainHeap, lock, ctarget, cheap, call, pool, crashes, ghost, extra>>

\* The commit's guard is world.ts:359: the durable head is still the head this
\* accept started from (cn - 1 is this.current.revision, which no one else
\* changes while the lock is held).
ChCommit(ch) ==
    /\ cpc[ch] = "Commit"
    /\ \/ /\ (dhead = cn[ch] - 1 \/ Bug = "unguarded-commit")
          /\ revs' = [revs EXCEPT ![cn[ch]] = cheap[ch]]
          /\ dhead' = cn[ch]
          /\ commits' = commits \cup {[n |-> cn[ch], by |-> ch]}
          /\ cpc' = SetC(cpc, ch, IF Bug = "commit-before-blob" THEN "PutAfter" ELSE "Publish")
       \/ /\ (dhead # cn[ch] - 1 \/ CommitMayFail)
          /\ cpc' = SetC(cpc, ch, "FailReset")
          /\ UNCHANGED <<revs, dhead, commits>>
    /\ UNCHANGED <<blobs, nVal, nBy, wBy, cur, mainHeap, lock, ctarget, cheap, cn, call, pool, crashes,
                   accepted, written, ranOn, handed, refused, serial, extra>>

ChPutAfter(ch) ==
    /\ cpc[ch] = "PutAfter"
    /\ blobs' = blobs \cup {cheap[ch]}
    /\ cpc' = SetC(cpc, ch, "Publish")
    /\ UNCHANGED <<revs, dhead, nVal, nBy, wBy, cur, mainHeap, lock, ctarget, cheap, cn, call, pool, crashes, ghost, extra>>

ChPublish(ch) ==
    /\ cpc[ch] = "Publish"
    /\ cur' = [rev |-> cn[ch], heap |-> cheap[ch]]
    /\ accepted' = accepted \cup {[n |-> cn[ch], heap |-> cheap[ch]]}
    /\ Release(ch, "Done")
    /\ UNCHANGED <<durable, mainHeap, ctarget, cheap, cn, call, pool, crashes, commits, written, ranOn, handed,
                   refused, serial, extra>>

\* Deployed: the catch in World.accept puts the main VM back on headSnapshot,
\* the heap of the head this accept started from. Fixed: no reset; the
\* workbench returns to the head blob the next operation names.
ChFailReset(ch) ==
    /\ cpc[ch] = "FailReset"
    /\ mainHeap' = IF Version = "deployed" THEN revs[cn[ch] - 1] ELSE mainHeap
    /\ Release(ch, "Done")
    /\ UNCHANGED <<durable, cur, ctarget, cheap, cn, call, pool, crashes, ghost, extra>>

ChangerStep(ch) ==
    \/ ChLock(ch) \/ ChAttempt(ch) \/ ChChecks(ch) \/ ChRejReset(ch) \/ ChRejCommit(ch)
    \/ ChRbFetch(ch) \/ ChRbReset(ch) \/ ChPut(ch) \/ ChCommit(ch) \/ ChPutAfter(ch)
    \/ ChPublish(ch) \/ ChFailReset(ch)

-----------------------------------------------------------------------------
(* Calls: World.call in the cell, LocalCallRunner and VmPool in the facet.  *)

\* VmPool.free: a freed slot passes to the first waiter (deployed and fixed;
\* fixed also clears the waiter's timer).
Free ==
    IF waiting # <<>> /\ Bug # "free-drops-waiter"
    THEN /\ slotted' = [slotted EXCEPT ![Head(waiting)] = TRUE]
         /\ waiting' = Tail(waiting)
         /\ UNCHANGED active
    ELSE /\ active' = active - 1
         /\ UNCHANGED <<slotted, waiting>>

Set(f, c, v) == [f EXCEPT ![c] = v]

\* Fixed: a call that is rerunning holds the rerun lane, and leaves it when it
\* is done, whatever the outcome.
LaneOut(c) == laneQ' = IF runs[c] > 0 THEN Tail(laneQ) ELSE laneQ

\* Under "event-loop", a facet step that starts a task (an RPC arrives: a call,
\* a snapshot blob, a peer's answer, a timer) waits until no continuation is
\* queued. Continuations of already settled promises are microtasks;
\* QuickJS.restore (VmPool.open, WorldVm.reset) settles before the next task.
\* A rerun's snapshot is cached, so its fetch is a microtask too.
Cached(c) == cache.heap = scope[c].heap
RerunHit(c) == runs[c] > 0 /\ Cached(c)
MicroPending ==
    {c \in Calls : \/ pc[c] = "TakeVm" /\ slotted[c]
                   \/ pc[c] \in {"Open", "Eval", "Ret", "Commit", "Commit2"}
                   \/ pc[c] = "Lane" /\ laneQ # <<>> /\ Head(laneQ) = c
                   \/ pc[c] = "Fetch" /\ RerunHit(c)}
      \cup {c + NCalls : c \in {d \in Calls : rpc[d] = "Reset"}}
TaskMayStart == Scheduling = "await" \/ MicroPending = {}
\* Calls that awaited the same pending snapshot (LocalCallRunner.snapshotOf)
\* all resume in the task that settles it: the calls that had started, at
\* that blob, when the fetch that is cached settled.
JoinsWave(c) == Scheduling = "event-loop" /\ c \in wave
\* The fetch is cached when its revision is the newest asked for.
Caches(c) == ~Cached(c) /\ (cache.rev = None \/ scope[c].rev >= cache.rev)

CStart(c) ==
    /\ pc[c] = "Idle"
    /\ cur.rev # None
    /\ scope' = Set(scope, c, cur)
    /\ pc' = Set(pc, c, "Fetch")
    /\ UNCHANGED <<durable, cur, mainHeap, lock, changer, snap, vmHeap, readv, ok, slotted, res, runs,
                   pool, crashes, ghost, extra>>

\* After the snapshot await, VmPool.run up to its first await: newest, then
\* slot(), which takes a free slot or queues. Fixed: a first run past its
\* start deadline is refused before the pool.
CFetch(c) ==
    /\ pc[c] = "Fetch"
    /\ \/ /\ Scheduling = "await"
          /\ UNCHANGED <<cache, wave>>
       \/ /\ Scheduling = "event-loop"
          /\ RerunHit(c)
          /\ UNCHANGED <<cache, wave>>
       \/ /\ Scheduling = "event-loop"
          /\ ~RerunHit(c)
          /\ TaskMayStart
          /\ cache' = IF Caches(c) THEN scope[c] ELSE cache
          /\ wave' = IF Caches(c) THEN {d \in Calls \ {c} : pc[d] = "Fetch" /\ scope[d].heap = scope[c].heap} ELSE {}
       \/ /\ JoinsWave(c)
          /\ wave' = wave \ {c}
          /\ UNCHANGED cache
    /\ IF scope[c].heap \notin blobs
       THEN /\ pc' = Set(pc, c, "Done") /\ res' = Set(res, c, "fail")
            /\ LaneOut(c)
            /\ UNCHANGED <<snap, newest, active, slotted, waiting>>
       ELSE \/ /\ snap' = Set(snap, c, scope[c].heap)
               /\ newest' = IF newest.rev = None \/ scope[c].rev >= newest.rev THEN scope[c] ELSE newest
               /\ pc' = Set(pc, c, "TakeVm")
               /\ IF active < Max \/ (Bug = "slot-off-by-one" /\ active = Max)
                  THEN active' = active + 1 /\ slotted' = Set(slotted, c, TRUE) /\ UNCHANGED waiting
                  ELSE waiting' = Append(waiting, c) /\ UNCHANGED <<active, slotted>>
               /\ UNCHANGED <<res, laneQ>>
            \/ /\ Version = "fixed" /\ runs[c] = 0
               /\ pc' = Set(pc, c, "Done") /\ res' = Set(res, c, "busy")
               /\ UNCHANGED <<snap, newest, active, slotted, waiting, laneQ>>
    /\ UNCHANGED <<durable, cur, mainHeap, lock, changer, scope, vmHeap, readv, ok, runs, idle, resetting,
                   rpc, rtarget, crashes, ghost, extra>>

\* Fixed: the waiter's timer fires; the call is refused as busy and leaves the
\* queue. Only a first run has a timer: a rerun's start deadline is infinite,
\* and an infinite wait sets none.
CTimeout(c) ==
    /\ Version = "fixed"
    /\ pc[c] = "TakeVm" /\ ~slotted[c] /\ runs[c] = 0
    /\ \E i \in 1..Len(waiting) : waiting[i] = c
    /\ TaskMayStart
    /\ wave' = {}
    /\ waiting' = IF Bug = "timeout-keeps-waiter" THEN waiting ELSE SelectSeq(waiting, LAMBDA d : d # c)
    /\ refused' = Set(refused, c, TRUE)
    /\ IF Bug = "timeout-no-grant"
       THEN pc' = Set(pc, c, "Refusing") /\ UNCHANGED <<res, laneQ>>
       ELSE pc' = Set(pc, c, "Done") /\ res' = Set(res, c, "busy") /\ LaneOut(c)
    /\ UNCHANGED <<durable, cur, mainHeap, lock, changer, scope, snap, vmHeap, readv, ok, slotted, runs,
                   active, idle, resetting, newest, rpc, rtarget, cache, crashes,
                   accepted, commits, written, ranOn, handed, serial, extra>>

\* VmPool.takeIdle: pop idle VMs, disposing each until one is at the asked
\* revision.
Match(c) == {j \in 1..Len(idle) : idle[j].rev = scope[c].rev \/ Bug = "idle-any-revision"}

CTakeVm(c) ==
    /\ pc[c] = "TakeVm"
    /\ slotted[c]
    /\ IF Match(c) # {}
       THEN LET j == CHOOSE j \in Match(c) : \A i \in Match(c) : i <= j
            IN /\ idle' = SubSeq(idle, 1, j - 1)
               /\ vmHeap' = Set(vmHeap, c, idle[j].heap)
               /\ handed' = Set(handed, c, [asked |-> scope[c].rev, rev |-> idle[j].rev, heap |-> idle[j].heap])
               /\ pc' = Set(pc, c, "Eval")
       ELSE /\ idle' = <<>>
            /\ pc' = Set(pc, c, "Open")
            /\ UNCHANGED <<vmHeap, handed>>
    /\ UNCHANGED <<durable, cur, mainHeap, lock, changer, scope, snap, readv, ok, slotted, res, runs,
                   active, waiting, resetting, newest, rpc, rtarget, cache, wave, laneQ, crashes,
                   accepted, commits, written, ranOn, refused, serial, extra>>

COpen(c) ==
    /\ pc[c] = "Open"
    /\ vmHeap' = Set(vmHeap, c, snap[c])
    /\ pc' = Set(pc, c, "Eval")
    /\ UNCHANGED <<durable, cur, mainHeap, lock, changer, scope, snap, readv, ok, slotted, res, runs,
                   pool, crashes, ghost, extra>>

\* The first synchronous step of the evaluation: read n through the overlay,
\* which has no write of this run yet, so it reads the facet's row (and, when
\* fixed, records what it read). A call that does not await finishes here:
\* a writer with its writes recorded in its overlay, a reader having read w
\* too. A call that awaits is marked as having crossed an await when it calls
\* the other world (fixed: awaitsNoted, local-call-runner.ts).
CEval(c) ==
    /\ pc[c] = "Eval"
    /\ ranOn' = Set(ranOn, c, IF Bug = "main-vm" THEN mainHeap ELSE vmHeap[c])
    /\ readv' = Set(readv, c, nVal)
    /\ awaited' = Set(awaited, c, c \in AwaitPeer)
    /\ IF c \in AwaitPeer
       THEN pc' = Set(pc, c, "Peer") /\ UNCHANGED <<ok, readw>>
       ELSE /\ \E b \in BOOLEAN : ok' = Set(ok, c, b) /\ pc' = Set(pc, c, "Ret")
            /\ readw' = IF c \in Readers THEN Set(readw, c, wBy) ELSE readw
    /\ UNCHANGED <<durable, cur, mainHeap, lock, changer, scope, snap, vmHeap, slotted, res, runs,
                   pool, crashes, accepted, commits, written, handed, refused, serial, rets, states, wbOk>>

\* The peer answers (or fails, or the deadline passes); the next synchronous
\* step writes n and w into the overlay (a reader reads w), or throws.
CPeer(c) ==
    /\ pc[c] = "Peer"
    /\ TaskMayStart
    /\ wave' = {}
    /\ \E b \in BOOLEAN : ok' = Set(ok, c, b)
    /\ readw' = IF c \in Readers THEN Set(readw, c, wBy) ELSE readw
    /\ pc' = Set(pc, c, "Ret")
    /\ UNCHANGED <<durable, cur, mainHeap, lock, changer, scope, snap, vmHeap, readv, slotted, res, runs,
                   active, waiting, idle, resetting, newest, rpc, rtarget, cache, laneQ, crashes, ghost,
                   awaited, rets, states, wbOk>>

\* Back in VmPool.run after `await body(vm)`: the finally starts recycle,
\* whose part before its first await runs now.
CRet(c) ==
    /\ pc[c] = "Ret"
    /\ vmHeap' = Set(vmHeap, c, None)
    /\ pc' = Set(pc, c, "Commit")
    /\ IF Len(idle) + resetting >= Warm
       THEN /\ IF Bug = "no-free" THEN UNCHANGED <<active, slotted, waiting>> ELSE Free
            /\ UNCHANGED <<resetting, rpc, rtarget>>
       ELSE /\ resetting' = resetting + 1
            /\ rpc' = Set(rpc, c, "Reset")
            /\ rtarget' = Set(rtarget, c, newest)
            /\ UNCHANGED <<active, slotted, waiting>>
    /\ UNCHANGED <<durable, cur, mainHeap, lock, changer, scope, snap, readv, ok, res, runs,
                   idle, newest, cache, wave, laneQ, crashes, ghost, extra>>

\* The overlay's writes made, in one transaction of the facet's SQLite.
Apply(c, outcome, next) ==
    /\ nVal' = readv[c] + 1 /\ nBy' = c
    /\ serial' = (serial /\ readv[c] = nVal)
    /\ states' = states \cup {[n |-> readv[c] + 1, w |-> IF Bug = "partial-commit" THEN wBy ELSE c]}
    /\ IF Bug = "partial-commit"
       THEN /\ written' = Set(written, c, {"n"})
            /\ pc' = Set(pc, c, "Commit2")
            /\ UNCHANGED <<wBy, laneQ>>
       ELSE /\ wBy' = c
            /\ written' = Set(written, c, Keys)
            /\ pc' = Set(pc, c, next)
            /\ LaneOut(c)
    /\ res' = Set(res, c, outcome)

\* LocalCallRunner.call after its awaits. Deployed: OverlayDataPort.commit, a
\* blind commit on success. Fixed: commitIfUnchanged validates the read in the
\* same transaction; a stale run makes no write and the call runs again, first
\* waiting for the rerun lane, until it has run Reruns more times.
Stale(c) == Version = "fixed" /\ nVal # readv[c] /\ Bug # "no-validate"
\* A reader writes nothing. Deployed: nothing to commit. Fixed: commitIfUnchanged
\* returns true for a run that never awaited, and validates the reads of one
\* that did (overlay-data-port.ts:59-63).
ReaderValid(c) ==
    \/ Version = "deployed"
    \/ Bug = "skip-readonly-validation"
    \/ ~awaited[c]
    \/ nVal = readv[c] /\ wBy = readw[c]
Valid(c) == IF c \in Readers THEN ReaderValid(c) ELSE ~Stale(c)
Succeed(c) ==
    IF c \in Readers
    THEN /\ pc' = Set(pc, c, "Done") /\ res' = Set(res, c, IF ok[c] THEN "ok" ELSE "fail") /\ LaneOut(c)
         /\ rets' = Set(rets, c, [n |-> readv[c], w |-> readw[c]])
         /\ UNCHANGED <<nVal, nBy, wBy, written, serial, states>>
    ELSE Apply(c, IF ok[c] THEN "ok" ELSE "fail", "Done") /\ UNCHANGED rets
CCommit(c) ==
    /\ pc[c] = "Commit"
    /\ IF ~ok[c] /\ Bug # "commit-on-failure"
       THEN /\ pc' = Set(pc, c, "Done") /\ res' = Set(res, c, "fail") /\ LaneOut(c)
            /\ UNCHANGED <<nVal, nBy, wBy, written, serial, slotted, runs, rets, states>>
       ELSE IF Valid(c)
       THEN Succeed(c) /\ UNCHANGED <<slotted, runs>>
       ELSE IF runs[c] = 0
       THEN /\ pc' = Set(pc, c, "Lane") /\ laneQ' = Append(laneQ, c)
            /\ UNCHANGED <<nVal, nBy, wBy, written, serial, res, slotted, runs, rets, states>>
       ELSE IF runs[c] < Reruns
       THEN /\ pc' = Set(pc, c, "Fetch") /\ runs' = Set(runs, c, runs[c] + 1) /\ slotted' = Set(slotted, c, FALSE)
            /\ UNCHANGED <<nVal, nBy, wBy, written, serial, res, laneQ, rets, states>>
       ELSE IF Bug = "conflict-commits" /\ c \notin Readers
       THEN Apply(c, "conflict", "Done") /\ UNCHANGED <<slotted, runs, rets>>
       ELSE /\ pc' = Set(pc, c, "Done") /\ res' = Set(res, c, "conflict") /\ LaneOut(c)
            /\ UNCHANGED <<nVal, nBy, wBy, written, serial, slotted, runs, rets, states>>
    /\ UNCHANGED <<revs, dhead, blobs, cur, mainHeap, lock, changer, scope, snap, vmHeap, readv, ok,
                   active, waiting, idle, resetting, newest, rpc, rtarget, cache, wave, crashes,
                   accepted, commits, ranOn, handed, refused, readw, awaited, wbOk>>

\* Only under Bug = "partial-commit": the second write, after an await.
CCommit2(c) ==
    /\ pc[c] = "Commit2"
    /\ wBy' = c
    /\ written' = Set(written, c, Keys)
    /\ pc' = Set(pc, c, "Done")
    /\ LaneOut(c)
    /\ states' = states \cup {[n |-> nVal, w |-> c]}
    /\ UNCHANGED <<revs, dhead, blobs, nVal, nBy, cur, mainHeap, lock, changer, scope, snap, vmHeap, readv, ok,
                   slotted, res, runs, active, waiting, idle, resetting, newest, rpc, rtarget, cache, wave,
                   crashes, accepted, commits, ranOn, handed, refused, serial, readw, awaited, rets, wbOk>>

\* Fixed: the rerun lane is free and this call is first in it; the call runs
\* again from the start, at the head it started at.
CLane(c) ==
    /\ pc[c] = "Lane"
    /\ Head(laneQ) = c
    /\ pc' = Set(pc, c, "Fetch")
    /\ runs' = Set(runs, c, 1)
    /\ slotted' = Set(slotted, c, FALSE)
    /\ UNCHANGED <<durable, cur, mainHeap, lock, changer, scope, snap, vmHeap, readv, ok, res,
                   pool, crashes, ghost, extra>>

\* The rest of VmPool.recycle: the VM goes back (reset when deployed, rewind
\* when fixed) to the head that was newest when recycle started, is pushed
\* idle, and its slot freed.
RReset(c) ==
    /\ rpc[c] = "Reset"
    /\ idle' = Append(idle, rtarget[c])
    /\ resetting' = resetting - 1
    /\ Free
    /\ rpc' = Set(rpc, c, "None")
    /\ UNCHANGED <<durable, cur, mainHeap, lock, changer, pc, scope, snap, vmHeap, readv, ok, res, runs,
                   newest, rtarget, cache, wave, laneQ, crashes, ghost, extra>>

CallStep(c) ==
    \/ CStart(c) \/ CFetch(c) \/ CTimeout(c) \/ CTakeVm(c) \/ COpen(c) \/ CEval(c) \/ CPeer(c)
    \/ CRet(c) \/ CCommit(c) \/ CCommit2(c) \/ CLane(c)

-----------------------------------------------------------------------------
(* The cell crashes: its memory and its facet's memory go, durable state    *)
(* stays. Restart is World.open (world.ts:94-107).                         *)

Gone(f, live) == [x \in DOMAIN f |-> IF f[x] \in live THEN f[x] ELSE "Dead"]

Crash ==
    /\ crashes < MaxCrashes
    /\ cur.rev # None
    /\ crashes' = crashes + 1
    /\ cur' = NoHead
    /\ mainHeap' = None
    /\ lock' = 0
    /\ cpc' = Gone(cpc, {"Idle", "Done"})
    /\ pc' = Gone(pc, {"Idle", "Done"})
    /\ slotted' = [c \in Calls |-> FALSE]
    /\ vmHeap' = [c \in Calls |-> None]
    /\ active' = 0 /\ waiting' = <<>> /\ idle' = <<>> /\ resetting' = 0 /\ newest' = NoHead
    /\ cache' = NoHead /\ wave' = {} /\ laneQ' = <<>>
    /\ rpc' = [c \in Calls |-> "None"]
    /\ UNCHANGED <<durable, ctarget, cheap, cn, scope, snap, readv, ok, res, runs, rtarget, ghost, extra>>

\* requireBlob (world.ts:426-430): a world whose head blob is missing does not open.
Restart ==
    /\ cur.rev = None
    /\ revs[dhead] \in blobs
    /\ cur' = [rev |-> dhead, heap |-> revs[dhead]]
    /\ mainHeap' = revs[dhead]
    /\ UNCHANGED <<durable, lock, changer, call, pool, crashes, ghost, extra>>

Finished ==
    /\ \A ch \in Changers : cpc[ch] \in {"Done", "Dead"}
    /\ \A c \in Calls : pc[c] \in {"Done", "Dead"} /\ rpc[c] = "None"
    /\ cur.rev # None

Next ==
    \/ \E ch \in Changers : ChangerStep(ch)
    \/ \E c \in Calls : CallStep(c) \/ RReset(c)
    \/ Crash
    \/ Restart
    \/ Finished /\ UNCHANGED vars

Spec == Init /\ [][Next]_vars

FairSpec ==
    /\ Spec
    /\ \A ch \in Changers : WF_vars(ChangerStep(ch))
    /\ \A c \in Calls : WF_vars(CallStep(c)) /\ WF_vars(RReset(c))
    /\ WF_vars(Restart)

-----------------------------------------------------------------------------
(* Properties. README.md links each to the code it is about.               *)

Committed == {revs[i] : i \in 0..dhead}
Failed(c) == pc[c] = "Done" /\ res[c] \in {"fail", "busy", "conflict"}

\* 1. A call's writes are made all together, and never by a failed call.
WritesAllOrNone == \A c \in Calls : written[c] \in {{}, Keys}
FailedWritesNothing == \A c \in Calls : Failed(c) => written[c] = {}
\* Fixed: a call that ran out of reruns made no write.
ConflictWritesNothing == \A c \in Calls : res[c] = "conflict" => written[c] = {}
RowsFromOneCommit == nBy = wBy

\* 2. No lost revision.
HeadBlobPresent == \A i \in 0..dhead : revs[i] \in blobs
AcceptedKept == \A a \in accepted : a.n <= dhead /\ revs[a.n] = a.heap
OneCommitPerRevision == \A x, y \in commits : x.n = y.n => x = y
HistoryKept ==
    [][ /\ dhead' >= dhead
        /\ \A i \in 0..dhead : revs'[i] = revs[i]
        /\ revs'[dhead'] # None ]_vars
\* The comment at world.ts:61-62: the main VM is at the head between changes.
MainAtHead == (lock = 0 /\ cur.rev # None) => mainHeap = cur.heap
\* Fixed: the workbench VM is at the head blob whenever a change starts its attempt.
WorkbenchAtHead == wbOk

\* 3. A call runs only on a committed revision's heap, the one it started at;
\* and the head a call can start from is committed.
CallsOnCommittedHeaps ==
    \A c \in Calls : ranOn[c] # None => ranOn[c] \in Committed /\ ranOn[c] = revs[scope[c].rev]
CurrentIsCommitted == cur.rev # None => cur.rev <= dhead /\ revs[cur.rev] = cur.heap

\* 4. The VM pool.
SlotHolders ==
    {c \in Calls : pc[c] \in {"TakeVm", "Open", "Eval", "Peer", "Ret"} /\ slotted[c]}
      \cup {c + NCalls : c \in {d \in Calls : rpc[d] = "Reset"}}
SlotsBounded == active = Cardinality(SlotHolders) /\ active <= Max
HandedAtAskedRevision ==
    \A c \in Calls : handed[c].rev # None => handed[c].rev = handed[c].asked /\ handed[c].heap = revs[handed[c].asked]
\* vm-pool.ts:18 says "At most `max` VMs exist at a time"; this counts idle ones too.
VmsHeld == Cardinality({c \in Calls : pc[c] \in {"Eval", "Peer", "Ret"}}) + resetting
VmsExistBounded == VmsHeld + Len(idle) <= Max
WaitingCallFinishes == \A c \in Calls : pc[c] = "TakeVm" ~> pc[c] \in {"Done", "Dead"}
\* Fixed: a waiting call is granted a slot or refused, and a refused one never
\* gets a slot afterwards.
WaitingResolved == \A c \in Calls : (pc[c] = "TakeVm" /\ ~slotted[c]) ~> (slotted[c] \/ pc[c] \in {"Done", "Dead"})
RefusedNeverGranted == \A c \in Calls : refused[c] => ~slotted[c]

\* 5. No lost update over n: each committed call added one.
NoLostUpdate == nVal = Cardinality({c \in Calls : "n" \in written[c]})
\* Every commit read exactly what the calls committed before it left, so the
\* commit order is a serial order of the successful calls.
Serializable == serial
\* A reader that succeeded answered a state the rows held at some moment.
ReadsExisted == \A c \in Readers : rets[c] # NoPair => rets[c] \in states

=============================================================================
