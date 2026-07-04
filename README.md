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

## P0.3 limitations

- Component tests use mocked API responses — no integration with the real backend
- No Playwright/E2E browser tests — component-level coverage only
- `act()` warnings from React Testing Library are expected for async state updates and do not affect test results
- The mock-only runner, local-first behavior, and all P0.2 limitations remain unchanged

## Remaining P1 blockers

P1 remains intentionally unimplemented. Before any real runner integration, it needs a separate reviewed design for process isolation, operation-scoped filesystem capabilities, path revalidation at execution time, command allowlisting, timeouts, output limits, cancellation, idempotency, retry/recovery, and an atomic audit/state persistence strategy. Authentication, remote access, git automation, deployment, Loop Governor, YOLO Mode, and autonomous operation remain outside P0.3.
