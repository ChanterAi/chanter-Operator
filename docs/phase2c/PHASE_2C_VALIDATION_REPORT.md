---
title: CHANTER OS Phase 2C Multi-Mission Authority Validation Report
version: 1.0.0
status: FOUNDER_REVIEW_REQUIRED
date: 2026-07-16
owner: CHANTER
recommended_path: docs/phase2c/PHASE_2C_VALIDATION_REPORT.md
---

# CHANTER OS Phase 2C — Multi-Mission Authority Validation Report

All commands were run in this session from the real working trees at
`apps/chanter-Operator` (master), `apps/chanter-agent-runtime` (master), and
`apps/chanter-loop.governor` (main). Nothing was committed or pushed.
Python 3.10.11 (`C:\Users\IT\AppData\Local\Programs\Python\Python310\python.exe`),
Node >= 22.

## 1. Loop Governor — new mission-intake suite + full suite

```powershell
python -m unittest tests.test_mission_intake -v
```

**18 passed / 18.** Coverage: create produces a real task + manual relay loop
+ durable binding; exact duplicate create returns the same ids with
`created:false` and no second task; conflicting payload hash is a typed
`MISSION_INTAKE_PAYLOAD_CONFLICT` with zero side effects; a durable pending
intent without a task continues the same create; **crash after task creation
is re-adopted via the mission marker without a second task** (and re-replay
stays stable); the binding survives disk reload; lookup returns
`not_found` / `unique` (with ids) / `payload_mismatch` / `incomplete`
truthfully; unknown request/task fields, invalid task types, invalid hashes,
invalid modes, lookup-with-task, and corrupt bindings are all typed refusals.

Real subprocess contract (no shell): a create request whose goal embeds
`; echo pwned > probe && $(whoami) | dir` executes as **data** — exit 0, loop
created, probe file absent; malformed JSON → exit 1 +
`MISSION_INTAKE_INVALID_JSON`; >64 KB input → `MISSION_INTAKE_REQUEST_TOO_LARGE`.

```powershell
python -m unittest discover -s tests
# Ran 1017 tests in 27.307s
# OK
```

**1017 / 1017 OK** (Phase 2B2 baseline 999 + 18 new). `git diff --check`: clean
(exit 0).

## 2. chanter-agent-runtime — new adapter/port suites + full suite

```powershell
npm run typecheck   # clean
npm run build       # clean
npm test
# ℹ tests 294  ℹ pass 294  ℹ fail 0
```

**294 / 294** (baseline 266 + 28 new). New coverage:

- Adapter (15 tests, through the real `executeMission` chain): action spec is
  exactly `loop_governor.manual_loop.create` / write / medium /
  requires_approval / idempotency required; **approval and idempotency gates
  fire before the port is ever reached**; the exact 64-hex payload hash is
  bound into the port call; `created:false` maps to `duplicate`, never a fresh
  success; closed-world input (unregistered field, unknown task type, missing
  goal, non-string lists, invalid prompt mode) fails before the port; port
  failures map truthfully (conflict→failed/LOOP_GOVERNOR_PAYLOAD_CONFLICT,
  timeout/unavailable→unavailable, validation→validation_failed,
  invalid_response/internal→failed).
- Process port (13 tests, REAL child processes against a scripted fixture
  module): frozen `['-m','governor.mission_intake']` argv; relative
  executable/root rejected at construction; JSON request/response round-trip;
  **non-allowlisted parent env vars never reach the child** (canary proof)
  while `LOOP_GOVERNOR_DATA_DIR` does; timeout kills the child and returns a
  typed `timeout`; non-JSON stdout → `invalid_response`; oversized stdout →
  capped + `invalid_response`; untyped nonzero exit → `unavailable`; missing
  executable → `unavailable`; **mismatched mission-identity echo rejected**;
  a create result that does not attest `real_agent_execution: false` is
  rejected; typed downstream conflict/validation codes map exactly; lookup
  outcomes and bindings validated strictly.

`git diff --check`: clean (exit 0).

## 3. Operator — new generic-spine unit suite

```powershell
cd apps\backend
npx vitest run tests/generic-mission-spine.test.ts
# 14 passed / 14
```

Every execution goes through the **real** chanter-agent-runtime
`executeMission` + Loop Governor adapter (only the process port is an
in-memory fake at unit level). Coverage mapped to the objective's validation
requirements:

