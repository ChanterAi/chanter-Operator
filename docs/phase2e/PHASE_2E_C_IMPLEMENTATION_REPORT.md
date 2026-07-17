# Phase 2E-C Implementation Report — Autonomous Result Observation, Convergence, and Escalation (P0)

## 1. Objective and scope actually implemented

Phase 2E-B left the AutoPoster graph lifecycle dependent on a manual,
founder-triggered result refresh. Phase 2E-C removes that dependence: a
durable, Operator-owned observation loop now automatically observes every
completed AutoPoster schedule node with a valid downstream queue binding,
persists truthful evidence through the exact reviewed Phase 2E-B path,
converges the durable observation job and the per-node result projection
deterministically, and escalates to a human only when automatic convergence
is impossible or genuinely requires one. **Mission graph/node execution
state stays immutable throughout** — Phase 2E-C converges provider-outcome
state, never execution state; see §9 for the exact canonical model and the
[validation report](PHASE_2E_C_VALIDATION_REPORT.md)'s §0 for the same model
with direct test evidence.

Phase 2E-C P0 is **scheduler-ready, not self-scheduling**: the batch
entrypoint (`AutoPosterObservationService.runObservationBatch`, routed as
`POST /api/autoposter-observations/run`) is a complete, idempotent,
safe-to-call-repeatedly unit of work, but nothing in this phase invokes it
on a timer — an external caller (human, script, or a future in-repo
scheduler) must trigger each batch.

Implemented exactly as scoped:

- durable observation job model (additive tables, closed-world statuses)
- automatic, idempotent, replay-safe job scheduling on node completion
- atomic lease-based due-job claiming (no double claim, safe lease recovery)
- observation execution strictly through Operator → Agent Runtime → AutoPoster
  strict status contract (reuses the exact Phase 2E-B `getPostStatus` /
  `refreshNode` path — no new provider surface, no shell execution)
- deterministic bounded backoff policy (15s / 30s / 60s / 120s…, max 8
  attempts), fully configurable and validated against closed bounds
- deterministic outcome classification into the four required classes plus
  one internal `transport_retry` class for bounded-retry transport failures
- durable per-job escalation (exactly one per job, open/acknowledged/
  resolved/dismissed)
- internal Operator control-authority operational surface (run batch,
  inspect job, list jobs, list/inspect/acknowledge/resolve escalations)
- structured telemetry as an append-only per-attempt table
- full validation across Operator, and confirmation that Agent Runtime,
  AutoPoster, and MCP Server needed **no changes**

No repository outside `chanter-Operator` was modified. This satisfies the
spec's stated preference ("Prefer Operator-only implementation by reusing
Phase 2E-B contracts") because the existing Phase 2E-B
`AutoPosterResultProjectionService.getPostStatus` / per-node refresh path
already provides a byte-exact, identity-validated, fail-closed strict read of
AutoPoster truth through the Agent Runtime contract — Phase 2E-C reuses it
unmodified as its only provider-observation call.

## 2. Verified baseline

Confirmed clean and matching before any edit:

| Repository | HEAD | Branch | Status |
|---|---|---|---|
| chanter-Operator | `bcf67ee` | master | clean |
| chanter-agent-runtime | `2fdff24` | master | clean |
| chanter-auto-poster | `9f1e0c2` | main | clean |
| chanter-mcp-server | `69606ad` | main | clean |

## 3. Repositories and files changed

**Only `chanter-Operator` changed.** `chanter-agent-runtime`,
`chanter-auto-poster`, and `chanter-mcp-server` remain at their exact pinned
HEADs with clean working trees (verified in §7) — the existing Phase 2E-B
`AutoPosterPostStatusView` / `getPostStatus` contract already carried every
truthful field Phase 2E-C needed (`status`, `providerStatus`, `approved`,
`lastResult`, `history`, `updatedAt`, identity bindings), so no additive
Agent Runtime or AutoPoster contract change was required.

### New files

- `apps/backend/src/missions/autoPosterObservationService.ts` (1446 lines) —
  the entire Phase 2E-C observation loop: job model views, policy
  validation, scheduling, claiming, execution, classification, convergence,
  escalation, and the bounded read surface.
