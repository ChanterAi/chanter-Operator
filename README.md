# CHANTER Operator — P0 Foundation

Local-first founder cockpit for reviewable task intake, approval gates, mock execution, evidence, and audit history. P0 deliberately does not integrate Loop Governor, Codex, Ollama, shell execution, git automation, external APIs, authentication, billing, or deployment.

## What P0 contains

- Node.js + TypeScript API bound to `127.0.0.1:3001`
- React + Vite + TypeScript cockpit bound to `127.0.0.1:5173`
- Local SQLite database using Node's built-in `node:sqlite` driver
- Append-only JSONL audit log
- Workspace path containment guard
- Task intent, execution step, approval, evidence, and validation models
- Deterministic mock runner that never reads, writes, shells out, or calls a network service
- Three-panel dark UI for queue, action/output inspection, approvals, evidence, and audit preview

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

These runtime files are ignored by git. The workspace is reserved for future adapters; P0's mock runner does not modify it.

## Workflow

1. Create a task and choose an explicit action type.
2. The backend stores the task and one proposed execution step.
3. `analysis` and `read_file` previews are safe actions and simulate immediately.
4. `file_write`, `file_edit`, `shell_command`, and `unknown` actions wait for approval.
5. Approval runs the deterministic mock adapter; rejection ends the task without evidence.
6. Mock output, placeholder diff, validation, and audit events are saved locally.

No P0 action executes the submitted command or touches the requested file. The action payload is a review artifact only.

## API

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Confirm mock-only local mode |
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
  "workspaceRelativePath": "config/preview.json"
}
```

Absolute paths and `..` escapes are rejected. Unrecognized action types normalize to `unknown` and require approval.

## Validation commands

```powershell
npm test
npm run typecheck
npm run build
```

The backend integration suite covers task creation, step creation, approval classification, reject and approve flows, mock execution, evidence persistence, append-only audit output, workspace path containment, status transitions, and API error behavior.

## P1 boundaries

P1 remains intentionally unimplemented. A real runner or Loop Governor bridge needs a separate security design for process isolation, filesystem capability grants, command allowlisting, timeouts, output limits, cancellation, recovery, and audit durability. Authentication, remote access, git automation, deployment, and autonomous operation are also outside P0.

