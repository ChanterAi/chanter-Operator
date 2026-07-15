# CHANTER Operator

Local-first founder cockpit for reviewable task intake, approval gates, mock execution, evidence, read-only workspace scanning, mission compilation, one bounded AutoPoster runtime mission, and audit history. Operator is CHANTER's internal control layer — it has no customer-facing surface or business model of its own.

## What Operator is

Operator gives the founder one place to: intake and review proposed work as structured tasks, gate risky actions behind explicit approval, run a small allowlisted set of real read-only commands against a configured workspace, scan every CHANTER repo's git state without mutating anything, and compile a high-level founder intent into a structured, safe execution mission package for a supervised coding agent to carry out elsewhere. Separately, one explicit runtime mission can schedule an unapproved AutoPoster queue draft after founder approval; it cannot publish or approve that draft for release.

## Founder intent → mission package flow

1. The founder states an intent in plain language (e.g. "get CHANTER to release readiness").
2. The Mission Compiler (`tools/mission-compiler/`) classifies the intent, resolves target CHANTER apps by priority, pulls live repo truth from the Release Operator scanner, and assembles a mission package: objectives, non-targets, risk/approval gates, a validation plan, per-system connection plans, and a final execution prompt.
3. The compiled mission is a handoff artifact for a human or a separately supervised coding agent to execute — the Mission Compiler itself never runs the mission.

See `tools/mission-compiler/README.md` for full detail.

## Release Operator — read-only scanner

`tools/release-operator/` scans every repo listed in `chanter.repos.json` (mirroring the CHANTER root docs) and classifies each repo's release state (`clean-synced | ahead | behind | diverged | dirty | no-remote | no-upstream | not-a-git-repo | non-git-expected | missing`). Git access is limited to an allowlist — `status`, `log`, `rev-parse`, `remote` — enforced and test-locked in `tools/release-operator/tests/git-scan.test.mjs`. It never pushes, deploys, publishes, migrates, or installs anything; it only reports and suggests read-only follow-up commands, which it never executes itself.

See `tools/release-operator/README.md`.

## Mission Compiler

`tools/mission-compiler/` turns one high-level founder message into a mission package (see flow above). It does not call any LLM API, use the network, or install anything, and it does not execute the compiled mission — push, deploy, publish, migration, and other state-mutating decisions all stay with a human.

See `tools/mission-compiler/README.md`.

## Local read-only runner and its command allowlist

The backend (`apps/backend/src/runners/realReadonlyRunner.ts`) executes exactly five pre-approved, read-only git commands inside a configured workspace, via `execFile` with `shell: false` (no shell interpolation, no injection surface):

```
git status --short
git diff --stat
git diff --check
git show --stat --oneline HEAD
git show --name-only HEAD
```

Every other command, and any injection attempt (`;`, `&&`, `||`, `|`, backticks, `$()`, etc.), is rejected before execution. The runner is opt-in — it requires the `OPERATOR_RUNNER_WORKSPACE` environment variable; without it, `POST /api/commands/run` returns `503`. Every execution, allowed or blocked, is written to the audit log and to the `readonly_command_results` table. The frontend exposes this as the "Read-only Runner" tab (`ReadonlyRunnerPanel.tsx`).

Full detail and test coverage: `reviews/operator-p1-readonly-runner-report.md` (workspace root, outside this repo).

## Agent Runtime dependency / integration boundary

`apps/backend/src/agentRuntime/runtimeBridge/` lets Operator represent its own work using the shared `chanter-agent-runtime` contract (`RuntimeTask` lifecycle, action-policy evaluation, redacted evidence export, provider-route selection). Every function in this module is pure and synchronous — it performs no I/O and executes nothing it evaluates.

As of P2A, four of its files (`contract.ts`, `policy.ts`, `providerRouting.ts`, `redaction.ts`) are real re-exports from a `file:` dependency on `chanter-agent-runtime`, declared in `apps/backend/package.json` (`"chanter-agent-runtime": "file:../../../chanter-agent-runtime"`). `tasks.ts` and `evidence.ts` remain Operator-local, with additional redaction hardening beyond the upstream source (three fields upstream leaves unredacted are covered here). **This bridge is not wired into any HTTP route, API, or UI** — it is a decision/evaluation layer only, with no live execution effect today.

