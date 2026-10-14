# perf: pi-world's performance harness

Scenarios that put a measured, open-loop load on a pi-world server, sample the celld process while they run, and
judge the results against the objectives the operator approved (`objectives.ts`, bead `pw-djz`).

```sh
npm run perf -- list                      # scenarios, the objectives each judges, their parameters
npm run perf -- dev up                    # build, then start a clean celld dev on port 8791
npm run perf -- run read-call chain       # run scenarios against celld dev; results go to perf/results/dev/
npm run perf -- run read-call --set rate=200 --set duration=30
npm run perf -- report                    # the verdicts of the newest result of each scenario
npm run perf -- gate                      # exit 1 if a valid verdict of the newest results fails
npm run perf -- dev down
```

A run against the deployed node needs the operator's approval of that run, its rate, duration and target, quoted:
`--target node --approval "<the operator's words>"`. The approval is stored in the result file. Run from the node
itself (`ssh oracle-arm`, then `npm run perf -- run ... --target node`), the client is on loopback and its latencies
judge the objectives. Run from elsewhere, latencies include the tailnet and are reported as `n/a`.

## How it measures

- **Open loop, safe against coordinated omission.** Each request has an intended start fixed in advance by the
  stream's arrival rate (uniform or seeded Poisson), and its latency runs from that intended start to the answer. A
  server that stalls is charged for every request that arrived during the stall. `lib/open-loop.test.ts` shows the
  difference on a simulated stall: closed-loop service time hides it, open-loop latency does not. The test fails
  if latency is measured from the actual send instead.
- **HdrHistogram.** Latencies are recorded in microseconds at three significant digits. A result file keeps p50,
  p90, p99, p99.9 and the maximum, and the compressed histograms, so runs can be merged or re-analysed later.
- **Its own lag.** The generator records how late it sent each request (`sendLag`). If its p99 is above 5 ms, the
  client limited the run, and every latency verdict of that stream is marked `n/a`.
- **Failures counted, never dropped.** A failed call (any status but 200 with `ok`), a wrong value, a refusal or a
  request still open after the drain is a failure, counted by kind and recorded with its latency.
- **The server, sampled.** Once a second, a shell loop on the celld host reads per-thread CPU and resident memory
  from `/proc`, and celld's `/state` from its internal listener (resident cells, admission queues, isolates). On the
  node it runs over ssh with `sudo -n`, because celld runs in a container as another user.

## Scenarios

| Scenario | Objectives | What it does |
|---|---|---|
| `read-call` | O1a, O6a, O7 | Currency's `convert` at the rated read-only rate |
| `write-call` | O1b, O6b, O7 | Demo todos' `setTodo`, one data write per call, over 50 keys |
| `cold-call` | O1c | Evicts the world's cell through celld's operator route, then times the first call |
| `chain` | O2, O7 | Dashboard → Trip budget → Currency, beside a direct call to Currency |
| `develop` | O3, O7 | Develops in worlds with 0, 1, 10 plain and 1, 10 property checks |
| `stall` | O4, O9 | A victim world at 10 calls/s while another world computes in a call, in a develop, and in property checks |
| `worlds` | O5a | Opens worlds one after another, each with a develop and a call, until they stop answering |
| `overload` | O8 | Twice the rated read-only rate into one world |
| `lost-update` | correctness | Concurrent read-modify-write calls, with and without an await between the read and the write |

The fixtures (`lib/fixtures.ts`) are the node's own worlds: Currency, Trip budget, Dashboard and Demo todos. The
world ids they call are replaced, so the load has the shape of what the node holds. Every fixture world is named
`loadtest-<scenario>-<run>-…` and forgotten from the directory when the scenario ends (`--keep` keeps them).

## Adding a scenario

Write `scenarios/<name>.ts` exporting a `Scenario`, add it to `scenarios/index.ts`, and judge only against
`OBJECTIVES`. `ctx.load` runs a phase of concurrent streams and samples the server. `ctx.judgeLatency`,
`ctx.judgeFailures` and `ctx.verdict` record verdicts. `ctx.operator` reaches celld's `/state` and `/evict`.

## Files

- `objectives.ts`: the approved numbers, the only place they live.
- `bin/perf.ts`: the command line.
- `lib/open-loop.ts`, `lib/histogram.ts`: the generator and its histograms.
- `lib/api.ts`: pi-world's REST API as the generator uses it.
- `lib/sampler.ts`, `lib/operator.ts`: celld's process and operator routes.
- `lib/scenario.ts`, `lib/result.ts`: what a scenario gets, and what a run records.
- `results/<target>/<scenario>-<time>.json`: one file per run. Committed baselines are the evidence the findings cite.