- `apps/backend/tests/autoposter-observation-loop.test.ts` (1265 lines) —
  the Phase 2E-C validation suite (19 tests, §8/§9).

### Modified files

- `apps/backend/src/db/schema.ts` — additive table/index SQL for
  `operator_autoposter_observation_jobs`, `operator_autoposter_observation_attempts`,
  `operator_autoposter_observation_escalations`, plus their closed-world
  status/outcome-class constant arrays.
- `apps/backend/src/db/database.ts` — `migrateAutoPosterObservationTables`:
  additive, transactional, fail-closed migration (same pattern as the
  reviewed Phase 2E-A/2E-B migrations); wired into `createDatabase`.
- `apps/backend/src/missions/autoPosterResultProjectionService.ts` — added
  `observeNodeResult(graphId, nodeId)` (a thin single-node wrapper around the
  exact existing `refreshNode` path — no behavior change to the reviewed
  Phase 2E-B refresh) and one crash-injection boundary
  (`after_status_read_before_persistence`) used only by tests.
- `apps/backend/src/missions/missionGraphService.ts` — added an optional
  `observationScheduler` hook invoked exactly once, after
  `after_node_completed_persistence`, only for `product === "auto_poster"`
  nodes that just durably transitioned to `completed`. The hook is
  fire-and-forget (wrapped in try/catch by the caller in
  `AutoPosterObservationService.onAutoPosterNodeCompleted`) and never mutates
  graph truth or throws back into the scheduler.
- `apps/backend/src/routes/api.ts` — seven new routes under
  `/api/autoposter-observations/*`, all gated by the existing operator
  control capability token (`missionControlTokenMiddleware`) — the same
  isolation model as graph approval and the Phase 2E-B manual refresh.
- `apps/backend/src/app.ts`, `apps/backend/src/runtime.ts`,
  `apps/backend/src/server.ts` — threaded the new
  `AutoPosterObservationService` through construction and route wiring.
- `apps/backend/src/config.ts` — optional, closed-bound-validated env
  overrides for the polling policy
  (`OPERATOR_OBSERVATION_RETRY_DELAYS_SECONDS`, `_MAX_ATTEMPTS`,
  `_LEASE_SECONDS`, `_BATCH_SIZE`); any out-of-bounds value is ignored in
  favor of the reviewed P0 default rather than silently accepted.

Diff stat for tracked-file changes (new files are untracked and listed
above):

```
apps/backend/src/app.ts                            |   4 +-
apps/backend/src/config.ts                         |  37 +++++
apps/backend/src/db/database.ts                    |  83 +++++++++++
apps/backend/src/db/schema.ts                      | 164 +++++++++++++++++++
apps/backend/src/missions/autoPosterResultProjectionService.ts |  43 +++++-
apps/backend/src/missions/missionGraphService.ts   |  17 +++
apps/backend/src/routes/api.ts                     | 125 ++++++++++++++++
apps/backend/src/runtime.ts                        |  14 +-
apps/backend/src/server.ts                         |   4 +-
9 files changed, 484 insertions(+), 7 deletions(-)
```

## 4. Schema and migration details

Three additive tables (SQLite, `chanter-Operator/apps/backend/src/db/schema.ts`),
migrated by `migrateAutoPosterObservationTables` in `database.ts` using
the exact reviewed Phase 2E-A/2E-B pattern: compare existing table SQL
byte-for-byte against the reviewed definition; refuse (throw) on any unknown
variant; create missing tables inside one `withTransaction`; verify the
post-migration schema and `PRAGMA foreign_key_check` before returning.

### `operator_autoposter_observation_jobs`

One row per `(graph_id, node_id)` (`UNIQUE(graph_id, node_id)`), primary key
`observation_job_id`. Columns exactly cover the spec's required field list:
`observation_job_id, graph_id, node_id, mission_id (UNIQUE), workspace_id,
connected_account_id, account_id, provider, queue_job_id (UNIQUE),
source_binding_json, source_binding_hash, status, attempt_count,
max_attempts, next_attempt_at, lease_owner, lease_expires_at,
last_attempt_at, last_success_at, last_error_code, last_error_message,
convergence_reason, created_at, updated_at`. Foreign key to
`operator_mission_graph_nodes(graph_id, node_id)`.

