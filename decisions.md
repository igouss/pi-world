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
  of open decisions 4 and 10 to 13;
- the split of the intent into `intent.md`, `design.md`, `plan.md`, `research.md` and this file.

Nothing else is approved: the package's home (standalone or upstream in pi), the first milestone's scope, the web UI
stack, dependency choices beyond those named here, and every other policy question go back to the operator.

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
10. **Checks out of the world.** The design stores invariants and goals in the world under a reserved name, written
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
