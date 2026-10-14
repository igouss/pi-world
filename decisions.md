# pi-world: decisions

## Operator decision

- "looks good, create a new project in ~/IdeaProjects and save this as intent.md", 2026-10-05.
- "yes update intent.md, I'll set-up it with GCS buckets. TUI will not be used, probably REST and WEB UI.",
  2026-10-05.
- "save it as evaluation.md and fold the findings into intent.md", 2026-10-05.
- "fold the vtable and state form into intent.md", 2026-10-05.
- "OK, let's settle on JavaScript as the world language and TypeScript as the cell shell.", 2026-10-05.
- "Yes, I'm looking at it as a fastest possible implement-and-check loop for one kind of artifact. I program that
  grows thou prompting, where I can immediately validate and iterate on results.", 2026-10-06.
- "ok, commit and push after you apply", 2026-10-06, on the proposed cuts to the intent.
- "and let's shard, split indent from research, etc.", 2026-10-06.
- "I think leaning on data living in SQLite is a good idea, fold it into design.md and the registry spike, then
  commit and push", 2026-10-06, on eager, declared instance migration at class redefinition.
- "Ok, I think I agree with you, let's update the md files.", 2026-10-06, on keeping checks outside the world.
- "http://oracle-arm.mist-walleye.ts.net:8787 celld installed, your goal is to write a working prototype, this is an
  experiment so I don't have all the answers, can to code enough code for me to have a webui I can use, one I have it
  and use it I'll have a better idea how to answer open questions, for now you have my authorization to do common
  sense approach, be bold and this is a cool new greenfield, set your standards high and god speed! I'm on a flight to
  japan so you have autonomy.", 2026-10-06.
- "Check how pi is connected to clause without API key, using my subscription, use same approach", 2026-10-06.
- "We should support concurrent calls", 2026-10-07.
- "The goal now is to implement the remaining ideas", 2026-10-07, answered in two choices: of the remaining ideas,
  "Isolation and storage" (each world's calls in a Dynamic Worker so one world's CPU work stops slowing the others,
  and old snapshots moved to R2); and for agent test runs, "Roll back (Recommended)" (execute rolls back its data
  writes; calls from people and other worlds still write).
- "All right, I think your ideas are pretty solid. I believe in you, and you have my authority to implement this.",
  2026-10-12, on six proposed improvements: failed calls the agent fixes and retries, parsing `develop` sources on the
  host, checks as property-based tests, a capability grant per world, measuring memory per world, and rejections as
  records. Answered the same day in four choices: "One commit per idea (Recommended)"; deploy "After all six land
  (Recommended)"; for a retried call, "Make calls atomic (Recommended)" (a call's data writes commit only when it
  succeeds, which changes the documented sharing of writes between concurrent calls and `test/concurrency.test.ts`);
  and "Accept all (Recommended)" for the defaults: existing worlds may call any world until the operator restricts
  them, a failed call reaches the agent only when the owner asks, and Stryker is the mutation testing tool.

- "No shrink on budget (Recommended)" and "File a bead (Recommended)", 2026-10-13, answering how a develop should be
  bounded after a property check that hung was measured replaying its input 200 times, and what to do with moving
  develops into the world's own isolate.
- "init br, file tasks I don't want them fixed now, existing identified technical debt should be fixed too create
  beads, i agree with your recommendations file those and the ones you chose not to show as beads, reformulate docs
  to reflect the future direction and remove old cruft, commit.", 2026-10-13, on the design review's nine
  recommendations.

This approves:

- `intent.md` as the project's intent, and this directory;
- celld as the deployment target, with GCS buckets;
- REST and a web UI as the interfaces, with no TUI;
- recording the evaluation's findings as design constraints and open items. It decides none of the open
  decisions below;
- the prelude: a registry with stable stubs for definitions, the keep-if-present state form, and sources evaluated
  in a function scope;
- JavaScript as the world language and TypeScript as the cell shell. A compiled language cannot be the world
  language: every `develop` would be a recompile into a module with a new memory layout, which invalidates the
  previous snapshot and ends the live image. Compiled code belongs in the compiled tier (`plan.md`, "Later");
