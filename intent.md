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
  and moves between nodes. It is a pending promise in a stored snapshot, and it resumes when an answer arrives.
- Every revision is immutable. Rollback creates a new revision. Worlds fork cheaply, and forks merge by replaying
  accepted `develop` sources.
- Code lives in the heap and is versioned by revisions. Data written by end-user calls lives in SQLite tables, reached
  through host functions.

## Position

pi-world is the fastest possible implement-and-check loop for one kind of artifact: a program that grows through
prompting, where the result is validated and iterated on immediately. It is one station of a larger line, not the
line. What it does not supply, and a surrounding pipeline would: a requirement spine, ownership of the gates by
someone other than the implementing agent, an acceptance stage, and a ledger that outlives the conversation.

## Interfaces

- **Agent tools:** develop, execute, preview, save_as, functions, describe, status, reset, history, rollback, answer,
  abort, propose_check. The `world` observation section shows the revision, a catalogue summary, failing goals and open pauses.
- **REST API** (Worker routes, forwarding to the world's cell):
  - `POST /worlds` creates a world; `POST /worlds/:id/fork` forks one.
  - `POST /worlds/:id/messages` submits to the agent, with a `requestId` so retries don't submit twice.
  - `POST /worlds/:id/call/:fn` is the direct call path (no model).
  - `POST /worlds/:id/pauses/:pauseId/answer` answers a pause, with a `requestId`.
  - `GET /worlds/:id/revisions`, `GET /worlds/:id/functions`, and `POST /worlds/:id/rollback` cover history and the
    catalogue.
  - `GET /worlds/:id/checks` lists the checks. Removing or loosening one is an operator call that carries a reason.
- **Web UI** (static assets):
  - Conversation view over a WebSocket fed by `Conversation.watch()`, or `watchEvents()` for message-style events.
  - World inspector: revisions, catalogue, failing goals, open pauses with answer buttons.
  - Task graph panel from `harness.watchTaskGraph()`.

## Documents

- `design.md`: the constraints the implementation obeys.
- `plan.md`: milestones and where to stop for review.
- `research.md`: what the spikes showed, the celld facts the design rests on, open checks, and what is not verified.
- `decisions.md`: the operator's decisions, what they approve, and the open decisions.
- `evaluation.md`: the review of this intent against its sources, 2026-10-05.
