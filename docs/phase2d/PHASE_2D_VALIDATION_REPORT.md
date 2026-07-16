---
title: CHANTER OS Phase 2D Mission Graph Authority Validation Report
version: 1.0.0
status: FOUNDER_REVIEW_REQUIRED
date: 2026-07-16
owner: CHANTER
scope:
  - apps/chanter-Operator
companion: docs/phase2d/PHASE_2D_IMPLEMENTATION_REPORT.md
---

# CHANTER OS Phase 2D — Mission Graph Authority Validation Report

Every command below was run on Windows 10, Node ≥ 22.13, Python 3.10 (real
`python -m governor.mission_intake` transport). No result is simulated; no
failing test is reported as passed.

## 1. Test and quality gates (exact results)

| Gate | Command (from `apps/chanter-Operator`) | Result |
|---|---|---|
| Graph unit + spine suite | `npx vitest run tests/mission-graph.test.ts` (backend) | **17 passed / 17** |
| Full Operator backend suite | `npx vitest run` (backend) | **735 passed / 735** (17 files) |
| Phase 2D real-python integration | `npm run test:phase2d:graph` | **3 passed / 3** |
| Phase 2C integration (regression) | `npm run test:phase2c:mission` | **3 passed / 3** |
| Phase 2A integration (regression) | `npm run test:phase2a:integration` | **2 passed / 2** |
| Phase 2B1 integration (regression) | `npm run test:phase2b1:ledger` | **3 passed / 3** |
| Phase 2B2 integration (regression) | `npm run test:phase2b2:ledger` | **3 passed / 3** |
| Backend typecheck | `npm run typecheck --workspace @chanter/operator-backend` | **clean** |
| Root typecheck (backend + frontend) | `npm run typecheck` | **clean** |
| Backend build | `npm run build --workspace @chanter/operator-backend` | **clean (tsc emit)** |
| Whitespace / conflict markers | `git diff --check` | **clean** (only benign LF→CRLF notices) |
| Stray control characters | byte-scan of all new/changed source | **clean** |

### Reused dependency repositories (unchanged, confirmed green)

| Repository | Command | Result |
|---|---|---|
| chanter-agent-runtime | `npm test` | **294 passed / 294** |
| chanter-loop.governor | `python -m pytest -q` | **1014 passed, 1 skipped, 178 subtests**; 2 HTTP-transport tests flaked, then **passed on isolated re-run** |

Both dependency repos are untouched (clean `git status` at their Phase 2C
HEADs). The two flaky loop.governor failures are in
`tests/test_operator_ledger_port.py` (`test_oversized_http_error_body_rejected`,
`test_redirect_rejected`) — the documented Windows-host `http.server` TCP
flakiness (`ConnectionAbortedError`) from Phase 2C report §8.4. They are in the
HTTP **ledger** port, not the JSON-stdin `mission_intake` transport the graph
uses, and pass deterministically when re-run in isolation (`2 passed in 1.09s`).

## 2. Contract-requirement coverage

Each required validation item mapped to the test that proves it.

| Required validation | Where proven |
|---|---|
| valid two-node graph compiles deterministically | `compiler > compiles the same envelope to byte-identical…` |
| repeated compilation → byte-identical normalized output + same hash | same test (`normalizedJson` + `graphHash` equality) |
| node/dependency ordering normalized deterministically | `compiler > normalizes node ordering and dependency ordering…` |
| unknown action and malformed inputs rejected before persistence | `compiler > rejects unknown actions…`; `spine > rejects malformed graphs at the gateway…` (asserts 0 rows persisted) |
| cycles and invalid dependencies rejected | `compiler > rejects every malformed graph shape…` (missing/self/duplicate/cycle) |
| submit creates approval_required and executes nothing | `spine > submits a valid graph durably as approval_required…` (0 port calls, 0 missions); integration P0 (0 governor tasks) |
| submission/ledger capabilities cannot approve | `spine > keeps graph approval control-owned…`; integration P0 (submit + ledger → 401) |
| control approval binds the exact graph hash | `spine > binds approval to the exact graph hash…`; integration P0 (wrong hash → 409) |
| node A executes exactly once | `spine > executes node A exactly once…` (2 port calls total, A then B); integration P0 (1 governor task for A) |
| node B remains blocked until node A completes | same tests — `node_ready(node_b)` sequenced after `node_completed(node_a)` |
| node B executes exactly once after node A | same tests (createCalls order `[node_a, node_b]`) |
| restart between A and B resumes correctly | `spine > resumes correctly after a crash between node A completion and node B…`; integration crash-boundary test |
| crash/replay does not duplicate child missions, tasks, or loops | `spine > recovers a crash after the downstream side effect…`; integration crash-boundary (2 tasks / 2 loops after recovery) |
| distinct graphs do not cross-talk | `spine > keeps distinct graphs fully isolated`; integration concurrency (4 tasks / 4 loops, per-graph events) |
| node terminal failure → deterministic graph failure | `spine > terminates the graph deterministically when a node fails terminally` |
| completed graph approval replay returns same result | `spine > replays a completed graph approval…`; integration P0 (replayed: true, no new loop) |
| Phase 2C tests remain green | `test:phase2c:mission` 3/3; full backend suite includes unchanged Phase 2C files |
| Phase 2A/2B1/2B2 regressions remain green | integration suites 2/3/3 all green |
| typecheck, build, git diff --check pass | §1 gates |

