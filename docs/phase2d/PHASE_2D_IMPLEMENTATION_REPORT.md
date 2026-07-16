---
title: CHANTER OS Phase 2D Mission Graph Authority Implementation Report
version: 1.0.0
status: FOUNDER_REVIEW_REQUIRED
date: 2026-07-16
owner: CHANTER
scope:
  - apps/chanter-Operator
reused_unchanged:
  - apps/chanter-agent-runtime
  - apps/chanter-loop.governor
read_only:
  - apps/chanter-mcp-server
recommended_path: docs/phase2d/PHASE_2D_IMPLEMENTATION_REPORT.md
builds_on: docs/phase2c/PHASE_2C_IMPLEMENTATION_REPORT.md
---

# CHANTER OS Phase 2D — Mission Graph Authority Implementation Report

## 1. Summary

Phase 2D adds the smallest production-grade **executable mission graph** on top
of the accepted Phase 2C generic mission spine. It proves CHANTER can compile,
approve, persist, execute, recover, and project a dependency-aware multi-node
mission — without creating a second execution authority.

New end-to-end capability, proven with real components at every hop:

```text
chanter.mission.graph.v1 structured graph input
  -> deterministic versioned graph compiler (normalized JSON + SHA-256 graph hash)
  -> durable Operator graph authority (operator_mission_graphs / _graph_nodes /
     _graph_edges / _graph_events), status approval_required
  -> independent control-token approval bound to the EXACT immutable graph hash
  -> bounded dependency-aware node scheduling
  -> each node materialized as an ordinary Phase 2C generic mission
     (deterministic child identity) through the unchanged spine:
       Operator closed-world registry -> GenericMissionService
       -> real chanter-agent-runtime executeMission -> Loop Governor adapter
       -> no-shell JSON-stdin python -m governor.mission_intake
       -> real manual relay loop + mission journal + Agent Run Ledger lineage
  -> durable graph/node lifecycle events and results
  -> restart-safe graph projection and evidence
```

The **P0 acceptance scenario** is implemented and validated: a real two-node
sequential graph where `node_b` depends on `node_a`, node B never starts before
node A completes, and both execute through the exact Phase 2C action registry,
Agent Runtime adapter, JSON-stdin Loop Governor transport, mission journal, and
Agent Run Ledger.

Nothing was executed with a real coding agent, provider, model, publish, or
deploy. The graph layer never runs anything itself — it only schedules Phase 2C
missions and records durable truth.

## 2. Verified baseline before editing (Stage 0)

| Repository | Branch | HEAD at start | State |
|---|---|---|---|
| chanter-Operator | master | `0dd8eb1` | clean, synced with origin |
| chanter-agent-runtime | master | `89eed09` | clean — **reused unchanged** |
| chanter-loop.governor | main | `683a654` | clean — **reused unchanged** |
| chanter-mcp-server | main | `426f80e` | clean — **not touched** |

Phase 2C contracts confirmed before editing: the closed-world
`missionActionRegistry` (2 entries; `loop_governor.manual_loop.create` on the
generic lane), `GenericMissionService.createMissionFromEnvelope` /
`approveAndExecute` / `reconcileMission` / `resumeSafely`, the 11-state
`GenericMissionJournal`, the additive `operator_missions` spine, the
`chanter.mission.v1` envelope + `envelopeToRuntimeMissionRequest` +
`validateManualLoopInput` + `canonicalEnvelopeJson`, and the three-token
capability isolation on the Express routes.

## 3. Repository ownership decision (STOP-CONDITION analysis)

The task required stopping if the existing authority model could not safely
support graph-level approval without a duplicated authority. It can, and does,
**without duplication**, because of two Phase 2C properties:

1. `GenericMissionService.createMissionFromEnvelope` is already a durable,
   idempotent, replay-safe create keyed by `missionId` + payload hash.
2. Child mission identity is fully derivable from graph state.

Therefore the graph layer is a pure **orchestrator**: it owns compilation,
graph/node/edge/event durable state, approval-of-hash, and dependency
scheduling, but every node executes by calling the unchanged Phase 2C spine
with a deterministic child envelope. No parallel execution path, no second
downstream port, no dynamic action loading. This satisfies "Prefer Operator as
the canonical owner of graph compilation state, graph authority, orchestration
state, and graph projection. Reuse Agent Runtime and Loop Governor through
their existing Phase 2C contracts."