The bounded AutoPoster mission capability is deliberately separate from that generic bridge. `apps/backend/src/runtimeMissions/` invokes the Runtime package's real `executeMission()` orchestration for only `autoposter.post.schedule`, persists the request/result, and requires explicit approval before the token-guarded AutoPoster call.

Full detail: `docs/OPERATOR_RUNTIME_BRIDGE_P1A.md` and `docs/OPERATOR_RUNTIME_BRIDGE_P2A.md`.

## What Operator executes today

- A deterministic **mock** task/step runner for the cockpit workflow (never reads, writes, shells out, or calls a network service)
- Five allowlisted **real, read-only** git commands via the local runner described above
- Read-only git scanning across the workspace via the Release Operator
- Mission compilation (text/JSON assembly only — no execution)
- One explicitly approved `autoposter.post.schedule` mission that creates an unapproved queue draft through `chanter-agent-runtime`

## What Operator does not execute

- No generic write, shell, deploy, publish, or migration runner capability
- No AutoPoster publish action and no AutoPoster draft-approval action
- No Loop Governor, Codex, or Ollama integration
- No git `add` / `commit` / `push`, or any other git write command
- No arbitrary network calls, end-user authentication surface, billing, or remote-access feature; the only product call is the configured token-guarded AutoPoster schedule-draft route
- No autonomous or unsupervised operation

## Approval and mutation boundaries

- Task steps classified as `file_write`, `file_edit`, `shell_command`, or `unknown` wait for explicit approval before the mock runner simulates them; `analysis` and `read_file` previews simulate immediately as safe actions.
- The real read-only runner requires an explicit workspace opt-in (`OPERATOR_RUNNER_WORKSPACE`) and, even then, only ever runs the five allowlisted commands above.
- AutoPoster mission creation performs one read-only, workspace-scoped connected-account validation through the existing Runtime/AutoPoster control seam before persistence. It does not create a queue item. A named approver must separately release Runtime execution, and the resulting queue item remains unapproved for publishing in AutoPoster.
- The Release Operator and Mission Compiler never mutate anything — they read root docs and git state, and write evidence/report artifacts only to their own gitignored `reports/` folders or an explicit `--out` path.
- Push, deploy, live publish, and migration remain **human-approval decisions** everywhere in Operator; no code path in this repo performs any of them today.

## Phase 2A local mission gateway

Operator is the durable authority for the registered `auto_poster` / `autoposter.post.schedule` write mission. Two loopback ingress routes share the same mission table, approval gate, execution journal, and Runtime adapter:

- `POST /api/runtime-missions` accepts the versioned `chanter.mission.v1` envelope and currently dispatches only the registered AutoPoster schedule action.
- `POST /api/runtime-missions/autoposter/schedule` preserves the existing compatibility request.

The two create routes require `OPERATOR_MISSION_SUBMIT_TOKEN`. That submission capability cannot approve, reconcile, resume, or stop a mission. Those four independent control routes require `OPERATOR_CONTROL_TOKEN`, which must differ from the submit, AutoPoster service, and ledger-ingest values and must never be shared with MCP or another submission client; Operator fails control routes closed when these values collide. `GET /api/health` reports control `configured`, `isolated`, and `ready` booleans without exposing any capability value. The loopback Vite development/preview proxy injects the submit or control token server-side only for its exact same-origin POST route allowlist; reads, unrelated writes, foreign origins, and originless requests receive neither token. No capability value is bundled or returned to browser JavaScript. A separately hosted static frontend must provide an equivalent trusted server-side control proxy and must not expose either token to client code. New missions return `201` with `replayed: false`; an exact durable mission/idempotency replay returns `200` with `replayed: true` and performs no second connected-account preflight or downstream write. A changed identity, trace, scope, target, or execution payload returns a typed `409` without returning the prior result or evidence. Callers may omit `workspaceId`; only a genuinely new request then asks AutoPoster to resolve the canonical workspace for the exact provider/account, and Operator persists that returned identifier. Agent Runtime execution remains blocked until a separate Operator-control request approves the durable mission.

Copy `.env.example` to the uncommitted repository-root `.env` for local configuration. Both the backend and the Vite development/preview proxy load that root file without overriding values explicitly exported by the invoking shell.

