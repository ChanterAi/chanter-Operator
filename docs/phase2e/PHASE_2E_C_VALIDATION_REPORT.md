# Phase 2E-C Validation Report — Autonomous Result Observation, Convergence, and Escalation (P0)

All commands below were run from `chanter-Operator` (or the indicated
subdirectory) after full implementation. No test was skipped; no result
below is fabricated — every command's actual pass/fail output is reproduced
or summarized verbatim.

**Reconciliation note (this revision):** an initial pass of this report used
the phrase "converges the node and graph" for terminal observation outcomes.
That phrasing was imprecise and has been corrected throughout — see
§0 for the exact canonical state model and §2 for the corrected
requirement-9 wording. The underlying implementation and every test result
were already correct; only the report's description of *what* converges was
overstated.

## 0. Canonical state model

Phase 2E-C converges exactly two kinds of durable state, and they are
disjoint from mission graph/node **execution** state:

1. **Mission graph/node execution state** (`operator_mission_graphs`,
   `operator_mission_graph_nodes`) is written once by the Phase 2D/2E-A
   scheduler when a node durably completes, and is **never** written again —
   not by the Phase 2E-B manual refresh and not by the Phase 2E-C
   observation loop. Both services only ever `SELECT` these tables. A
   completed node's execution record is immutable regardless of what the
   provider later reports.
2. **Provider outcome convergence** is represented separately, in three
   additive structures that Phase 2E-C converges instead:
   - the durable **per-node result projection**
     (`operator_autoposter_result_projections`, Phase 2E-B, unmodified —
     Phase 2E-C calls the exact same `refreshNode` path through a new
     `observeNodeResult` wrapper) — reflects the latest confirmed provider
     truth (`uploaded_private`, `failed`, `processing`, …) per node;
   - the durable **observation job** (`operator_autoposter_observation_jobs`,
     new in Phase 2E-C) — reflects the Operator's own scheduling/attempt
     state (`pending` → … → `converged` / `escalation_required` /
     `failed_terminal`);
   - the durable **escalation record**
     (`operator_autoposter_observation_escalations`, new in Phase 2E-C) —
     reflects whether a human is required, independent of both of the above.
3. The **graph-level result/outcome view** is a derived read over structure
   (2), never a fourth stored table: `AutoPosterResultProjectionService
   .getProjections(graphId).batch` (Phase 2E-B, unmodified, reused as-is)
   already aggregates per-node result-projection status into a graph-level
   summary (`awaiting_results` / `outcome_unknown` / `failed` /
   `completed_with_warning`) purely from structure (2)'s first bullet, and
   `AutoPosterObservationService.listEscalations({ graphId })` gives the
   graph-level escalation view from the third bullet. Both converge as
   nodes are observed, and neither requires or performs any write to
   mission graph/node execution state. No new stored graph-level projection
   table was needed — this read model already satisfied the requirement,
   so none was added.

In short: **"terminal success/failure converges the node" always meant the
observation job and the per-node result projection — never the immutable
mission graph/node execution record.** §2 below states this precisely for
every affected requirement, and the targeted test suite (§1) now asserts
all three layers directly in the same test for both the terminal-success and
the terminal-failure/escalation scenarios.

## 1. New Phase 2E-C test suite

```
cd apps/backend
npx vitest run tests/autoposter-observation-loop.test.ts
```

**Result: 19/19 passed** (`Test Files 1 passed (1)`, `Tests 19 passed (19)`).

## 2. Required-proof → test mapping (spec items 1–20)