- the position in `intent.md`: one station, the fastest implement-and-check loop for one kind of artifact. It decides none
  of open decisions 4 and 10 to 12;
- the split of the intent into `intent.md`, `design.md`, `plan.md`, `research.md` and this file;
- instance migration at class redefinition: eager, declared with `version` and `migrate`, rejected without one while
  instances are live, and kept affordable by data living in SQLite rather than the heap;
- checks outside the world: stored on the host side where world code cannot reach them, enrolled only after being
  seen failing on a counterexample, removed or loosened only by the operator with a recorded reason, and protected
  by frozen built-ins. What to do with a check that calls a definition the agent can replace is open decision 13.

- a working prototype with a web UI, deployed to the celld node, built with common-sense choices for the open
  questions. Each such choice is recorded below under "Prototype assumptions" so it can be revisited after use;
- concurrent calls to one world, each on its own VM (built 2026-10-07);
- running each world's calls in an isolate of its own, through a Dynamic Worker, and moving snapshots that are not the
  head to R2;
- `execute` rolling back its data writes, which settles open decision 3 for this world's data;
- reaching Claude through the owner's subscription the way pi does: Claude Code's public OAuth client with PKCE and
  the copy-code redirect, refresh in one place, and the token passed to pi-ai as `ANTHROPIC_OAUTH_TOKEN`;
