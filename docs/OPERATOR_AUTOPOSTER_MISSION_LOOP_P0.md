# Operator AutoPoster Mission Loop P0

## Scope

This P0 adds one bounded product mission to CHANTER Operator:

```text
autoposter.post.schedule
```

It creates one scheduled AutoPoster queue draft after explicit Operator approval. It cannot publish, approve the AutoPoster draft, invoke the scheduler, or expose a generic network/write runner. The existing Operator task workflow remains mock/review-only.

## Architecture

```text
Operator AutoPoster Mission tab
  -> POST /api/runtime-missions/autoposter/schedule
  -> autoposter_runtime_missions (approval_required)
  -> POST /api/runtime-missions/:missionId/approve
  -> SQLite compare-and-set claim (executing)
  -> chanter-agent-runtime executeMission()
  -> registered AutoPoster mission adapter
  -> AutoPoster HTTP operations port
  -> token-guarded POST /api/runtime/schedule
  -> AutoPoster application service and workspace/commercial checks
  -> one create-only, unapproved queue draft
  -> redacted Runtime result/evidence persisted in Operator
```

`apps/backend/src/runtimeMissions/` is intentionally separate from both the generic mock task service and the older decision-only `agentRuntime/runtimeBridge/`. Routes do not call `fetch()`, know AutoPoster route paths, or implement product behavior.

The Runtime HTTP port sends the mission trace as `x-correlation-id`. AutoPoster's existing runtime route places that value into the product execution context and queue correlation metadata.

## Configuration

Operator reads four environment variables:

| Variable | Required | Purpose |
| --- | --- | --- |
| `AUTOPOSTER_BASE_URL` | Yes | AutoPoster server base URL, optionally with a path prefix, using HTTP or HTTPS without embedded credentials, query, or fragment. |
| `AUTOPOSTER_RUNTIME_TOKEN` | Yes | Service token sent only as `x-chanter-runtime-token`. It must match AutoPoster's `RUNTIME_CONTROL_TOKEN`. |
| `OPERATOR_RUNTIME_USER_ID` | Yes | Runtime tenant identity. It should represent the same logical owner as AutoPoster's `APP_DEFAULT_USER_ID`. |
| `AUTOPOSTER_RUNTIME_TIMEOUT_MS` | No | One-attempt request timeout. Integer from 100 through 120000 milliseconds; Runtime defaults to 10000 when omitted. |

Missing or invalid configuration does not stop Operator startup or its generic workflow. Health reports the mission capability as `configured: false`; an approved mission runs through the normal Runtime adapter over a fail-closed unavailable port and persists an `unavailable` result. Configuration readiness does not claim AutoPoster reachability, workspace access, entitlement, or account readiness.

The service token is held only in process memory by configuration, the HTTP-port closure, and an exact configured-value containment guard that rejects accidental token pastes before persistence. Runtime rejects downstream payloads that echo it, and Operator exact-redacts protected values again before result persistence. It is never placed in a mission request, database row, Runtime result, audit record, API response, or UI field.

## API contract

### Create

`POST /api/runtime-missions/autoposter/schedule`

```json
{
  "workspaceId": "workspace-id",
  "accountId": "connected-account-id",
  "provider": "tiktok",
  "mediaUrl": "https://cdn.example.com/video.mp4",
  "caption": "Caption",
  "hashtags": "#one #two",
  "scheduledAt": "2026-07-15T18:50:00+03:00"
}
```

For `provider: "youtube"`, `title` is required and `description` is optional. TikTok requests reject YouTube-only fields. The server validates bounded strings, an explicit timezone and future time, and an HTTPS media URL without embedded credentials, fragments, or credential/signature query parameters. AutoPoster remains authoritative for media eligibility.

The server creates `missionId`, `traceId`, and `idempotencyKey`, then persists `status: "approval_required"`. Creation never invokes Runtime or AutoPoster.

### Approve and execute

`POST /api/runtime-missions/:missionId/approve`

```json
{
  "approvedBy": "founder"
}
```

`approvedBy` must be nonblank. Operator reconstructs the Runtime request only from the immutable database row, not from approval-request fields. The response is the persisted mission with its complete redacted `runtimeResult`.

### Read