`POST /api/agent-run-ledger/entries` is independently protected by `OPERATOR_LEDGER_INGEST_TOKEN`. Operator writes the registered AutoPoster mission lifecycle directly through the existing ledger service in the same SQLite transactions as authoritative mission transitions; external ledger ingestion still requires the separate token.

All configured write capabilities — mission submit, mission control, ledger ingest, and the AutoPoster Runtime service token — must use distinct values. Any protected route whose configured capability collides with another capability fails closed with `CAPABILITY_TOKEN_CONFIGURATION_INVALID`.

## Quick-start commands

From `apps/chanter-Operator` (verified against `package.json`):

```powershell
npm install
npm run dev              # cockpit backend (127.0.0.1:3001) + frontend (127.0.0.1:5173)
npm run typecheck
npm test                 # backend + frontend suites
npm run release:scan     # Release Operator: repo state table
npm run release:report   # Release Operator: write evidence report
npm run mission:compile -- --intent "..."   # Mission Compiler
```

## Related in-repo docs

- `tools/release-operator/README.md`
- `tools/mission-compiler/README.md`
- `docs/OPERATOR_RUNTIME_BRIDGE_P1A.md`, `docs/OPERATOR_RUNTIME_BRIDGE_P2A.md`
- `docs/OPERATOR_AUTOPOSTER_MISSION_LOOP_P0.md`
- `reviews/operator-p1-readonly-runner-report.md` (workspace root `reviews/`, not inside this repo)

---

## What changed in P0.4

- Added `src/integrity/auditScanner.ts` — read-only audit JSONL scanner that reports parse errors, missing fields, and invalid event types without modifying the file
- Added `src/integrity/integrityChecker.ts` — read-only integrity checker that cross-references the database and audit log, reports orphaned steps/evidence, invalid status values, and audit/DB consistency gaps
- Added `checkIntegrity()` method to `OperatorService`, never modifies data
- Extended `GET /api/health` with an `integrity` summary: healthy flag, record counts, issue counts for both database and audit
- Added `path` getter to `AuditLogger` for diagnostics access
- Added 15 new backend tests (44 total): healthy state passes, malformed JSONL detected, missing fields detected, invalid event types detected, orphan steps/evidence detected, health endpoint integrity summary, no destructive repair, empty grace, FK enforcement guard
- All integrity checks are read-only; no automatic repair, no audit rewriting, no silent suppression

## P0.4 integrity checks

The health endpoint (`GET /api/health`) now includes a compact integrity summary:

Database checks:
- Every task has a valid status
- Every step has a valid status and action type
- Every step references an existing task
- Every evidence record references existing task and step records

Audit checks:
- Every JSONL line is valid JSON
- Every event has required fields: `id`, `event_type`, `task_id`, `data`, `created_at`
- Every `event_type` is a recognized value
- Audit task/step references are cross-checked against the database

The integrity checker is read-only. It never rewrites, deletes, or "fixes" data. Production foreign key and CHECK constraints remain enforced by SQLite. Audit log remains append-only.


## What changed in P0.5

- Added etchHealth() to the API client — fetches GET /api/health on app mount
- Added HealthResponse, HealthIntegrity, and ReadinessState types
- Created ReadinessBar component — a compact readiness strip below the header
- Wired readiness fetch into App.tsx on mount, independent of task loading
- Readiness bar displays: Backend reachable/unreachable, Integrity Healthy/Unhealthy, DB mode (Mock-only), record counts, and issue counts when unhealthy
- Added 14 new frontend component tests (45 total): healthy readiness, unhealthy warning with issue counts, backend unavailable recovery, ReadinessBar isolation states, and no new execution controls introduced
- CSS: added .readiness-bar and related class styles; adjusted cockpit heights for the 28px bar
- Backend unchanged — uses existing GET /api/health endpoint from P0.4

## P0.5 readiness gate

The readiness bar appears between the header and the cockpit panels. It fetches GET /api/health once on app mount and renders one of three states:

| State | Display |
| --- | --- |
| Healthy | Green dot, "Backend Reachable", "Integrity Healthy", record counts, "Mock-only" |
| Unhealthy (integrity.healthy=false) | Amber bar, "Integrity Unhealthy", issue counts (DB: N, Audit: N) |
| Unavailable (fetch fails) | Red bar, "Backend unavailable", error detail |