Status CHECK is the closed world:
`pending, leased, observing, waiting, converged, escalation_required,
failed_terminal, cancelled` — exactly the eight required statuses.

### `operator_autoposter_observation_attempts`

Append-only per-attempt telemetry, `UNIQUE(observation_job_id,
attempt_number)`. Records provider, lease owner, timing, latency,
`outcome_class`, the underlying Phase 2E-B `refresh_outcome`, projection
status, reason code, retry delay, next-attempt time, and error code/message.
Never stores tokens, credentials, or raw provider payloads — only the same
allowlisted fields the Phase 2E-B projection already stores.

### `operator_autoposter_observation_escalations`

`UNIQUE` on `observation_job_id` — a database constraint, not just
application logic, that makes a second escalation for the same job
structurally impossible. Required fields: `escalation_id, graph_id,
node_id, reason_code, severity, human_action_required,
recommended_human_action, summary, evidence_refs_json, status,
acknowledged_by/at, resolved_by/at, resolution_note, created_at, updated_at`.
Status CHECK: `open, acknowledged, resolved, dismissed`.

Indexes: `idx_..._jobs_due (status, next_attempt_at, observation_job_id)` for
efficient due-job scans; `idx_..._attempts_job`; `idx_..._escalations_status`.

Migration is idempotent (verified: fresh create → close → reopen produces no
diff) and fail-closed (verified: a pre-existing table with an unreviewed
schema throws `Phase 2E-C migration refused an unknown ... schema` instead of
silently altering it).

## 5. Polling / backoff policy

`AutoPosterObservationPolicy` in `autoPosterObservationService.ts`:

| Field | P0 default | Validated bounds |
|---|---|---|
| `retryDelaysSeconds` | `[15, 30, 60, 120]` | 1–8 entries, each 1–600s |
| `maxAttempts` | `8` | 1–12 |
| `leaseSeconds` | `60` | 5–600 |
| `batchSize` | `8` | 1–16 (route/service hard cap 16) |

Semantics: the first entry is the delay from job creation to the first
attempt (`next_attempt_at = created_at + retryDelaysSeconds[0]`); each
subsequent non-terminal attempt uses `retryDelaysSeconds[min(attemptNumber,
length-1)]` (the last configured delay repeats). With defaults, an
unresolved job's bounded observation window is
`15 + 30 + 60 + 120×5 = 705` seconds across at most 8 attempts, after which
it escalates as `observation_window_exhausted` rather than polling forever.
`validatePolicy()` throws `OPERATOR_OBSERVATION_POLICY_INVALID` on any
out-of-bounds combination — this runs both on service construction and
(indirectly) on `config.ts` env parsing (an invalid env override is dropped,
not silently clamped). No infinite loop, no tight loop, no retry storm: every
bound is a hard integer ceiling enforced before any observation occurs.

## 6. Lease and idempotency invariants

- **Job idempotency**: `observation_job_id = sha256("chanter.autoposter.observation.v1|job|{graphId}|{nodeId}")`
  — a pure function of graph/node identity. `scheduleObservationForNode` is
  called from two paths (the graph-completion hook and the batch backfill
  scan) and both converge on `INSERT ... ON durable existing-row check`:
  a second call with the same immutable `source_binding_hash` returns the
  existing row (`created: false`); a hash mismatch throws
  `OPERATOR_OBSERVATION_BINDING_MISMATCH` (fails closed rather than silently
  rebinding a job to different provider truth).
- **Backfill idempotency**: `backfillObservationJobs` only selects nodes with
  a `LEFT JOIN ... WHERE j.observation_job_id IS NULL` — it can never create
  a duplicate for a node that already has a job.
