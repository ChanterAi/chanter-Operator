---
title: CHANTER OS Phase 2C Multi-Mission Authority Implementation Report
version: 1.0.0
status: FOUNDER_REVIEW_REQUIRED
date: 2026-07-16
owner: CHANTER
scope:
  - apps/chanter-Operator
  - apps/chanter-agent-runtime
  - apps/chanter-loop.governor
read_only:
  - apps/chanter-mcp-server
  - apps/chanter-memory-vault
  - apps/chanter-auto-poster
recommended_path: docs/phase2c/PHASE_2C_IMPLEMENTATION_REPORT.md
plan: docs/architecture/CHANTER_OS_SCALE_REVERSE_PLAN_V1.md (founder-approved, decisions 1-4 recorded 2026-07-16)
---

# CHANTER OS Phase 2C — Multi-Mission Authority Implementation Report

## 1. Summary

Phase 2C converts the Operator from a single-product AutoPoster authority into
a durable multi-mission authority with exactly two registered real actions:

```text
autoposter.post.schedule            (accepted Phase 2A lane — byte-identical, files untouched)
loop_governor.manual_loop.create    (new Phase 2C generic durable spine)
```

New end-to-end capability, proven with real components at every hop:

```text
chanter.mission.v1 envelope (submit capability token)
  -> Operator closed-world action registry (unknown targets: deterministic 409)
  -> additive durable spine: operator_missions / operator_mission_executions / operator_mission_journal
  -> 201 approval_required (submission can never approve; 3-token isolation preserved)
  -> independent control-token approval
  -> real chanter-agent-runtime executeMission -> Loop Governor mission adapter
  -> no-shell JSON-stdin process port -> python -m governor.mission_intake
  -> real Loop Governor task + manual relay loop (real-agent execution stays frozen)
  -> durable result + journal + Agent Run Ledger lineage
  -> exact replay / restart / crash-boundary / bounded-retry safety
```

Nothing was committed or pushed. No real coding agent, provider, model,
publish, or deploy was enabled at any point.

## 2. Verified baseline before editing (Stage 0)

| Repository | Branch | HEAD at start | State |
|---|---|---|---|
| chanter-agent-runtime | master | `20abcbe` | clean, synced with origin |
| chanter-Operator | master | `c73f7b5` | clean, synced with origin |
| chanter-loop.governor | main | `56cecb9` | clean, synced with origin |
| chanter-mcp-server | main | `426f80e` | clean — **not modified by this phase** |
| chanter-memory-vault | master | `a1059a1` | clean — **not modified by this phase** |
| chanter-auto-poster | main | `8697167` | clean — **not modified by this phase** |

Assumption checks against repository truth (plan §4 verified before editing):
Loop Governor task ids are random (`task-` + uuid), so downstream idempotency
required a durable intent/binding ledger plus a deterministic task marker —
implemented exactly that way; `LOOP_GOVERNOR_DATA_DIR` already provides state
isolation; the Operator ledger context binds `attempt_id` to the journal's
FIRST attempt for stable ledger scope across recoveries — mirrored.

**Action naming**: the founder objective wrote "manual_loop.create"; the
Master Plan (§3) and the approved reverse plan define the canonical action id
`loop_governor.manual_loop.create` with product `loop_governor`. The canonical
id was implemented; the shorter form is read as its abbreviation.

## 3. Exact files changed

### chanter-Operator (branch `master`, baseline `c73f7b5`)

```text
M  apps/backend/src/app.ts          (+4/-2: optional genericMissionService pass-through)
M  apps/backend/src/config.ts       (+18: additive loopGovernorRuntime block — LOOP_GOVERNOR_PYTHON,
                                     LOOP_GOVERNOR_ROOT, LOOP_GOVERNOR_MISSION_DATA_DIR, LOOP_GOVERNOR_TIMEOUT_MS)
M  apps/backend/src/db/schema.ts    (+84: three additive CREATE TABLE IF NOT EXISTS + indexes; see §4)
M  apps/backend/src/routes/api.ts   (+92/-18: registry dispatch on POST /runtime-missions;
                                     generic-first mission-id dispatch on GET /:missionId and the four
                                     control endpoints; legacy ordering and errors preserved exactly)
M  apps/backend/src/runtime.ts      (+15: construct Loop Governor executor + GenericMissionService)
M  apps/backend/src/server.ts       (+4/-2: wire the new service)
M  package.json                     (+1: test:phase2c:mission script)
?? apps/backend/src/missions/missionActionRegistry.ts    (57 lines — closed-world registry, 2 entries)
?? apps/backend/src/missions/loopGovernorRuntime.ts      (105 lines — executor factory, fail-closed unconfigured)
?? apps/backend/src/missions/genericMissionJournal.ts    (410 lines — copy-generalized 11-state journal)
?? apps/backend/src/missions/genericMissionLedger.ts     (232 lines — ledger producer, production_impact false)
?? apps/backend/src/missions/genericMissionService.ts    (1,474 lines — durable create/approve/execute/
                                                          reconcile/resume/stop, mirrors accepted 2A semantics)
?? apps/backend/tests/generic-mission-spine.test.ts      (672 lines — 14 tests)
?? tools/phase2c/mission-loop.integration.test.mts       (473 lines — 3 cross-repository tests)
```

