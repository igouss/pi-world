# pi-world: intent

A live application world that an agent grows by talking to it, in the style of
[jiti](https://github.com/ghuntley/jiti), but WASM-native: the world is a snapshotable QuickJS heap
([`quickjs-wasi`](https://www.npmjs.com/package/quickjs-wasi)) driven by
[`@earendil-works/pi-durable`](https://github.com/earendil-works/pi/tree/main/packages/durable). It is deployed on
[celld](https://celld.dev/), a self-hosted implementation of Cloudflare Durable Objects, with GCS buckets for storage.
People use it through a REST API and a web UI. There is no TUI.

## What it does

- The agent changes the world with `develop(source)`. Each attempt runs against an in-memory checkpoint. Safety
  invariants decide whether it is accepted as a new revision or restored.
- The checks are not part of the world. The agent can propose a check, and it is enrolled only after it has been
  seen failing on a counterexample. The agent cannot change or remove one.
- Accepted definitions are ordinary functions. They can be called directly through the REST API, without a model
  request. The agent is needed to grow the application, not to run it.
- Definitions and state go through a prelude installed at revision 0: `define(name, impl)` and
  `state(name, init, { version, migrate })`. A redefinition reaches every caller, and re-evaluating a source keeps
  its state.
- A job can pause on a decision (`await restart(id, question, options)`), and the pause survives crashes, eviction
  and moves between nodes (designed, `plan.md`). It is a pending promise in a stored snapshot, and it resumes when an answer arrives.
- Every revision is immutable. Rollback creates a new revision. Worlds fork cheaply, and forks merge by replaying
  accepted `develop` sources (designed, `plan.md`).
- Code lives in the heap and is versioned by revisions. Data written by end-user calls lives in SQLite tables, reached
  through host functions.

## Position

pi-world is the fastest possible implement-and-check loop for one kind of artifact: a program that grows through
prompting, where the result is validated and iterated on immediately. It is one station of a larger line, not the
line. What it does not supply, and a surrounding pipeline would: a requirement spine, ownership of the gates by
someone other than the implementing agent, an acceptance stage, and a ledger that outlives the conversation.

## Interfaces

- **Agent tools:** `develop`, `execute` (a preview), `describe`, `history`, `rollback`, `propose_check`, `incidents`
  and `retry_incident`. The `world` observation section shows revision-level facts only, so the prompt cache holds.
  Pauses add an `answer` path; forks add `fork`.
- **REST API** (Worker routes, forwarding to the world's cell): create and list worlds; submit to the agent with a
  `requestId` so a retry does not submit twice; call a definition directly, with no model; history, rollback, checks,
  incidents, data and grants. README.md, "Interfaces", lists every route. Pauses and forks add their routes when built.
- **Web UI** (static assets): the conversation over a hibernatable WebSocket, and an inspector of revisions,
  rejections, functions with who calls whom, checks, incidents, data and access.

## Documents

- `design.md`: the constraints the implementation obeys.
- `plan.md`: where the project is going, in order, with the beads that track it.
- `research.md`: what the spikes showed, the celld facts the design rests on, open checks, and what is not verified.
- `decisions.md`: the operator's decisions, what they approve, and the open decisions.