## 4. Exact files changed (chanter-Operator, branch `master`, baseline `0dd8eb1`)

```text
M  apps/backend/src/db/schema.ts   (+87: four additive CREATE TABLE IF NOT EXISTS
                                    + index; Phase 2C tables untouched)
M  apps/backend/src/routes/api.ts  (+70: 6 additive /mission-graphs routes on the
                                    SAME submit/control capability middleware)
M  apps/backend/src/app.ts         (+4/-2: optional missionGraphService pass-through)
M  apps/backend/src/runtime.ts     (+13/-2: construct MissionGraphService over the
                                    existing GenericMissionService)
M  apps/backend/src/server.ts      (+4/-2: wire the new service)
M  package.json                    (+1: test:phase2d:graph script)
?? apps/backend/src/missions/missionGraphCompiler.ts   (468 lines — pure deterministic
                                    chanter.mission.graph.v1 compiler + graph hash)
?? apps/backend/src/missions/missionGraphJournal.ts    (634 lines — durable graph/node/
                                    edge/event journal, closed lifecycle state machines)
?? apps/backend/src/missions/missionGraphService.ts    (958 lines — submit/approve/resume/
                                    cancel + bounded dependency-aware scheduler + projection)
?? apps/backend/tests/mission-graph.test.ts            (907 lines — 17 tests: compiler + spine)
?? tools/phase2d/mission-graph.integration.test.mts    (521 lines — 3 real-python cross-repo tests)
```

**Accepted Phase 2C/2A files NOT touched** (verified via `git status`):
`missionActionRegistry.ts`, `genericMissionService.ts`, `genericMissionJournal.ts`,
`genericMissionLedger.ts`, `loopGovernorRuntime.ts`, every `autoposter_*` and
`operator_missions*` table definition, every existing test. The
`chanter-agent-runtime` and `chanter-loop.governor` repositories were not edited
at all (both clean at their Phase 2C HEADs).

## 5. Contract: `chanter.mission.graph.v1`

Closed-world, additive, versioned. The compiler (`missionGraphCompiler.ts`):

- **rejects unknown graph fields** at the envelope, source, tenant, node, and
  target level (`GRAPH_FIELD_UNSUPPORTED`);
- **rejects unknown actions** — every node target must resolve through the
  Phase 2C `resolveRegisteredMissionAction` on the generic lane
  (`GRAPH_NODE_TARGET_UNREGISTERED`, 409);
- **rejects duplicate node ids** (`GRAPH_NODE_DUPLICATE`);
- **rejects missing dependencies** (`GRAPH_DEPENDENCY_MISSING`);
- **rejects self-dependencies** (`GRAPH_DEPENDENCY_SELF`);
- **rejects dependency cycles** via Kahn's algorithm (`GRAPH_DEPENDENCY_CYCLE`);
- **rejects graphs above the bounded node limit** (`MISSION_GRAPH_MAX_NODES = 8`,
  `GRAPH_NODE_LIMIT_EXCEEDED`);
- **produces deterministic normalized JSON** — nodes sorted by `nodeId`,
  dependencies sorted, keys canonicalized by the Phase 2C `canonicalEnvelopeJson`;
- **produces a stable SHA-256 graph hash** over that normalized JSON;
- **preserves source and trace lineage** (`graphId`, `traceId`, `source`,
  `requestedAt` all retained in the compiled document);
- **runs each node through the exact Phase 2C submission validation**
  (`validateMissionEnvelope` + `validateManualLoopInput` on the reconstructed
  child envelope), so a graph containing a node that could never execute
  (e.g. a rogue input field) is refused **before** it becomes durable.

The graph hash binds the **entire submitted document**, including `graphId`,
`traceId`, and `requestedAt`. This is a deliberate strict-binding choice:
approval attests to exactly the document the founder saw. Idempotent
resubmission therefore requires byte-identical input (the normal case behind a
stable idempotency key); any change yields a typed
`OPERATOR_GRAPH_PAYLOAD_MISMATCH` rather than a silent replace.

## 6. Durable graph model (additive Operator SQLite; no migration)

- `operator_mission_graphs` — one row per graph; `trace_id` UNIQUE,
  `idempotency_key` UNIQUE, immutable `compiled_graph_json` + `graph_hash`,
  `node_count` bounded `1..8`, `CHECK (approval_required = 1)`, and the seven
  graph lifecycle states below; `approved_by` / `approved_at` /
  `approved_graph_hash` record the approval basis durably.