- `GET /api/runtime-missions?limit=50` returns `{ "missions": [...] }`, bounded to 100 and newest-first.
- `GET /api/runtime-missions/:missionId` returns one mission.

There is no update, retry, publish, approve-draft, reject, or cancel route in this P0.

## Approval and concurrency model

The dedicated SQLite row starts at `approval_required`. Approval performs a conditional update to `executing` inside `BEGIN IMMEDIATE` before any network await. A concurrent caller sees `executing` and receives HTTP 409. Once a redacted Runtime result is stored, every later approval returns that stored terminal result without a second execution, even if the caller supplies a different approver.

The Runtime action remains high-risk, `requires_approval`, and idempotency-required. Operator approval releases only this Runtime invocation. AutoPoster receives no self-approval value and its queue draft remains `approved: false`; Runtime rejects any purported successful response that does not prove a nonblank post ID, the requested provider/account/schedule, `status: "scheduled"`, and `approved === false`.

## Persistence and idempotency

The additive `autoposter_runtime_missions` table stores immutable request fields, approval identity, status, and the JSON-safe Runtime result. Product/action/provider/status constraints are enforced by SQLite. Trace IDs and idempotency keys are unique.

Duplicate prevention has three layers:

1. Operator conditionally claims one mission and never re-executes a stored result.
2. One process-level Runtime idempotency store rejects sequential replay.
3. AutoPoster derives a durable create-only document ID from verified workspace, tenant, account, and the Operator-generated key, then returns the existing draft on replay.

There is deliberately no automatic retry after `unavailable` or after an ambiguous process interruption.

## Evidence and redaction

Operator persists only `RuntimeMissionResult`, not raw HTTP failures. Runtime redacts outputs, warnings, errors, validation messages, and evidence before export. The UI displays the mission ID, trace ID, policy/approval/idempotency decisions, safe errors and warnings, evidence labels, and queue draft ID.

The generic JSONL audit model is task/step-specific and is not reused for mission IDs. Reusing it would make integrity cross-references dishonest. The mission row atomically owns its approval identity, state, result, and Runtime evidence.

## Health truth

`GET /api/health` keeps the generic truth unchanged:

```json
{
  "runner": "mock",
  "mode": "safe / review-only",
  "execution": "contained_simulation",
  "real_execution_enabled": false,
  "network_execution_enabled": false,
  "runtimeMissions": {
    "autoposter": {
      "configured": true,
      "executionScope": "schedule_unapproved_draft_only",
      "actions": ["autoposter.post.schedule"],
      "publishingEnabled": false
    }
  }
}
```

The two legacy booleans describe the generic task runner. The separate block is the only declaration of the bounded product mission.

## Local smoke procedure

The no-network acceptance proof is:

```powershell
npm run test:backend -- --run tests/runtime-missions.test.ts
npm run test:frontend -- --run src/test/runtime-missions.test.tsx
```

For a separately approved, non-production local product smoke:

```powershell
$env:AUTOPOSTER_BASE_URL = "http://127.0.0.1:3000"
$env:AUTOPOSTER_RUNTIME_TOKEN = "<same value as AutoPoster's RUNTIME_CONTROL_TOKEN>"
$env:OPERATOR_RUNTIME_USER_ID = "<same logical owner as APP_DEFAULT_USER_ID>"
$env:AUTOPOSTER_RUNTIME_TIMEOUT_MS = "10000"
npm run dev
```

Open the `AutoPoster Mission` tab, create a future-dated mission, inspect the exact summary, and approve it. Verify the returned queue draft in AutoPoster is scheduled but still unapproved. Do not run this procedure against production or approve a real schedule without explicit founder authorization.

## Known limitations

- A process crash after AutoPoster accepts the request but before Operator stores the result leaves the mission at `executing`. Operator will not retry that ambiguous state automatically; inspect AutoPoster by trace/idempotency key.
- Runtime's first idempotency layer is process-local. Operator persistence and AutoPoster's deterministic queue ID provide restart durability.
- Readiness is configuration truth, not a connectivity probe.
- AutoPoster's current service-token identity remains tied to its configured default user; this is not multi-user authentication.
- No live AutoPoster smoke or real schedule is part of the automated acceptance proof.