| # | Required proof | Test(s) | Result |
|---|---|---|---|
| 1 | Successful downstream schedule creates exactly one observation job | `Phase 2E-C automatic observation scheduling > creates exactly one durable pending job per completed schedule node, idempotently` | PASS |
| 2 | Replayed schedule creates no duplicate job | same test (graph-approval replay + direct `scheduleObservationForNode` replay both assert `jobRows` unchanged) | PASS |
| 3 | Due job claim is atomic | `Phase 2E-C claiming, leases, and concurrency > claims due jobs atomically with deterministic ordering and no double claim` | PASS |
| 4 | Two concurrent workers cannot claim the same job | same test (`worker-a` claims 1, `worker-b` claims the other, `worker-c` claims 0 while both are leased) | PASS |
| 5 | Expired lease is recoverable | `... > recovers expired leases safely and never claims terminal or cancelled jobs` | PASS |
| 6 | Non-terminal status schedules the correct next attempt | `Phase 2E-C bounded backoff and outcome convergence > re-observes non-terminal truth on the exact 15/30/60/120 policy and converges terminal success` (asserts `retryDelaySeconds` sequence `30, 60, 120`) | PASS |
| 7 | Terminal success converges the observation job and the graph-level result projection (mission graph/node execution state is immutable — see §0) | same test, extended in this revision with three explicit assertions: (a) `convergedJob.job.status === "converged"` (observation-job layer); (b) `getProjections("phase2ec-graph")`'s youtube node projection is `uploaded_private` and tiktok's is `processing` (graph-level result-projection layer); (c) `operator_mission_graph_nodes` rows captured right after graph completion are byte-identical after full convergence (execution layer, unchanged) | PASS |
| 8 | Human-required status creates exactly one escalation | `... > escalates human-required truth exactly once and classifies terminal provider failure deterministically`; plus `... > classifies reauthorization, manual reconciliation, unverified acceptance, and outcome_unknown as human escalations` (4 reason-code sub-cases); plus crash-recovery test (§4 below) | PASS |
| 9 | Terminal provider failure converges the observation job and the graph-level result projection deterministically (mission graph/node execution state is immutable — see §0) | `... > escalates human-required truth exactly once and classifies terminal provider failure deterministically`, extended in this revision with the same three-layer assertion: (a) `failedJob.job.status === "failed_terminal"` (observation-job layer); (b) youtube node's projection is `failed` and tiktok's is `awaiting_publish_approval` with `escalationReason: "publish_approval_required"` (graph-level result-projection layer, including escalation visibility); (c) `operator_mission_graph_nodes` rows unchanged (execution layer) | PASS |
| 10 | Retry exhaustion becomes failed_terminal or escalation_required per policy | `... > exhausts the bounded window into escalation_required and fails closed on malformed provider truth` (both a `continue_observing` and a `transport_retry` job exhaust to `escalation_required`/`observation_window_exhausted` at `attemptNumber === maxAttempts`) | PASS |
| 11 | Restart before observation preserves state | `Phase 2E-C restart and crash safety > preserves pending jobs across a restart before the first observation` | PASS |
| 12 | Crash after provider read does not duplicate evidence | `... > crash after the provider read but before projection persistence duplicates nothing` | PASS |
| 13 | Crash after projection resumes without duplicate provider work | `... > crash after projection but before job convergence resumes deterministically without duplicate evidence or escalations` | PASS |
| 14 | Completed jobs are never re-polled | `re-observes non-terminal truth...` (explicit assertion: after convergence, `fourth.results` contains only the still-open node; all subsequent `statusCalls` target only that node's `postId`) plus `recovers expired leases...` (`cancelled` job never reclaimed) | PASS |
| 15 | Distinct graphs/workspaces do not cross-talk | `Phase 2E-C workspace and graph isolation > observes every job strictly inside its own graph/workspace binding` (two graphs, two workspaces; every strict read's `workspaceId`/`accountId` matches its own job) | PASS |
| 16 | Unknown or malformed provider status fails closed | `exhausts the bounded window...` (malformed `invalid_response` status read → no fabricated projection, `youtubeProjection === null`); plus the identity-mismatch sub-case (`result_identity_mismatch` → `failed_terminal` on first attempt) | PASS |
| 17 | Submission and ledger capabilities cannot control observation or escalation | `Phase 2E-C capability isolation and escalation control > gates the entire observation surface behind the operator control capability` (all 6 routes × 5 refusal cases incl. submit/runtime/ledger tokens → 401 `CAPABILITY_TOKEN_INVALID`, zero mutation) | PASS |
| 18 | Existing manual refresh remains backward compatible | `Phase 2E-C manual refresh backward compatibility > keeps the Phase 2E-B manual refresh authoritative and side-effect-free for observation jobs` | PASS |
| 19 | Phase 2E-B tests remain green | §3 below (`autoposter-result-projection.test.ts`, `autoposter-result-migration.test.ts`, `test:phase2eb:autoposter-results`) | PASS |
| 20 | Phase 2E-A, 2D, 2C, 2A/2B regressions remain green | §3 below | PASS |

Additional proofs beyond the required 20 (spec validation items 21–22, plus
extra hardening the implementation surfaced as worth proving directly):

- Migration idempotency and fail-closed refusal:
  `Phase 2E-C migration > creates the three observation tables, replays
  idempotently, and refuses unknown variants` — PASS.
- Policy bounds validation (9 invalid configurations each rejected;
  default policy matches the reviewed spec exactly):
  `Phase 2E-C policy validation > refuses out-of-bounds polling
  configuration fail-closed` — PASS.
- Escalation acknowledge/resolve idempotency, terminal-state refusal, and
  dismiss disposition: `... > acknowledges and resolves escalations
  idempotently under control authority only` — PASS.
- Node never observed without a valid downstream binding + interrupted-hook
  backfill: `... > backfills a job lost to a crash between node completion
  and hook execution`, `... > never observes nodes that lack a valid
  downstream binding` — PASS.
- Full byte-identical Phase 2E-A graph/node truth through the entire
  observation loop: `... > keeps graph and node execution truth
  byte-identical through the whole loop` — PASS.

## 3. Regression suites (Phase 2E-B, 2E-A, 2D, 2C, 2B, 2A)

```
cd apps/backend && npx vitest run
```
**Result: 22 test files, 794/794 passed** (first parallel run showed one
timeout in the pre-existing, untouched `tests/runtime-mission-recovery.test.ts`
under full-suite CPU contention — re-run of that file alone passed in 3.9s,
and a second full-suite run passed all 794/794 with zero failures,
confirming the timeout was transient system load, not a regression).

```
npm run test:phase2a:integration    # Phase 2A: 2/2 passed
npm run test:phase2b1:ledger        # Phase 2B1: 3/3 passed
npm run test:phase2b2:ledger        # Phase 2B2: 3/3 passed
npm run test:phase2c:mission        # Phase 2C: 3/3 passed
npm run test:phase2d:graph          # Phase 2D: 3/3 passed
npm run test:phase2e:autoposter-graph      # Phase 2E-A: 3/3 passed
npm run test:phase2eb:autoposter-results   # Phase 2E-B: 2/2 passed
npm run mission:test                # mission-compiler: 26/26 passed
npm run release:test                # release-operator: 23/23 passed
```

All nine integration/tool suites passed with 0 failures. The Phase 2D
integration test's crash-boundary case ("a crash between node A completion
and node B scheduling never duplicates tasks or loops") still passes exactly
as reviewed — confirming the new `observationScheduler` hook call (which sits
immediately after that same `after_node_completed_persistence` boundary) does
not disturb the existing crash-recovery contract.

Frontend workspace (unaffected by this phase, run for completeness):

```
npm run typecheck --workspace @chanter/operator-frontend   # clean
npm run test --workspace @chanter/operator-frontend        # 3 files, 115/115 passed
```

## 4. Crash and restart evidence (verbatim from test assertions)

- **Restart before first observation**: job rows identical before/after
  `harness.close()` + reopen from the same SQLite file; a batch run
  afterward claims and observes normally (`backfilledJobs: 0`).
- **Crash after provider read, before projection persistence**: injected
  failure at the exact Phase 2E-B boundary
  (`after_status_read_before_persistence`). Result: zero result-projection
  rows, zero observation events, job left in `observing` with
  `attempt_count: 1` and zero rows in the attempts table (the burned attempt
  is durably counted but not yet telemetered — itself proof of the crash
  point). After lease expiry (61s), recovery claims the same job, performs
  exactly one more provider read, and persists exactly one evidence row.
- **Crash after projection, before job convergence**: injected failure at
  the observation-service boundary
  (`after_projection_before_job_convergence`), *after* the Phase 2E-B
  projection/evidence write committed. Result: exactly 1 observation event
  persisted (the crash did not roll back the already-committed Phase 2E-B
  transaction), job left `observing` at `attempt_count: 1`, zero
  escalations. Recovery (after lease expiry) replays the observation with
  exactly one more provider read, persists zero *new* evidence rows (Phase
  2E-B's own idempotent replay detects the identical source revision), and
  converges to exactly one escalation. A further replay after 3600s creates
  no additional escalation or event.
- **Completed-job replay safety**: a `converged` job is structurally
  unclaimable (`claimDueJobs`'s `WHERE` clause only matches
  `pending/waiting/leased/observing`); proven directly by asserting zero
  additional provider calls for a converged node across a 3600s-later batch
  run.
- **Escalation replay safety**: proven both in the crash-recovery test above
  and independently in the terminal-failure test (`replay.claimed === 0`,
  escalation count stays at 1 after a 3600s-later batch run).

## 5. Typecheck, build, migrations, git diff --check

The build/full-typecheck/migration evidence below is from the original
implementation pass and remains valid: this reconciliation pass changed only
test assertions and report language (§9), not production code, so it
re-verified with the bounded command set the reconciliation instructions
called for — backend typecheck and `git diff --check` — rather than
repeating the full build/regression matrix:

```
cd apps/backend
npx tsc -p tsconfig.json --noEmit     # reconciliation pass: clean, zero errors
```

```
git diff --check   # reconciliation pass: exit 0, only pre-existing LF/CRLF advisories
```

Original full-pass evidence (production code, unchanged since):

```
cd apps/backend
npx tsc -p tsconfig.json --noEmit     # clean, zero errors
npx tsc -p tsconfig.json              # clean build, zero errors

cd ..
npm run build       # backend tsc + frontend tsc + vite build — all clean
npm run typecheck   # backend + frontend — all clean
```

Migrations: `migrateAutoPosterObservationTables` verified via the dedicated
migration test (§2, "Phase 2E-C migration") — fresh create produces the
three exact reviewed table schemas; a second `createDatabase` call on the
same file is a no-op (`false` return, no re-create); a database with a
pre-existing, non-matching `operator_autoposter_observation_jobs` table
throws `Phase 2E-C migration refused an unknown ... schema` and refuses to
proceed. Every other Phase 2A–2E-B migration continues to run and pass its
own migration tests unchanged (confirmed via the full backend suite in §3,
which includes `autoposter-result-migration.test.ts` and
`mission-graph-migration.test.ts`).

```
git diff --check
```
Exit code `0`. Output contained only benign `LF will be replaced by CRLF`
advisories (this repository's line-ending normalization is pre-existing and
applies identically to files this phase did not touch); **zero whitespace
errors**.

## 6. Cross-repository confirmation

```
cd apps/chanter-agent-runtime && git status --porcelain   # (empty)
                                  git rev-parse --short HEAD  # 2fdff24 (unchanged)
cd apps/chanter-auto-poster     && git status --porcelain   # (empty)
                                  git rev-parse --short HEAD  # 9f1e0c2 (unchanged)
cd apps/chanter-mcp-server      && git status --porcelain   # (empty)
                                  git rev-parse --short HEAD  # 69606ad (unchanged)
```

Confirms the implementation stayed Operator-only exactly as scoped: no
Agent Runtime, AutoPoster, or MCP Server contract change was needed.

## 7. Remaining limitations (P0, honestly scoped)

- **Phase 2E-C P0 is scheduler-ready, not self-scheduling.** `runObservationBatch`
  (and its `POST /api/autoposter-observations/run` route) is a complete,
  idempotent, safe-to-call-repeatedly unit of work — atomic claim, bounded
  batch, deterministic convergence — but nothing inside this phase invokes it
  on a timer. Matching the spec's "no cron infrastructure outside the
  repository" / "no unbounded daemon" non-goals, batch execution still
  requires an external trigger: today that is a human or script calling the
  route directly; a future phase may add an Operator-owned in-repo scheduler
  (e.g. a bounded interval loop process) that calls this exact same
  entrypoint. No code in this phase assumes or requires that trigger to
  exist — the loop is correct and safe whether it is invoked once, on a
  timer, or after an arbitrarily long gap.
- **Single-process lease semantics assume one SQLite writer.** `BEGIN
  IMMEDIATE` gives correct cross-process mutual exclusion for the *claim*
  step on the same SQLite file, which was proven directly, but true
  multi-process horizontal scaling was not exercised beyond that guarantee
  (this repository's existing Phase 2A–2E-B architecture is itself
  single-process SQLite; Phase 2E-C does not change that assumption).
- **`transport_retry` reason codes are not exhaustively enumerated.** Any
  Phase 2E-B `result_collection_unavailable` failure is treated uniformly as
  retryable; a persistent AutoPoster outage still resolves correctly via
  window exhaustion into `escalation_required`, but there is no faster
  circuit-breaker for a known-down AutoPoster instance in P0.
- **Escalation reason coverage is closed-world but not exhaustively tested
  in combination.** The four required outcome-class buckets and ten known
  escalation reason codes are all exercised individually; not every
  theoretically possible AutoPoster status/approval/history combination that
  could map to `manual_review_required` was enumerated (the underlying
  Phase 2E-B classifier already covers this exhaustively and was not
  modified).
- **No UI, no public MCP surface** — exactly per the non-goals; the entire
  operational surface is the seven internal `/api/autoposter-observations/*`
  routes gated by the existing operator control capability token.

## 8. Recommended repository-specific commit messages

Only `chanter-Operator` has changes to commit (nothing to commit in
`chanter-agent-runtime`, `chanter-auto-poster`, or `chanter-mcp-server`):

```
feat(operator): add durable autonomous autoposter observation loop

Adds a Phase 2E-C durable, Operator-owned observation loop that
automatically observes unresolved AutoPoster schedule graph nodes,
converges node/job state through the existing Phase 2E-B strict
result-projection path, and escalates to a human only when automatic
convergence is impossible. Removes the manual-refresh dependence from
the normal graph lifecycle while leaving the Phase 2E-B manual refresh
fully backward compatible.
```

## 9. Acceptance-reconciliation pass (this revision)

Triggered by a repository-truth inconsistency between this report's original
requirement-7/9 wording ("converges node and graph") and the implementation
report's accurate description (execution state is never rewritten). §0
establishes the canonical state model; the implementation was already
correct (confirmed by direct code inspection — neither
`autoPosterObservationService.ts` nor
`autoPosterResultProjectionService.ts` contains any `UPDATE`/`INSERT`
against `operator_mission_graphs` or `operator_mission_graph_nodes`, only
`SELECT`), so this pass changed test assertions and report language only —
no production code changed.

Changes made:
- Extended the two convergence tests (`... > re-observes non-terminal truth
  ... and converges terminal success` and `... > escalates human-required
  truth exactly once and classifies terminal provider failure
  deterministically`) with three explicit, layered assertions each: (a)
  observation-job status, (b) graph-level result-projection status per
  node via `getProjections()`, (c) `operator_mission_graph_nodes` rows
  captured immediately after graph completion, asserted byte-identical after
  full convergence. Both tests still pass 19/19 in the targeted suite.
- No new stored graph-level projection table was added — §0 documents why
  the existing `getProjections(graphId).batch` (Phase 2E-B, unmodified) and
  `listEscalations({ graphId })` (Phase 2E-C) already jointly satisfy "a
  graph-level result/outcome projection that converges without rewriting
  execution state," so no additive projection was the minimal correct
  action.
- Corrected requirement 7 and requirement 9 wording in §2's mapping table.
- Added §0 (Canonical state model) and this section.
- Strengthened the scheduler-readiness limitation in §7 with explicit
  "scheduler-ready, not self-scheduling" language.

Commands run for this pass only (per the reconciliation instructions —
targeted suite, affected typecheck, `git diff --check`; the full regression
matrix was intentionally not re-run since no production code changed):

```
cd apps/backend
npx vitest run tests/autoposter-observation-loop.test.ts   # 19/19 passed
npx tsc -p tsconfig.json --noEmit                            # clean

cd ..
git diff --check   # exit 0, only pre-existing LF/CRLF advisories
```

## 10. Final git status (per repository)

**chanter-Operator** (only repository with changes):
```
 M apps/backend/src/app.ts
 M apps/backend/src/config.ts
 M apps/backend/src/db/database.ts
 M apps/backend/src/db/schema.ts
 M apps/backend/src/missions/autoPosterResultProjectionService.ts
 M apps/backend/src/missions/missionGraphService.ts
 M apps/backend/src/routes/api.ts
 M apps/backend/src/runtime.ts
 M apps/backend/src/server.ts
?? apps/backend/src/missions/autoPosterObservationService.ts
?? apps/backend/tests/autoposter-observation-loop.test.ts
?? docs/phase2e/
```

**chanter-agent-runtime**: clean, HEAD `2fdff24` (unchanged).
**chanter-auto-poster**: clean, HEAD `9f1e0c2` (unchanged).
**chanter-mcp-server**: clean, HEAD `69606ad` (unchanged).

No commit, no push, and no Phase 2E-D work was performed, per the stop
conditions.