The readiness bar is informational only — it never blocks task creation, approval, or review. No destructive repair is attempted.

## P0.5 limitations
## P0.4 limitations

# CHANTER Operator — P0.3 Browser Smoke Test Coverage

Local-first founder cockpit for reviewable task intake, approval gates, mock execution, evidence, and audit history. P0.3 adds automated component-level smoke tests for the Operator Console UI without adding real execution capabilities.

## What P0.3 adds

- **Frontend component test suite** using Vitest + React Testing Library + jsdom
- **31 automated UI tests** covering:
  - App shell renders with brand and cockpit panels
  - Header agent/mode bar (Runner: Mock Adapter, Mode: Safe / Review-only, Execution: Contained Simulation)
  - Task intake form renders with description, action type, priority, product lane, workspace path
  - MOCK ONLY safety pill visible
  - Product lane selector includes all 6 lanes
  - User can create a mock task (API called with correct payload)
  - Created task appears in queue with product lane
  - Completed task shows status, recommended next action ("Task complete"), evidence summary, audit entries
  - Awaiting approval state shows "Approve mock simulation", approval buttons, "Decision needed" indicator
  - Rejected state shows "Rejected" next action and rejection message
  - Empty/loading/error states render correctly
  - No real execution controls or wording (no "execute", "run", "deploy", "codex", "ollama", "git push")
- Root `npm test` now runs both backend and frontend test suites
- New scripts: `npm run test:backend`, `npm run test:frontend`

## What P0.2 contains (unchanged)

- Node.js + TypeScript API bound to `127.0.0.1:3001`
- React + Vite + TypeScript cockpit bound to `127.0.0.1:5173`
- Local SQLite database using Node's built-in `node:sqlite` driver
- Append-only JSONL audit log
- Symlink/junction-aware workspace path containment guards
- Task intent, execution step, approval, evidence, and validation models
- Explicit task/step transition allowlists with conditional state updates
- Deterministic mock runner that never reads, writes, shells out, or calls a network service
- Three-panel dark UI with product-lane framing, agent/mode display, recommended next actions

## Mock-only boundary

P0.3 does NOT add:
- Loop Governor integration
- Codex integration
- Ollama integration
- Shell execution
- Git automation
- External API calls
- Authentication, billing, deployment, remote access, or autonomous operation
- Any runner capability to read files, write files, start processes, invoke git, call models, or use the network

The mock runner produces deterministic output only. No submitted command is executed. No requested file is modified.

## Prerequisites

- Node.js 22.13 or newer
- npm 10 or newer

## Install and run

```powershell
npm install
npm run dev
```

Open `http://127.0.0.1:5173`. The Vite development server proxies `/api` to the local backend.

## Workflow

1. Create a task: enter a description, choose an action type, select a product lane, set priority, and optionally specify a workspace-relative path.
2. The backend stores the task and one proposed execution step.
3. `analysis` and `read_file` previews are safe actions and simulate immediately.
4. `file_write`, `file_edit`, `shell_command`, and `unknown` actions wait for approval.
5. Approval runs the deterministic mock adapter; rejection ends the task without evidence.
6. Mock output, placeholder diff, validation, and audit events are saved locally.
7. The UI shows a **recommended next action** at all times.

## API

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Confirm mock-only local mode, runner, mode, and execution type |
| `GET` | `/api/lanes` | List available product lanes |
| `GET` | `/api/tasks` | List task queue |
| `POST` | `/api/tasks` | Create task and proposed step |
| `GET` | `/api/tasks/:taskId` | Read task, steps, evidence, and audit |
| `POST` | `/api/steps/:stepId/approve` | Approve and simulate a pending step |
| `POST` | `/api/steps/:stepId/reject` | Reject a pending step |
| `GET` | `/api/audit?limit=50` | Preview recent audit events |

## Validation commands

```powershell
# Typecheck (backend + frontend)
npm run typecheck

# All tests (backend + frontend)
npm test

# Backend tests only (29 tests)
npm run test:backend

# Frontend component tests only (31 tests)
npm run test:frontend

# Production build
npm run build

# Whitespace check
git diff --check
```

### Test coverage summary