**Accepted Phase 2A files NOT touched** (verified via `git status`):
`autoPosterMissionService.ts`, `autoPosterMissionLedger.ts`,
`missionExecutionJournal.ts`, `autoPosterRuntime.ts`, every `autoposter_*`
table, every existing test file (Phase 2A/2B1/2B2 suites run unedited).

### chanter-agent-runtime (branch `master`, baseline `20abcbe`)

```text
M  src/index.ts                                      (+26: additive exports only)
?? src/adapters/loopGovernorProcessPort.ts            (530 lines — fixed executable + frozen
                                                      ['-m','governor.mission_intake'] argv, JSON stdin,
                                                      no shell, bounded env allowlist, timeout kill,
                                                      stdout/stderr caps, strict identity-echo validation)
?? src/adapters/loopGovernorMissionAdapter.ts         (294 lines — one action spec: write / medium /
                                                      requires_approval / idempotency required /
                                                      production_impact false; closed-world input;
                                                      created:false reported as duplicate, never success)
?? tests/adapters/loopGovernorProcessPort.test.ts     (290 lines — 13 tests against REAL child processes)
?? tests/adapters/loopGovernorMissionAdapter.test.ts  (272 lines — 15 tests through real executeMission)
```

No existing module was edited (`missions.ts`, `missionEnvelope.ts`,
`agentRunLedger.ts`, `transitions.ts`, `policy.ts`, AutoPoster/SafeCommit
adapters all byte-identical).

### chanter-loop.governor (branch `main`, baseline `56cecb9`)

```text
?? governor/mission_intake.py     (457 lines — the only mission surface; JSON stdin/stdout;
                                   modes create/lookup; durable per-mission binding files;
                                   two-phase intent -> create -> bind; marker-based crash adoption;
                                   typed conflicts; closed-world validation; no subprocess, no shell)
?? tests/test_mission_intake.py   (318 lines — 18 tests incl. real-subprocess contract)
```

No existing file was edited. `services.py`, `lifecycle.py`,
`agent_run_ledger.py`, `operator_ledger_port.py` are byte-identical; the
real-agent freeze is untouched (the created loop is a manual relay loop,
`agent="manual"`).

## 4. Schema and contract changes

### Operator SQLite (additive only; no migration; existing databases open unchanged)

- `operator_missions` — one durable row per generic mission;
  `trace_id` UNIQUE, `idempotency_key` UNIQUE, stored `payload_hash`;
  `CHECK (product <> 'auto_poster')` makes it structurally impossible for the
  generic spine to absorb the AutoPoster authority (founder decision 3);
  `CHECK (approval_required = 1)` — every generic mission is approval-gated.
- `operator_mission_executions` — same 11-state machine as the accepted 2A
  journal, `CHECK (retry_count <= 1)`, generic `downstream_operation_type`,
  `downstream_ids_json`, reconciliation outcomes extended with `'incomplete'`
  (a Loop Governor partial-intent state that is safe to retry idempotently).
- `operator_mission_journal` — append-only, `UNIQUE(mission_id, sequence)`.

No existing table, column, index, or CHECK was modified.

### Contracts

- `chanter.mission.v1` — **unchanged** (already supported `loop_governor`).
- Agent Run Ledger v1.0 — **unchanged**; generic missions reuse it with
  `product_id: "loop_governor"`, provider `"local"`, model
  `"not_applicable"`, `production_impact: false`, run_id = missionId,
  trace_id = mission traceId.
- chanter-agent-runtime package — semver-minor additive exports:
  `LOOP_GOVERNOR_ACTIONS`, `createLoopGovernorMissionAdapter`,
  `createLoopGovernorProcessPort`, `validateManualLoopInput`, related types.
- Operator HTTP API — additive: `POST /api/runtime-missions` now dispatches by
  the closed-world registry (generic lane only for
  `loop_governor.manual_loop.create`); mission-id routes dispatch
  generic-first, falling through to the exact legacy path. For every request
  shape that existed before Phase 2C, responses are byte-identical (proven by
  the unedited Phase 2A/2B1/2B2 and full-suite regressions).