- the six improvements of 2026-10-12, committed one per improvement on main and deployed to the node once all six
  have landed: incidents for failed calls with retry (open decision 8's neighbour, not 8 itself), the host rewrite of
  top-level declarations (open decision 9) with counterexample re-runs (open decision 13), property checks with a
  scratch data store, an outgoing-call grant per world (open decision 14's permissions question), memory measurements
  per world (open check 1), and rejection records (open decision 12);
- atomic calls: a call's data writes commit when it succeeds and are dropped when it fails, changing
  `test/concurrency.test.ts` and `design.md` to match;
- Stryker as the mutation testing tool;
- a property check that runs out of budget on an input is reported with that input, unshrunk, and shrinking stops at
  the first smaller input that runs out of budget (2026-10-13);
- br (beads, prefix `pw`) as the project's tracker, and the 2026-10-13 review's nine recommendations as the direction
  in `plan.md`: world pages on an origin of their own; serializable calls; all of a world's VM work in its own isolate;
  a time budget in time that bounds a whole operation; incidents grouped by kind with bounded writes; a `data.list`
  that never truncates silently; the domain free of pi-durable; new worlds granted no other world; source-log replay
  as the upgrade path. Each is filed, not scheduled; the numbers inside them are not approved;
- `evaluation.md` removed: its findings live in `design.md` and this file.

Nothing else is approved: the package's home (standalone or upstream in pi), the scheduling of any bead, the web UI
stack, dependency choices beyond those named here, and every other policy question go back to the operator.

## Prototype assumptions

Made on 2026-10-06 under the prototype authorization above. Each is a default to revisit, not a settled decision.

- **Open decision 2, web UI stack:** Preact with TSX, bundled by esbuild into `public/`, served as celld static
  assets. No CSS framework.
- **Open decision 5, REST authentication:** none. The fleet is reachable only on the tailnet, and anyone on it can
  call every route, including the account routes.
- **Open decision 7, layout:** by capability: `world/`, `revision/`, `check/`, `agent/`, `conversation/`,
  `account/`, `directory/`, `cell/`, `api/`.
- **The host rewrite's parser** (open decision 9): `acorn`, with `acorn-walk` for the call graph. Flagged: the
  operator approved the rewrite, not a parser.
- **What the rewrite covers** (open decision 9): top-level `function` and `class` declarations become definitions,
  with a JSDoc comment as the doc. A top-level `const` stays a local of the evaluation, because turning it into
  `state` would keep its first value and silently ignore a changed initializer. A class that changes shape still
  needs an explicit `define` with `version` and `migrate`.
- **When counterexamples re-run** (open decision 13): after every develop, for every enrolled check, not only after a
  change to a definition the check calls: a change to state can make a check vacuous too, and each re-run costs a
  restore of a few milliseconds. A develop after which a counterexample no longer applies is rejected like one after
  which the check no longer fails on it; the operator removes a check that no longer fits.
- **Checks run against a scratch data store** (settled by the operator's approval of property checks, 2026-10-12):
  each check evaluation, and each generated input of a property check, gets a fresh, empty in-memory store; a check
  never reads or writes the world's data. A develop and a counterexample still cannot touch data.
- **Property checks** (flagged choices inside the approved idea): a generator is JSON the host interprets (`int`,
  `bool`, `string`, `oneOf`, `const`, `array`, `record`), so no agent code runs on the host; 50 inputs per run, seeded
  by the revision so a run is deterministic; failures shrink on the choice sequence with at most 200 replays, except
  that an input the check runs out of budget on is not shrunk (operator, 2026-10-13); the heap
  is not reset between inputs, only after the check, so a property that changes heap state sees its own earlier
  changes.
- **Model:** Claude through the subscription; `claude-sonnet-5-5` by default, switchable per world in the UI between
  Sonnet 5.5, Opus 5.5, Haiku 4.5 and Fable 5.1.
- **Credential:** one `AccountCell` holds the fleet's single Claude credential. A pasted `claude setup-token` token is
  accepted as well as the OAuth login.
- **Data:** a key-value table per world (`data.get/set/delete/list`), JSON values, reachable from calls and
  `execute` only, kept in the SQLite of the world's runtime facet. `list` returns at most 1000 rows. A full SQL host
  API is not built.
- **Runtime isolate:** each world's calls run in a facet loaded under a loader id of the world's own, so each world
  compiles its own QuickJS wasm in its own isolate, which costs about 16 MB per world that has run a call on the node
  (25 MB on an x86 desktop; research "Memory per world"). The
  host cell's old `world_data` tables are left in place as backups of the data moved on 2026-10-07; the code that
  moves them can go once no cell from an older build can appear.
- **Concurrent calls:** a world runs up to 8 calls at once, each on its own VM; further calls wait in the cell. Two
  idle VMs are kept warm. Measured against them: a VM of a small world costs about 2.4 MB, so the pool adds at most
  about 20 MB to a world, less than its isolate. The numbers stay.
- **Worlds calling worlds:** any world may call any definition of any other world it is granted (see below); the call carries its chain, and a cycle or a chain of more than four worlds is refused. Calls between worlds
  are for calls only, never for a develop or a check.
- **Incidents** (flagged choices inside the approved idea): only calls of a name the world defines are recorded; one
  open incident per definition and first line of error, counting repeats; opening and closing an incident are each
  one durable commit, and repeats are written together at most every 30 s (`performance.md`, finding 4); arguments over 64 KB are not kept and
  such an incident cannot be retried; a REST caller that sends `Prefer: respond-async` gets `202` and the incident;
  the agent reads incidents and retries them, and only the owner answers or dismisses one.
- **Grants** (the operator's approval of a capability grant per world, 2026-10-12, with the default "existing worlds may
  call any world until the operator restricts them"): a grant names what a world's own calls may reach, today only
  other worlds (`calls`: "any" or a list of ids). It is set by the operator over REST or in the Access tab, never by the
  agent; it binds a world's own outgoing calls and its previews, not the calls other worlds make to it; and a call
  keeps the grant it started with. Effectful host functions and secrets get a field here when they exist.
- **Prelude upgrades:** a world built on an older prelude gets an `upgrade` revision when it opens, and a rollback to
  such a revision applies the upgrade to the restored heap.
- **Pages:** a world serves a page by defining `app(path, query)`, which returns HTML. The page is served at
  `/w/:id/`, with a `world.call(name, ...args)` client injected.
- **Calls discard heap changes:** each call runs on a pooled VM restored from its head, and the VM returns to the
  newest head after the call.
- **`execute` is a preview:** its data writes are rolled back and listed in its result (open decision 3). A world it
  calls through `worlds.call` writes for real.
- **Snapshots are tiered:** the head's blob in the cell's SQLite, every other blob gzipped in R2.
- **Operator develop:** the UI's console can develop a source by hand; it goes through the same attempt as the agent's.

Not built in the prototype: pauses (`restart`), forks and merge by replay, source-log rebuild, the task graph panel,
scheduled world code, and durable messages between worlds.

## Open decisions

1. **Where it lives.** Options are this standalone repo depending on published `pi-durable` and `quickjs-wasi`, or
   `packages/world` upstream in pi, which needs the pi maintainers' agreement.
2. **Web UI stack.** Not chosen.
3. **Preview isolation of data writes.** Settled 2026-10-07 for the world's own data: `execute` rolls its writes back.
   Still open: a world that `execute` calls through `worlds.call` writes for real.
4. **Which record is authoritative.** The design treats the snapshot as primary and the source log as the upgrade
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
9. **Explicit `define` or a host rewrite.** Settled 2026-10-12: the host rewrites top-level `function` and `class`
   declarations into definitions (`src/source/rewrite.ts`), and the revision keeps both the rewritten source, which
   replays, and the source as written.
10. **A requirement id on every revision.** The revision manifest records the producing tool call and nothing about
    intent. A revision could carry the requirement or use case it serves, so a shipped function traces back to why
    it exists.
11. **Harness-owned interrupts by change class.** `restart` is a pause the agent's own code decides. The harness has
    no interrupt of its own. A `develop` that touches checks, data schema or effectful host functions could block for
    the operator by change class, decided in harness code rather than by the agent.
12. **Rejections as records.** Settled 2026-10-12: a rejected develop or a refused check is a numbered `Rejection`
    document beside the revisions, naming its failure and the check it broke, listed at `/rejections`, by the
    `history` tool with `rejected: true`, and in the inspector's Rejected tab.
13. **A check that calls a replaceable definition.** Settled 2026-10-12: allowed, and every develop re-runs every
    check's counterexample; a develop after which a check is no longer seen failing is rejected.
14. **What a call between worlds is.** Recorded 2026-10-06; the operator is researching it. Today it is synchronous
    request and response over Durable Object RPC. Since 2026-10-07 each call runs on its own pooled VM, so a waiting
    call no longer blocks its world (option B below, built at the operator's request: "We should support concurrent
    calls", 2026-10-07). What remains open is whether calls also need durable messages. The options:

    | Option | What it is | Gains | Costs |
    |---|---|---|---|
    | A. RPC under the lock | Built first, replaced by B | Simple | The caller world is busy while it waits |
    | B. RPC on pooled VMs | What is built: each call has its own VM at the head it started from | Other calls and changes proceed while a call waits | One VM per running call (about 1.4 MB each); calls share data between their awaits; no durability |
    | C. Durable messages | `worlds.send(id, name, ...args)`: fire and forget through celld Queues or an outbox the cell drains from an alarm | Survives crashes; the caller is never blocked; retries | At-least-once delivery, so the callee needs idempotency keys; no return value in the calling function, so replies are messages too |
    | D. A and C both | `call` for queries, `send` for commands | Each use gets the semantics it needs | Two mechanisms to explain to the agent; the agent must choose correctly |

    Questions the research should answer:
    - Does a world service need answers inside the calling function (queries), or mostly fire-and-forget effects
      (commands, events)? That separates A from C.
    - Is a busy caller acceptable? Measure how long typical calls take, and how often a world is called while it waits.
    - Delivery: is at-least-once with idempotency keys acceptable, or does some use need exactly-once? celld Queues
      deliver at least once and retry from a lease: "A consumer must therefore tolerate a duplicate."
    - Replay: today only `develop` sources replay, and calls are not recorded. Should calls between worlds be recorded,
      for audit or for rebuilding a world's data?
    - Permissions: who may call whom. Settled 2026-10-12 for the caller's side: a world calls only the worlds its owner
      granted. Still open: whether a callee may refuse callers (open decision 5 for people).
    - Multi-node: a call to a cell on another node is forwarded by celld; latency and failure behaviour are untested.
    - Checks: a check cannot reach other worlds. Is a contract between two worlds something a check should protect?