- `operator_mission_graph_nodes` — one row per node; PK `(graph_id, node_id)`;
  `child_mission_id` UNIQUE; `CHECK (product <> 'auto_poster')` (the AutoPoster
  authority can never be reached through a graph node); seven node lifecycle
  states; `attempts` bounded `0..3`.
- `operator_mission_graph_edges` — one row per dependency edge
  (`from_node_id -> to_node_id`).
- `operator_mission_graph_events` — append-only, `UNIQUE(graph_id, sequence)`,
  scoped `graph|node`, recording every lifecycle transition and audit event
  (compile, approve, running, node ready/running/completed, terminal, cancel,
  approval replay).

**Required graph states:** `approval_required`, `approved`, `running`,
`completed`, `failed_recoverable`, `failed_terminal`, `cancelled`.
**Required node states:** `blocked`, `ready`, `running`, `completed`,
`failed_recoverable`, `failed_terminal`, `cancelled`.

Both state machines are guarded by explicit allowed-transition maps and
compare-and-swap `UPDATE ... WHERE current_state = ?` writes
(`GRAPH_JOURNAL_INVALID_TRANSITION`, `GRAPH_JOURNAL_CONCURRENT_TRANSITION`),
mirroring the accepted Phase 2C journal.

## 7. Approval (requirement 6)

- **Submission never approves.** `POST /api/mission-graphs` uses the same
  `OPERATOR_MISSION_SUBMIT_TOKEN` middleware as mission submission; it can only
  create `approval_required` graphs.
- **The control capability approves the exact immutable graph hash.**
  `POST /api/mission-graphs/:graphId/approve` requires
  `OPERATOR_CONTROL_TOKEN` and a body `graphHash` matching
  `^[0-9a-f]{64}$`; a mismatch is `OPERATOR_GRAPH_APPROVAL_HASH_MISMATCH` (409),
  a missing hash is `OPERATOR_GRAPH_APPROVAL_HASH_REQUIRED` (400).
- **Changed graph content after approval is rejected.** Before approval and
  before every recovery pass, `assertGraphIntegrity` recomputes
  `sha256(compiled_graph_json)` and refuses if it no longer equals the stored
  `graph_hash` (`OPERATOR_GRAPH_INTEGRITY_VIOLATION`). The compiled document is
  immutable; there is no route that rewrites it.
- **Approval actor and basis are durable.** `approved_by`, `approved_at`, and
  `approved_graph_hash` are persisted in the same transaction as the
  `approval_required -> approved` transition and its journal event.
- **No internal approval capability is exposed publicly.** There is exactly one
  approval route, gated by the control token; there is no submit-side or
  ledger-side approval path (re-proven by capability-isolation tests).

## 8. Execution (requirement 7)

- Nodes materialize through the existing Phase 2C generic mission path:
  `GenericMissionService.createMissionFromEnvelope` then `approveAndExecute`.
- Every child mission carries `graph_id` / `node_id` lineage via its
  deterministic identity (`graph:<graphId>:node:<nodeId>` for missionId and
  idempotency key; `graph:<traceId>:node:<nodeId>` for traceId) and via
  `metadata.graphId` / `metadata.nodeId` on the child envelope.
- **Deterministic child idempotency keys** make crash re-dispatch exactly safe:
  a replayed dispatch reconstructs a byte-identical envelope and the Phase 2C
  durable create replays instead of duplicating.
- No arbitrary command execution, no dynamic action loading — the compiler and
  the child path both enforce the closed-world registry.
- Scheduling is **bounded**: the scheduler runs at most `nodeCount + 1` passes;
  each node has at most `MAX_NODE_ATTEMPTS = 3` bounded dispatch attempts; each
  child mission still owns its own Phase 2C single bounded retry.

## 9. Dependency behavior (requirement 8)

- A node becomes `ready` only when **every** dependency is `completed`; the
  scheduler picks ready nodes in sorted `nodeId` order.
- **Recoverable node failure keeps dependents blocked:** the graph moves to
  `failed_recoverable`, dependents stay `blocked`, and only an explicit
  `resume` retries.