- Loop Governor process contract — new, versioned by module identity:
  `python -m governor.mission_intake`, one JSON object on stdin
  (`mode: create | lookup`, `mission_id`, 64-hex `payload_hash`, bounded
  closed-world `task`), one JSON object on stdout, exit 0/1, 64 KB input cap.

## 5. Crash-boundary idempotency design (requirement 10)

Downstream (Loop Governor) side — durable per-mission binding file written in
two phases around the side effect:

```text
intent (state: pending) -> create_task(scope contains "[chanter-mission:<id>]")
                        -> relay_task(agent="manual") -> binding (state: created)
```

Recovery on re-invocation: `created` binding → same ids, `created:false`;
`pending` + marker task found → adopt (relay if needed), never create again;
`pending` + no marker task → continue the same create; >1 marker tasks →
typed `MISSION_INTAKE_BINDING_AMBIGUOUS` escalation; different payload_hash →
typed `MISSION_INTAKE_PAYLOAD_CONFLICT`.

Operator side — the proven 2A boundary model, mirrored: every transition
journaled before/after the downstream call; a crash between the downstream
side effect and result persistence leaves `downstream_result_observed` with
the durable runtime observation, recovered by `Resume safely` with **zero**
additional downstream calls (proven in unit + integration tests); interrupted
executions are reconciled read-only through the port's `lookup` mode; one
bounded safe retry (`retry_count <= 1`) is permitted only after an exact
`not_found`/`incomplete` reconciliation; retry exhaustion and stop/escalate
produce deterministic `failed_terminal`.

## 6. Security properties (requirements 8, 9, 13)

- No shell anywhere: fixed absolute executable, frozen argument array, JSON on
  stdin; proven with shell-metacharacter payloads executing as data
  (`tests/test_mission_intake.py::test_stdin_json_with_shell_metacharacters_is_data_not_commands`).
- No dynamic command execution: mission input is a closed world
  (`appName/taskType/goal/scope/promptMode/allowedFiles/forbiddenActions/
  validationCommands/maxContext`); unknown fields are rejected at three
  layers (Operator submission, runtime adapter, python intake).
- Bounded child environment: 8-variable allowlist + python hygiene vars +
  explicit `LOOP_GOVERNOR_DATA_DIR`; proven by an env-canary test.
- Capability separation unchanged: submit cannot approve, control cannot
  submit, ledger can do neither — re-proven on the new routes and by the
  unedited Phase 2A suite.
- Tokens never persisted: byte-scans over the SQLite db/-wal/-shm AND the
  entire Loop Governor data tree after full execution — clean.

## 7. Migrations

None. All schema is `CREATE TABLE/INDEX IF NOT EXISTS`; existing databases
gain empty tables on next open. Rollback = revert the working tree; the new
tables are inert if unused.

## 8. Known limitations (disclosed, not hidden)

1. `GET /api/runtime-missions` (list) still returns AutoPoster missions only —
   kept byte-identical for the existing cockpit; generic missions are readable
   via `GET /api/runtime-missions/:missionId` and fully visible in the Agent
   Run Ledger panel through their ledger lineage. A merged list view is a
   deliberate non-goal of this phase (no UI redesign).
2. `/api/health` was intentionally not extended (readiness for the generic
   spine is available via `GenericMissionService.getReadiness()` internally);
   avoiding any change to a payload asserted by accepted tests.
3. The Loop Governor mission intake serializes per mission, not globally; two
   concurrent creates for the SAME mission id are prevented by Operator's
   journal claims (`MISSION_JOURNAL_CONCURRENT_TRANSITION`), not by a
   file lock inside Loop Governor. Distinct missions are race-free by
   construction (one binding file per mission).
4. Windows-host `http.server` TCP flakiness disclosed in Phase 2B1/2B2 was
   not observed in this session's runs, but remains a known environmental
   characteristic of the Loop Governor suite.
5. The real python transport adds ~1–2 s per mission execution (interpreter
   startup); acceptable at founder-gated volume, revisit only with volume.

## 9. Recommended commit messages (no commit was performed)

```text
chanter-loop.governor:   feat(governor): add idempotent JSON-stdin mission intake for manual loops
chanter-agent-runtime:   feat(runtime): add loop governor mission adapter and no-shell process port
chanter-Operator:        feat(operator): add generic durable multi-mission spine with loop_governor.manual_loop.create
```

See the companion [Validation Report](PHASE_2C_VALIDATION_REPORT.md) for every
command, exact counts, and the restart/crash/replay/secret evidence.
