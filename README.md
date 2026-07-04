# CHANTER Operator — P0.2 Operator Console

Local-first founder cockpit for reviewable task intake, approval gates, mock execution, evidence, and audit history. P0.2 upgrades the P0.1 mock-only foundation into a clearer Operator Console experience with product-lane framing, agent/mode display, recommended next actions, and improved state handling — without adding any real execution capabilities.

## What P0.2 contains

- Node.js + TypeScript API bound to `127.0.0.1:3001`
- React + Vite + TypeScript cockpit bound to `127.0.0.1:5173`
- Local SQLite database using Node's built-in `node:sqlite` driver (with P0.2 migration for `product_lane` column)
- Append-only JSONL audit log
- Lexical and existing-ancestor symlink/junction-aware workspace path containment guards
- Task intent, execution step, approval, evidence, and validation models
- Explicit task/step transition allowlists with conditional state updates
- Deterministic mock runner that never reads, writes, shells out, or calls a network service
- Synchronously flushed JSONL audit events with fail-closed write errors and corrupt-record detection
- Three-panel dark UI with:
  - **Operator Console header** with agent/mode bar (Runner: Mock Adapter, Mode: Safe / Review-only, Execution: Contained Simulation)
  - **Task intake form** with description, action type, priority, product lane, and workspace path inputs
  - **Mock-only safety notice** with `MOCK ONLY` pill badge
  - **Product-lane framing** (AutoPoster, Loop Governor, Clean Engine, Crypto Radar, Premium Site, CHANTER Operator)
  - **Task detail panel** with agent frame, recommended next action, execution step, evidence summary, mock output, diff preview
  - **Review panel** with approval/rejection controls, recommended next action, evidence timeline, and audit preview
  - Clear empty, loading, error, and disabled states

## Mock-only boundary

P0.2 does NOT add:
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

Local runtime files are created on first backend start:

- `data/operator.sqlite`
- `data/audit.jsonl`
- `workspace/`

These runtime files are ignored by git. The workspace is reserved for future adapters; P0.2's mock runner does not modify it.

## Workflow

1. Create a task: enter a description, choose an action type, select a product lane, set priority, and optionally specify a workspace-relative path.
2. The backend stores the task and one proposed execution step.
3. `analysis` and `read_file` previews are safe actions and simulate immediately.
4. `file_write`, `file_edit`, `shell_command`, and `unknown` actions wait for approval.
5. Approval runs the deterministic mock adapter; rejection ends the task without evidence.
6. Mock output, placeholder diff, validation, and audit events are saved locally.
7. The UI shows a **recommended next action** at all times: "Approve mock simulation", "Review evidence", "Task complete", "Rejected", or "Blocked / invalid".

No P0.2 action executes the submitted command or touches the requested file. The action payload is a review artifact only.

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

Create-task body:

```json
{
  "rawInput": "Preview a safe configuration edit",
  "actionType": "file_edit",
  "priority": 1,
  "productLane": "AutoPoster",
  "workspaceRelativePath": "config/preview.json"
}
```

Absolute paths, `..` escapes, and existing symlink/junction paths that resolve outside the workspace are rejected. Unrecognized action types normalize to `unknown` and require approval. Unrecognized product lanes normalize to `CHANTER Operator`.

## Validation commands

```powershell
npm test
npm run typecheck
npm run build
git diff --check
```

The backend integration suite covers task creation, step creation, approval classification, reject and approve flows, repeat/invalid decisions, mock determinism, evidence persistence, durable audit error behavior, symlink-aware workspace containment, status transitions, API error behavior, product lane storage and normalization, workspace path input, health endpoint mode reporting, and prohibited integration verification.

## What changed in P0.2

- Added `product_lane` field to task model with 6 predefined lanes and SQLite migration
- Added `GET /api/lanes` endpoint
- Extended `GET /api/health` to report mode and execution type
- Added workspace relative path input to task intake form
- Added product lane selector to task intake form
- Added mock-only safety pill notice in the intake form
- Added agent/mode bar to the header (Runner, Mode, Execution)
- Added agent frame section to task detail panel
- Added recommended next action bar to task detail and review panels
- Improved review panel to show context-aware messaging based on task state
- Added `task-card__lane` display in the task queue
- Improved empty/loading/error/disabled states with context-aware messaging
- Updated test suite with P0.2 coverage (product lanes, workspace path, health mode, prohibited integration check)
- Updated README for P0.2

## P0.2 limitations

- The runner is mock-only. It never reads files, writes files, starts processes, invokes git, calls models, or uses the network.
- Each task contains one in-process mock step; there is no queue worker, cancellation, retry, crash recovery, or multi-step orchestration.
- Path containment is checked when a task is created. Any future real filesystem adapter must re-check the path immediately before every operation and defend against link-swap race conditions.
- Audit records are flushed to the local JSONL file before the surrounding SQLite transaction commits. P0.2 fails closed on audit write errors and reports corrupt records, but SQLite and JSONL do not provide one atomic cross-file transaction.
- Local SQLite and JSONL files have no authentication, encryption, retention, backup, or multi-user coordination.
- Product lane is metadata only — no lane-specific routing, filtering, or behavior in P0.2.
- UI state handling is build-validated but has no automated browser/component test suite in P0.2.

## Remaining P1 blockers

P1 remains intentionally unimplemented. Before any real runner integration, it needs a separate reviewed design for process isolation, operation-scoped filesystem capabilities, path revalidation at execution time, command allowlisting, timeouts, output limits, cancellation, idempotency, retry/recovery, and an atomic audit/state persistence strategy. Authentication, remote access, git automation, deployment, Loop Governor, YOLO Mode, and autonomous operation remain outside P0.2.