| Requirement | Test evidence |
|---|---|
| unknown product/action rejected | `clean_engine.image.clean` → 409 `OPERATOR_MISSION_TARGET_MISMATCH`, zero rows persisted |
| manual_loop.create accepted + durable | 201 `approval_required`, journal seq 1, ledger `created→approval_required`, port untouched at submission |
| duplicate submission idempotent | exact re-submit → 200 `replayed:true`, still one row |
| conflicting duplicates rejected | changed payload → 409 `OPERATOR_MISSION_PAYLOAD_MISMATCH`; changed trace → 409 `OPERATOR_TRACE_MISMATCH`; stolen idempotency key → 409 `OPERATOR_IDEMPOTENCY_MISMATCH` |
| closed-world input | `shellCommand` field → 400 `LOOP_GOVERNOR_INPUT_UNSUPPORTED_FIELD`, nothing persisted; protected-token content → 400, nothing persisted |
| approval stays Operator-controlled | submit token approve → 401; ledger token approve → 401; control token submit → 401; mission untouched |
| runtime adapter receives typed payload | port call carries exact missionId + task fields + payload hash === durable `missionPayloadHash` |
| journal + ledger lineage | journal `approval_required→approved→execution_started→downstream_request_prepared→downstream_result_observed→result_persisted→completed`; ledger run `created→approval_required→approved→running→validating→completed`, trace bound, approval actor recorded |
| completed replay | re-approve → same result, port called exactly once; wrong actor → 409 `OPERATOR_APPROVAL_BINDING_MISMATCH` |
| AutoPoster path preserved | AutoPoster envelope routed to the legacy lane (typed legacy-only refusal), zero generic rows |
| restart safety | close/reopen SQLite between submit and approve → identical projection, approval executes once |
| crash boundary | injected crash after downstream execution → restart → `downstream_result_observed` durable → Resume → completed with **zero** additional port calls |
| bounded retry | unavailable → reconcile `not_found` → single safe retry → completed, `retryCount 1`, full 12-transition journal |
| retry exhaustion terminal | retry spent → resume 409 `RECOVERY_ACTION_NOT_PERMITTED` → stop → `failed_terminal` + `RECOVERY_STOPPED_FOR_ESCALATION`; further resume 409 |
| payload conflict terminal | reconcile `payload_mismatch` → `failed_terminal` + `RECOVERY_PAYLOAD_MISMATCH` |

## 4. Operator — Phase 2C cross-repository integration (real python end to end)

```powershell
npm run test:phase2c:mission
# ✔ Phase 2C full spine: envelope -> approval -> runtime adapter -> real manual loop, with replay and restart safety
# ✔ Phase 2C crash boundary: a crash after the downstream loop exists never creates a second loop
# ✔ Phase 2C concurrency: distinct missions execute concurrently with zero cross-talk
# 3 passed / 3
```

Real Operator Express server (ephemeral port), real capability tokens
(random per run), real `chanter-agent-runtime` process port, real
`python -m governor.mission_intake` against the real Loop Governor repo with
an isolated `LOOP_GOVERNOR_DATA_DIR`:

- **Full spine**: unknown target → 409; missing/wrong tokens → 401; submit →
  201 approval_required with zero downstream tasks; submit/ledger tokens
  cannot approve (401); control approve → 200 `succeeded`; the task and loop
  **actually exist** in Loop Governor state (task dir name === returned
  taskId; `task.json` scope carries `[chanter-mission:<id>]`;
  `task.json.loop_id` === returned loopId); journal is the exact 7-state
  sequence; ledger run `completed` / `product_id loop_governor` /
  `trace_id` bound / `production_impact false`; exact replay → 200
  `replayed:true` with still exactly 1 task + 1 loop; changed payload → 409;
  **Operator restart → projection deepEqual before/after**, approval replay →
  completed, still 1 task + 1 loop; capability tokens absent from db/-wal/-shm
  **and from every file in the Loop Governor data tree**.
- **Crash boundary**: injected crash after the downstream loop exists → 500;
  restart without the injector → durable `downstream_result_observed`;
  Resume → completed; Loop Governor still holds exactly **1 task, 1 loop**;
  a further approve is an exact completed replay.
- **Concurrency**: two distinct missions submitted and approved via
  `Promise.all` → both `succeeded` with distinct loop/task ids, 2 tasks +
  2 loops downstream, each ledger run bound to its own trace.

## 5. Regression — accepted suites, unedited, all green