| Suite | Tests | Coverage |
| --- | --- | --- |
| Backend (`operator.test.ts`) | 29 | Task creation, step creation, approval classification, reject/approve flows, repeat/invalid decisions, mock determinism, evidence persistence, audit errors, workspace containment, state transitions, API errors, product lanes, health mode, prohibited integration |
| Frontend (`console-smoke.test.tsx`) | 31 | App shell, header agent/mode bar, task intake form, MOCK ONLY safety pill, product lane selector (6 lanes), task creation flow, task queue rendering, completed task detail (status, next action, evidence, audit), awaiting approval state, rejected state, empty/loading/error states, no real execution controls |

## What changed in P0.3

- Added Vitest + React Testing Library + jsdom to frontend devDependencies
- Added `test` script to frontend package.json (`vitest run`)
- Added `test:backend` and `test:frontend` scripts to root package.json
- Updated root `test` script to run both backend and frontend suites
- Configured Vitest in `vite.config.ts` (jsdom environment, setup file, test include pattern)
- Updated `tsconfig.app.json` with Vitest and Testing Library types
- Added `src/test/setup.ts` — test setup with jest-dom matchers and cleanup
- Added `src/test/fixtures.ts` — mock task data (completed, awaiting approval, rejected states)
- Added `src/test/console-smoke.test.tsx` — 31 component tests across 8 describe blocks
- Updated README with P0.3 validation section


## What changed in P0.4

- Added `src/integrity/auditScanner.ts` — read-only audit JSONL scanner that reports parse errors, missing fields, and invalid event types without modifying the file
- Added `src/integrity/integrityChecker.ts` — read-only integrity checker that cross-references the database and audit log, reports orphaned steps/evidence, invalid status values, and audit/DB consistency gaps
- Added `checkIntegrity()` method to `OperatorService`, never modifies data
- Extended `GET /api/health` with an `integrity` summary: healthy flag, record counts, issue counts for both database and audit
- Added `path` getter to `AuditLogger` for diagnostics access
- Added 15 new backend tests (44 total): healthy state passes, malformed JSONL detected, missing fields detected, invalid event types detected, orphan steps/evidence detected, health endpoint integrity summary, no destructive repair, empty grace, FK enforcement guard
- All integrity checks are read-only; no automatic repair, no audit rewriting, no silent suppression

## P0.4 integrity checks

The health endpoint (`GET /api/health`) now includes a compact integrity summary:

Database checks:
- Every task has a valid status
- Every step has a valid status and action type
- Every step references an existing task
- Every evidence record references existing task and step records

Audit checks:
- Every JSONL line is valid JSON
- Every event has required fields: `id`, `event_type`, `task_id`, `data`, `created_at`
- Every `event_type` is a recognized value
- Audit task/step references are cross-checked against the database

The integrity checker is read-only. It never rewrites, deletes, or "fixes" data. Production foreign key and CHECK constraints remain enforced by SQLite. Audit log remains append-only.

## P0.4 limitations

## P0.3 limitations

- Component tests use mocked API responses — no integration with the real backend
- No Playwright/E2E browser tests — component-level coverage only
- `act()` warnings from React Testing Library are expected for async state updates and do not affect test results
- The mock-only runner, local-first behavior, and all P0.2 limitations remain unchanged

## Remaining P1 blockers

> **Superseded in part:** this paragraph reflects the P0.3 checkpoint, written before P1.0. P1.0 since shipped the bounded, allowlisted, read-only local runner described in "Local read-only runner and its command allowlist" above (`apps/backend/src/runners/realReadonlyRunner.ts`, `reviews/operator-p1-readonly-runner-report.md`) — process isolation via `execFile`/`shell: false`, a fixed 5-command allowlist, timeouts, output limits, and audit/DB persistence are implemented for that narrow read-only surface. The blockers below still apply to any *broader* runner integration (write/shell/deploy capability, autonomous operation) — none of that has shipped.

P1 remains intentionally unimplemented beyond the P1.0 read-only runner. Before any broader real runner integration (write, shell, or deploy capability), it needs a separate reviewed design for process isolation, operation-scoped filesystem capabilities, path revalidation at execution time, command allowlisting, timeouts, output limits, cancellation, idempotency, retry/recovery, and an atomic audit/state persistence strategy. Authentication, remote access, git automation, deployment, Loop Governor, YOLO Mode, and autonomous operation remain outside scope.
