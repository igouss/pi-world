# pi-world: plan

Where the project is going, in order. Work is tracked as beads (`br`, prefix `pw`); `br show <id>` gives the full
context, acceptance and operator decision of each. Nothing below is scheduled until the operator schedules it.

## Built

One celld node runs the prototype: the world VM with the prelude, attempts, checks (property checks included),
revisions and rollback, rejections and incidents as records, the agent on the owner's Claude subscription, direct
calls and calls between worlds in each world's own isolate, grants, world pages, tiered snapshots (head in the cell,
history in R2), and the web UI. README.md says what was seen working on the node.

## Next: the design direction (epic `pw-rxw`)

The 2026-10-13 review's recommendations, which the operator agreed with:

1. World pages on an origin of their own, so agent-written HTML cannot use the operator API (`pw-rxw.1`); REST
   authentication follows it (`pw-16t.1`).
2. One runtime per world: develops, checks, enrolment, rollback and prelude upgrades in the world's own isolate, as
   calls already are (`pw-rxw.3`); then a time budget with a stable meaning that bounds a whole operation
   (`pw-rxw.4`).
3. Serializable calls: a call that read data another call changed is rerun (`pw-rxw.2`).
4. Bounded incidents, grouped by kind (`pw-rxw.5`), and a `data.list` that never truncates silently (`pw-rxw.6`).
5. New worlds deny calls to other worlds until granted (`pw-rxw.8`).
6. Source-log replay as the upgrade path for a new QuickJS build (`pw-rxw.9`).
7. The domain free of pi-durable, `World` split by responsibility (`pw-rxw.7`).

## Alongside: findings and debt

- Performance and concurrency findings left open on 2026-10-13 (epic `pw-uhd`): snapshot reads behind the cell's SQL
  queue, the counterexample re-run's starting heap, pool and shrinker test gaps, celld's per-cell request limit, one
  isolate per world.
- Debt the documents had already named (epic `pw-16t`): authentication, the one-time data move, the page client
  injection, snapshot rows over 1.44 MB, celld's unmeasured limits, two-node behaviour, previews that write to other
  worlds.
- The performance review against the approved objectives (epic `pw-djz`, `performance.md`): its fixes are in, and
  its open findings are beads `pw-djz.2` to `pw-djz.13`, among them the 255-world limit (`pw-djz.9`), writes that
  wait for the bucket (`pw-djz.4`) and snapshots stored as pages (`pw-djz.5`). Serializable calls (`pw-rxw.2`),
  changes in the world's isolate (`pw-rxw.3`) and bounded incidents (`pw-rxw.5`) are built; what each still needs is
  in its bead.

## Later: designed, not built

- **Pauses** that survive crashes: `await restart(id, question, options)` (open decision 8; celld Workflows are the
  spiked alternative to a pending promise in a snapshot).
- **Forks** of a world, merged by replaying accepted `develop` sources; needs replay (`pw-rxw.9`).
- **Scheduled world code** on the cell's alarm (spiked: fires within 76 ms, survives a crash a minute late).
- **Durable messages between worlds**, `worlds.send` (open decision 14, option C; celld Queues spiked).
- **A celld fleet** of more than one node, with failover of a running task and of a pending pause.
- **A compiled tier**: a stable, hot function compiled to wasm in a Dynamic Worker and swapped in through the
  registry like any redefinition.