```powershell
npm run test:phase2a:integration   # 2 passed / 2   (single authority + UI proxy capability separation)
npm run test:phase2b1:ledger       # 3 passed / 3   (live transport, restart replay, fail-closed isolation)
npm run test:phase2b2:ledger       # 3 passed / 3   (out-of-order gap drain, restart-under-gap, conflict evidence)
npm test                           # backend 718/718 (704 baseline + 14 new), frontend 115/115
npm run typecheck                  # backend + frontend clean
npm run build                      # backend tsc + frontend vite clean
npm run mission:test               # 26 passed / 26
npm run release:test               # 23 passed / 23
git diff --check                   # exit 0 (only pre-existing LF/CRLF autocrlf warnings)
```

The Phase 2A/2B1/2B2 test files are byte-for-byte unedited; all AutoPoster
mission behavior (submit, persist, approve, execute, replay, recovery
scenario matrix A–G) passes unchanged inside the 718-test backend suite.

## 6. Timeout and retry-exhaustion determinism

- Transport timeout: process-port test proves the child is killed at the
  deadline and surfaces typed `timeout` → adapter `unavailable` → Operator
  `failed_recoverable` with `RECOVERY_DOWNSTREAM_UNAVAILABLE` (recoverable,
  never silent).
- Retry exhaustion: after the single permitted retry, resume is deterministically
  refused (`409 RECOVERY_ACTION_NOT_PERMITTED`) and stop/escalate produces
  `failed_terminal` + mission status `failed`; terminal states accept no
  further mutation (verified).

## 7. Token non-persistence evidence

`assertNoSecretBytes` (db + -wal + -shm) and a recursive byte-scan of the
entire isolated Loop Governor data tree ran after the full integration
scenario, the crash scenario, and the concurrency scenario — no capability
token (submit/control/ledger, random per run) appears anywhere.

## 8. Repository state after validation (nothing committed, nothing pushed)

```text
# chanter-agent-runtime   ## master...origin/master
 M src/index.ts
?? src/adapters/loopGovernorMissionAdapter.ts
?? src/adapters/loopGovernorProcessPort.ts
?? tests/adapters/loopGovernorMissionAdapter.test.ts
?? tests/adapters/loopGovernorProcessPort.test.ts

# chanter-Operator        ## master...origin/master
 M apps/backend/src/app.ts
 M apps/backend/src/config.ts
 M apps/backend/src/db/schema.ts
 M apps/backend/src/routes/api.ts
 M apps/backend/src/runtime.ts
 M apps/backend/src/server.ts
 M package.json
?? apps/backend/src/missions/
?? apps/backend/tests/generic-mission-spine.test.ts
?? tools/phase2c/

# chanter-loop.governor   ## main...origin/main
?? governor/mission_intake.py
?? tests/test_mission_intake.py

# chanter-mcp-server / chanter-memory-vault / chanter-auto-poster: clean, untouched
```

## 9. Definition-of-done checklist

```text
[x] AUTOPOSTER MISSIONS UNCHANGED (accepted files untouched; 2A/2B1/2B2 + full suites green unedited)
[x] manual_loop.create REGISTERED AND REAL (closed-world registry; real loop/task created downstream)
[x] UNKNOWN TARGETS REJECTED DETERMINISTICALLY (409 OPERATOR_MISSION_TARGET_MISMATCH, nothing persisted)
[x] DUPLICATES IDEMPOTENT / CONFLICTS TYPED (200 replayed:true; 409 payload/trace/idempotency mismatches)
[x] APPROVAL REMAINS OPERATOR-CONTROLLED (3-token isolation re-proven on all new routes)
[x] RESTART PRESERVES MISSION + EXECUTION STATE (unit + integration deepEqual proofs)
[x] CRASH BOUNDARIES NEVER DUPLICATE EXECUTION (1 task / 1 loop after crash + recovery, twice proven)
[x] RUNTIME ADAPTER RECEIVES EXACT TYPED PAYLOAD (payload-hash binding asserted end to end)
[x] LOOP GOVERNOR RECEIVES JSON VIA STDIN, NO SHELL (metacharacter-as-data proof; frozen argv)
[x] MISSION + JOURNAL + LEDGER LINEAGE COMPLETE (7-state journal; 6-status ledger run per mission)
[x] TIMEOUT AND RETRY EXHAUSTION DETERMINISTIC (typed timeout; retry<=1; terminal states final)
[x] ALL EXISTING SUITES GREEN (Operator 718+115; Loop Governor 1017; agent-runtime 294)
[x] CROSS-REPOSITORY INTEGRATION GREEN (3/3 with real python transport)
[x] git diff --check CLEAN IN EVERY CHANGED REPOSITORY
[x] NO COMMIT, NO PUSH — STOPPED FOR FOUNDER REVIEW
```