## 3. P0 acceptance scenario — real-python evidence

`npm run test:phase2d:graph`, test *"Phase 2D P0: two-node sequential graph
executes A before B through the real python spine, with replay and restart
safety"* proves, against the real `governor.mission_intake` process:

1. A cyclic two-node graph is rejected `400 GRAPH_DEPENDENCY_CYCLE`.
2. Submission without / with the wrong capability → `401`; with the submit
   capability → `201 approval_required`, **0 governor tasks** (nothing executed).
3. Identical resubmission → `200 replayed:true`, same graph hash.
4. Submit token and ledger token cannot approve → `401`.
5. Approval with the wrong hash → `409 OPERATOR_GRAPH_APPROVAL_HASH_MISMATCH`,
   still **0 governor tasks**.
6. Control approval with the exact hash → `200 completed`; **exactly 2 real
   governor tasks and 2 real loops** exist on disk; node B's `node_ready` event
   is strictly sequenced after node A's `node_completed` event.
7. Each child (`graph:<id>:node:node_a`, `…node_b`) is an ordinary Phase 2C
   mission: `status: succeeded`, execution `completed`, and an Agent Run Ledger
   run with `product_id: loop_governor`, `production_impact: false`.
8. Approval replay → `200 replayed:true completed`, still 2 tasks / 2 loops.
9. Operator restart → durable GET is byte-identical (`deepEqual`); post-restart
   approval replay stays exact, still 2 tasks / 2 loops.
10. Capability tokens appear nowhere in the SQLite files or the Loop Governor
    data tree (byte-scan clean).

The crash-boundary test additionally injects an Operator crash *after node A
completes but before node B is scheduled*: the crashed approval returns `500`
with exactly **1** task/loop; after restart node A is durably `completed`, node
B `blocked`, the graph `running`; `resume` completes the graph with exactly
**2** tasks/loops — node A recovered (not re-executed), node B run once.

## 4. Repair log (bounded)

Two defects were found and fixed during validation; both were **test defects**,
not service defects, and each took one bounded edit:

1. Unit test *"keeps distinct graphs fully isolated"* asserted two graphs with
   identical node content share a graph hash. Corrected: the hash binds full
   graph identity (`graphId`/`traceId`), so distinct graphs have distinct
   hashes — assertion flipped to `not.toBe`. This is the intended strict-binding
   property (implementation report §5).
2. Integration P0 test resubmitted a freshly-timestamped envelope for the replay
   assertion and captured restart state before a mutating replay-approval. Both
   corrected in the test to present identical bytes for idempotent replay and to
   capture canonical state immediately before the restart boundary. No service
   change was required — the `409 OPERATOR_GRAPH_PAYLOAD_MISMATCH` on a changed
   `requestedAt` is the correct, intended behavior.

No service logic was weakened to make a test pass; no test was skipped or
`.only`-scoped; no assertion was removed to hide a failure.

## 5. Behavioral guarantees validated

- Deterministic compilation and stable SHA-256 graph hashing (identity-bound).
- Closed-world rejection of unknown fields, unknown actions, duplicate/missing/
  self/cyclic dependencies, and over-limit graphs — **before** persistence.
- Durable, additive, migration-free graph/node/edge/event model with guarded
  closed lifecycle state machines.
- Submission never approves; control approval binds the exact immutable graph
  hash; approval actor + basis persisted durably; changed content rejected.
- Dependency-aware scheduling: dependents run only after all dependencies
  complete; recoverable failure blocks dependents; terminal failure
  deterministically terminates and cancels the rest.
- Restart safety before approval, between nodes, and after a downstream side
  effect; graph and approval replay are idempotent; no duplicate child missions,
  tasks, or loops under crash/replay.
- Complete lineage (graph events → node → child mission journal → Agent Run
  Ledger) preserved and projected from canonical durable state.
- Full backward compatibility with Phase 2C / 2A / 2B (all suites green,
  no accepted file touched).

## 6. Remaining risks

1. **Bounded P0 shape.** Max 8 nodes, sequential dispatch, no loops/branching/
   plugins by design; larger or parallel graphs are future phases.
2. **Windows loop.governor HTTP flakiness** persists (environmental, unrelated
   to Phase 2D and to the graph transport); disclosed, re-run-clean.
3. **Graph-level escalation** of a stuck child is surfaced but driven through the
   existing per-child control routes, not a dedicated graph verb (§14.3 impl).
4. **Line endings:** Git will normalize LF→CRLF on the edited files (benign
   `git diff --check` notices only); no content change.

## 7. Final repository state at validation

- chanter-Operator: 6 modified + 4 new files (5 source/config + graph modules +
  2 test files + 2 reports), branch `master`, baseline `0dd8eb1`.
- chanter-agent-runtime, chanter-loop.governor, chanter-mcp-server: **untouched**
  (clean at their Phase 2C HEADs).