- **Claim atomicity**: `claimDueJobs` runs inside one `withTransaction`
  (`BEGIN IMMEDIATE` — SQLite's exclusive-write lock), selects due candidates,
  then updates each with a `WHERE` clause re-checking the exact due condition.
  `BEGIN IMMEDIATE` serializes concurrent claimers (in-process or
  cross-process, since it is a real SQLite file lock), so two workers can
  never claim the same row — proven directly in §8.
- **Lease recovery**: a job in `leased`/`observing` becomes claimable again
  once `lease_expires_at <= now`, exactly like a `pending`/`waiting` job
  reaching `next_attempt_at`. Recovery reuses the same atomic claim path — no
  separate "sweep" logic to keep in sync.
- **Attempt idempotency**: `attempt_id = sha256("...|attempt|{jobId}|{attemptNumber}")`
  and the table has `UNIQUE(observation_job_id, attempt_number)`; the attempt
  counter is incremented durably *before* the provider read
  (`observing` transition), so a crash mid-attempt leaves the counter ahead
  of the attempts table — itself truthful evidence of the interruption, not
  a duplicate risk, since the next successful attempt reuses the *next*
  attempt number.
- **Escalation idempotency**: enforced at both the application layer
  (`upsertEscalation` checks for an existing row first) and the schema layer
  (`UNIQUE(observation_job_id)`) — belt and suspenders.
- **Cross-workspace/graph isolation**: every observation reads and writes
  are keyed by the job's own `graph_id`/`node_id`/`workspace_id` bindings,
  which are captured once at scheduling time from the durable
  `autoposter_runtime_missions` / `autoposter_mission_executions` rows and
  never re-derived from ambient state.

## 7. Outcome classification table

`classifyObservationConvergence()` maps every possible Phase 2E-B refresh
result onto exactly one of five outcome classes (the four required classes,
plus one internal bounded-retry class for transport/contract failures):

| Phase 2E-B refresh result | Outcome class | Notes |
|---|---|---|
| `projectionStatus: approved_for_publish / processing / retry_scheduled` | **continue_observing** | spec class A |
| `projectionStatus: uploaded_private` | **converged** | spec class B — the only success terminal |
| `projectionStatus: awaiting_publish_approval` | **escalation_required** (`publish_approval_required` or `publish_approval_revoked`) | spec class C |
| `projectionStatus: provider_accepted_unverified` | **escalation_required** (`provider_accepted_unverified`) | spec class C |
| `projectionStatus: manually_reconciled` | **escalation_required** (`manually_reconciled`) | spec class C |
| `projectionStatus: manual_review_required` | **escalation_required** (identity/contradiction reason) | spec class C |
| `projectionStatus: outcome_unknown` | **escalation_required** (`outcome_unknown`) | spec class C |
| `projectionStatus: failed`, escalation reason `provider_reauthorization_required` | **escalation_required** | spec class C |
| `projectionStatus: failed`, any other reason | **failed_terminal** (`publish_failed` or specific reason) | spec class D |
| refresh outcome `failed`, reason `result_identity_mismatch` / `observation_contradiction` / `schedule_evidence_missing` | **failed_terminal** | spec class D |
| refresh outcome `failed`, reason `result_collection_unavailable` | **transport_retry** | bounded re-observation; never relabels the AutoPoster job |
| any unreviewed/unknown projection status or reason code | **failed_terminal** (`observation_unclassified_status` / `observation_failed_unclassified`) | fail-closed |

`transport_retry` behaves like `continue_observing` for backoff scheduling
purposes (same delay table) but carries its transport error onto the job's
`last_error_code`/`last_error_message` instead of the observed provider
truth, and never fabricates a projection.

**Window exhaustion**: if a `continue_observing` or `transport_retry`
outcome occurs on the job's final permitted attempt
(`attemptNumber >= max_attempts`), convergence escalates it instead
(`observation_window_exhausted`, severity `warning`) rather than either
polling forever or silently failing.

## 8. Escalation semantics

- Created exactly once per job (`upsertEscalation`), status starts `open`,
  `human_action_required = true` always (P0 never auto-creates an
  informational-only escalation).
- Ten known reason codes each carry a fixed severity and a fixed
  recommended human action (`ESCALATION_SEVERITY` /
  `ESCALATION_HUMAN_ACTION` maps) — an unrecognized reason code still
  produces a safe generic escalation (severity `high`) rather than throwing,
  so convergence itself never fails on an escalation reason.
- Evidence references are bounded, opaque identifiers only
  (`graph:`, `node:`, `child-mission:`, `autoposter-queue:`,
  `observation-job:`, `result-projection:`) — never raw provider payloads,
  captions, media URLs, or tokens.
- Control surface: `acknowledgeEscalation` / `resolveEscalation` (disposition
  `resolved` or `dismissed`) are idempotent (replay of the same disposition
  is a no-op returning the existing row) and refuse from any terminal state
  (`OPERATOR_ESCALATION_STATE_TERMINAL`). Both are routed only under the
  Operator control capability token.
- The job that produced the escalation moves to `escalation_required`
  (itself terminal — never reclaimed), so **an escalation can structurally
  never be duplicated by re-observation**, independent of the `UNIQUE`
  constraint.

## 9. Authority boundaries preserved (no contradiction found)

### Canonical state model

Phase 2E-C converges exactly two kinds of durable state, disjoint from
mission graph/node **execution** state:

1. **Mission graph/node execution state**
   (`operator_mission_graphs`/`operator_mission_graph_nodes`) is written
   once, by the Phase 2D/2E-A scheduler, when a node durably completes, and
   is **never** written again — not by Phase 2E-B's manual refresh, not by
   Phase 2E-C's observation loop. Direct inspection of both services
   confirms this: `autoPosterObservationService.ts` and
   `autoPosterResultProjectionService.ts` contain only `SELECT` statements
   against these two tables, no `UPDATE`/`INSERT`. A completed node's
   execution record is immutable regardless of what the provider later
   reports.
2. **Provider outcome convergence** happens in three separate, additive
   structures: the durable per-node **result projection**
   (Phase 2E-B's `operator_autoposter_result_projections`, unmodified), the
   durable **observation job** (`operator_autoposter_observation_jobs`,
   new), and the durable **escalation record**
   (`operator_autoposter_observation_escalations`, new). "Terminal
   success/failure converges the node" — the phrasing used earlier in this
   phase's reports — always meant this layer: the observation job reaches
   `converged` / `failed_terminal` / `escalation_required`, and the Phase
   2E-B result projection's `projectionStatus` reflects the same outcome.
   It never meant the mission graph/node execution record, which item 1
   above proves stays byte-identical.
3. A **graph-level result/outcome view** exists as a derived read over item
   2, not a new stored table:
   `AutoPosterResultProjectionService.getProjections(graphId).batch`
   (Phase 2E-B, unmodified, reused as-is) already aggregates per-node
   result-projection status into a graph-level summary, and
   `AutoPosterObservationService.listEscalations({ graphId })` gives the
   graph-level escalation view. Both converge as nodes are observed and
   neither touches execution state — no additive graph-level projection
   table was needed.

The [validation report](PHASE_2E_C_VALIDATION_REPORT.md) §0 restates this
model with the exact test assertions (three layers, asserted together, for
both the terminal-success and terminal-failure/escalation scenarios) that
prove it directly — including the standalone test "keeps graph and node
execution truth byte-identical through the whole loop" (validation report
§2, additional proofs).

### Boundary-by-boundary confirmation

- **AutoPoster** remains the sole publishing/provider truth authority.
  Phase 2E-C performs zero writes to AutoPoster (proved in §8 —
  `boundary.scheduleCalls.length` and `providerPublishCalls` never change)
  and zero provider adapter calls (`Operator → Agent Runtime strict status
  contract → AutoPoster strict read route` is the only path used; no shell
  execution, no direct HTTP to a provider).
- **Agent Runtime** remains the sole typed normalization/transport boundary
  — Phase 2E-C calls only the existing `getPostStatus` contract through the
  existing `AutoPosterResultProjectionService`, and required no additive
  Agent Runtime contract, since every field the classification table needs
  (`status`, `providerStatus`, `approved`, `lastResult`, `history`) was
  already in the strict `AutoPosterPostStatusView` from Phase 2E-B.
- **Operator** remains the sole owner of graph lifecycle, node status
  (immutable once completed — item 1 above), observation
  scheduling/attempts/leases, result projections (via the unmodified Phase
  2E-B service), and escalation state.
- No single-authority contradiction was found; the objective was achievable
  entirely inside the reviewed Phase 2E-A/2E-B/2D authority model.
