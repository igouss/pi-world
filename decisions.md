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
  previous snapshot and ends the live image. Compiled code belongs in the compiled tier (`plan.md`, milestone 9);
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
- reaching Claude through the owner's subscription the way pi does: Claude Code's public OAuth client with PKCE and
  the copy-code redirect, refresh in one place, and the token passed to pi-ai as `ANTHROPIC_OAUTH_TOKEN`.

Nothing else is approved: the package's home (standalone or upstream in pi), the first milestone's scope, the web UI
stack, dependency choices beyond those named here, and every other policy question go back to the operator.

## Prototype assumptions

Made on 2026-10-06 under the prototype authorization above. Each is a default to revisit, not a settled decision.

- **Open decision 2, web UI stack:** Preact with TSX, bundled by esbuild into `public/`, served as celld static
  assets. No CSS framework.
- **Open decision 5, REST authentication:** none. The fleet is reachable only on the tailnet, and anyone on it can
  call every route, including the account routes.
- **Open decision 7, layout:** by capability: `world/`, `revision/`, `check/`, `agent/`, `conversation/`,
  `account/`, `directory/`, `cell/`, `api/`.
- **Open decision 9, explicit `define`:** the agent writes `define(...)` and `state(...)` by hand.
- **Open decision 13, a check that calls a replaceable definition:** allowed, with no re-run of its counterexample when
  that definition changes.
- **Checks cannot read data.** A check runs in attempt mode, where data is unreachable. In the first real session the
  agent changed a function's signature (an optional entries argument) to make it checkable. This limits what a check
  can protect.
- **Model:** Claude through the subscription; `claude-sonnet-5-5` by default, switchable per world in the UI between
  Sonnet 5.5, Opus 5.5, Haiku 4.5 and Fable 5.1.
- **Credential:** one `AccountCell` holds the fleet's single Claude credential. A pasted `claude setup-token` token is
  accepted as well as the OAuth login.
- **Data:** a key-value table per world (`data.get/set/delete/list`), JSON values, reachable from calls and
  `execute` only. `list` returns at most 1000 rows. A full SQL host API is not built.
- **Pages:** a world serves a page by defining `app(path, query)`, which returns HTML. The page is served at
  `/w/:id/`, with a `world.call(name, ...args)` client injected.
- **Calls discard heap changes** by restoring the head snapshot after every call and `execute`. This costs a restore
  per call.
- **`execute` keeps its data writes**, so an agent that tries its functions leaves test rows behind unless it cleans
  up.
- **Snapshots are stored raw**, not gzipped, in the cell's SQLite. A row of about 1.4 MB worked on the node.
- **Operator develop:** the UI's console can develop a source by hand; it goes through the same attempt as the agent's.

Not built in the prototype: pauses (`restart`), forks and merge by replay, source-log rebuild, preview isolation,
the task graph panel, and gzip of blobs.

## Open decisions

1. **Where it lives.** Options are this standalone repo depending on published `pi-durable` and `quickjs-wasi`, or
   `packages/world` upstream in pi, which needs the pi maintainers' agreement.
2. **Web UI stack.** Not chosen.
3. **Preview isolation of data writes.** Either a rolled-back transaction around the call, or a scratch copy of the
   touched tables.
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
9. **Explicit `define` or a host rewrite.** The agent writes `define(...)` and `state(...)` by hand, or the host
   rewrites top-level `function`, `class` and `const` declarations into them so the agent writes ordinary
   JavaScript. The rewrite needs a parser on the host.
10. **A requirement id on every revision.** The revision manifest records the producing tool call and nothing about
    intent. A revision could carry the requirement or use case it serves, so a shipped function traces back to why
    it exists.
11. **Harness-owned interrupts by change class.** `restart` is a pause the agent's own code decides. The harness has
    no interrupt of its own. A `develop` that touches checks, data schema or effectful host functions could block for
    the operator by change class, decided in harness code rather than by the agent.
12. **Rejections as records.** A rejected attempt is a tool result in the conversation, which compaction can
    summarise away. The alternative is a revision-family record naming the failing check, so rejections stay
    queryable.
13. **A check that calls a replaceable definition.** Frozen built-ins cover what the language provides. A check can
    still call a function the agent defined, and the agent can redefine it. Either refuse such a check at enrolment,
    so checks read data and built-ins only, or allow it and re-run its counterexample every time that definition
    changes.