- **Terminal node failure deterministically terminates the graph:** every
  still-pending node (`blocked` / `ready` / `failed_recoverable`) is
  transitioned to `cancelled` and the graph to `failed_terminal`, in one
  transaction.
- No dependent node can run after an unmet or failed dependency — proven by the
  durable event journal (`node_ready` for a dependent is always sequenced after
  `node_completed` for each dependency).

## 10. Restart and crash safety (requirement 9)

- **Restart before approval** preserves the graph exactly (durable GET is
  byte-identical across a process restart).
- **Restart between node A completion and node B scheduling** resumes correctly:
  node A stays `completed`, node B stays `blocked`, the graph stays `running`,
  and `resume` schedules node B exactly once.
- **Crash after a downstream side effect** does not create a duplicate task or
  loop: the node stays `running`, its child mission holds the durable
  `downstream_result_observed` boundary, and the bounded recovery pass drives
  the Phase 2C `resumeSafely` (zero additional downstream calls).
- **Graph replay does not create duplicate child missions:** deterministic
  child identity + the Phase 2C idempotent create.
- **Completed graph approval replay returns the same result** with no execution
  (`replayed: true`, an audit-only `graph_approval_replayed` event), and a
  replay with a different actor is refused
  (`OPERATOR_GRAPH_APPROVAL_BINDING_MISMATCH`).

Recovery reuses the proven Phase 2C child machinery only: `getMission`,
`approveAndExecute`, `reconcileMission`, `resumeSafely` — the graph layer adds
no new downstream reconciliation logic.

## 11. Projection and evidence (requirement 10)

`GET /api/mission-graphs/:graphId` returns the derived projection: graph
lifecycle state, the immutable normalized graph, every node with its
dependencies / lifecycle state / attempts / result summary / typed error, the
dependency edges, the full append-only event journal, and — for each node — a
live summary of its child mission's Phase 2C status, execution state, permitted
recovery actions, and downstream loop/task ids. The projection is derived
entirely from canonical durable state (no in-memory caches). Complete lineage
is preserved: graph event journal -> node -> child mission journal -> Agent Run
Ledger run + transitions, all queryable through existing Phase 2C routes.

## 12. Security properties

- No shell, no dynamic execution: identical to Phase 2C (the graph never opens a
  port; it calls the same GenericMissionService that uses the frozen
  `python -m governor.mission_intake` JSON-stdin transport).
- Closed-world everywhere: unknown graph fields, unknown actions, and rogue
  child inputs are rejected at compile time before persistence.
- Capability separation preserved: submit cannot approve, control cannot submit,
  ledger can do neither — re-proven on the new `/mission-graphs` routes.
- Tokens never persisted: byte-scans over the SQLite db/-wal/-shm AND the entire
  Loop Governor data tree after full two-node graph execution — clean.
- Protected-value guard: compiled normalized JSON, approval actor, and
  cancellation reason are all screened against configured protected values.

## 13. Migrations

None. All schema is `CREATE TABLE/INDEX IF NOT EXISTS`; existing databases gain
four empty tables on next open. Rollback = revert the working tree; the new
tables are inert if unused. Phase 2C and 2A tables, columns, indexes, and CHECKs
are byte-identical.

## 14. Known limitations (disclosed, not hidden)

1. `MISSION_GRAPH_MAX_NODES = 8` and no loops / conditional branching / dynamic
   plugins — deliberate P0 non-goals.
2. The scheduler executes nodes sequentially within one approval call (bounded
   passes). Independent parallel nodes are dispatched one after another in
   sorted order, not concurrently — correctness over throughput at founder-gated
   volume.
3. Graph-level recovery resolves each interrupted node through one bounded pass;
   a child mission that requires an explicit human `Stop / escalate` decision is
   surfaced (node `failed_recoverable` with the child's permitted actions) and
   is driven through the existing per-child control routes, not a new
   graph-level escalation verb.
4. `GET /api/mission-graphs` (list) is additive and independent; it does not
   merge into the AutoPoster cockpit list (no UI work in this phase).
5. The real python transport adds ~0.2 s per node (interpreter startup) — the
   same Phase 2C characteristic, now paid per node.

## 15. Recommended commit message (chanter-Operator only)

```text
feat(operator): add durable executable mission graph authority (Phase 2D P0)
```

See the companion [Validation Report](PHASE_2D_VALIDATION_REPORT.md) for every
command, exact counts, and the replay / restart / crash / capability evidence.
