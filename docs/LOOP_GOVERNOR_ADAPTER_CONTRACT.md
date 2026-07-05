# CHANTER Operator — Loop Governor Adapter Contract (P1.2)

## Status

**Current implementation: contract-only.** No real Loop Governor execution. No cross-repo imports. No Codex/Ollama/OpenClaw integration.

## Overview

The Loop Governor Adapter maps Loop Governor domain concepts into `AgentRunManifest` objects so that Operator can represent Loop Governor run summaries in its standard lifecycle dashboard. This is a pure data transformation — it never imports Loop Governor code, never executes shell commands, never makes network calls.

## State Mapping

| Loop Governor State    | Agent Lifecycle State |
|------------------------|----------------------|
| `planned`, `created`   | `PLAN`               |
| `running`, `iterating` | `EXECUTE`            |
| `validating`           | `VALIDATE`           |
| `collecting_evidence`  | `EVIDENCE`           |
| `awaiting_review`      | `HUMAN_REVIEW`       |
| `completed`, `closed`, `failed`, `cancelled` | `COMPLETE` |

### Terminal error states (`failed`, `cancelled`)

When a Loop Governor run is in `failed` or `cancelled` state:
- A synthetic `AgentRuntimeFailure` record is auto-generated (`LOOP_FAILED` / `LOOP_CANCELLED`)
- If explicit failure input is provided, it overrides the synthetic record
- Strict `verifyCompletedManifest` checks are relaxed — these states are expected to have non-passing validation
- Validation and evidence are still **required** (they document what went wrong)

## Input Types

### LoopGovernorRunInput

```typescript
interface LoopGovernorRunInput {
  loopId: string;            // Required — unique loop identifier
  taskId: string;            // Required — Operator-visible task ID
  state: LoopGovernorLoopState;  // Required — current Loop Governor state
  evidence?: LoopGovernorEvidenceInput[];
  validation?: LoopGovernorValidationInput;
  failure?: LoopGovernorFailureInput;
  stateTimestamps?: Partial<Record<AgentRunLifecycleState, string>>;
  runtimeIdPrefix?: string;  // Default: "lg-"
}
```

### LoopGovernorAdapterResult

```typescript
interface LoopGovernorAdapterResult {
  ok: boolean;
  manifest: AgentRunManifest | null;
  errors: string[];
}
```

## Strict Validation

The `mapLoopGovernorRunToManifest()` function enforces:

1. **Unknown state rejection** — only the 11 defined `LoopGovernorLoopStates` are valid
2. **Missing `loopId`** — empty or whitespace-only rejected
3. **Missing `taskId`** — empty or whitespace-only rejected
4. **COMPLETE without validation** — rejected for ALL terminal states including failed/cancelled
5. **COMPLETE without evidence** — rejected for ALL terminal states including failed/cancelled
6. **Out-of-order timestamps** — rejected if state timestamps decrease across the lifecycle
7. **Security blocklist** — inputs referencing `codex`, `ollama`, `openclaw`, `live-execution`, `shell-command`, URLs, or absolute filesystem paths are rejected

## Sample Fixture

`SAMPLE_LOOP_GOVERNOR_INPUT` is a deterministic sample that maps into a complete `AgentRunManifest`. It uses mock data — no real loop IDs, no operational paths, no private data.

## Future Integration Path

```
Loop Governor (separate repo/app)
  │
  │  emits run summary (loopId, state, evidence, validation)
  ▼
Operator P1.2 Adapter (this module)
  │
  │  mapLoopGovernorRunToManifest(input) → AgentRunManifest
  ▼
Operator UI
  │
  │  displays lifecycle timeline, evidence, review status
  ▼
Human Reviewer
```

No Loop Governor code is imported. The adapter is a contract-only bridge — Loop Governor emits a `LoopGovernorRunInput` JSON blob, Operator maps it, and Operator displays it. Both sides remain independently deployable.

## Exclusions

- ❌ No Loop Governor execution
- ❌ No Codex / Ollama / OpenClaw integration
- ❌ No shell execution
- ❌ No network access
- ❌ No cross-repo imports
- ❌ No database migration
- ❌ No frontend UI changes required
- ❌ No deployment changes

## Module Location

```
apps/backend/src/agentRuntime/adapters/
  loopGovernorAdapter.ts    — Contract-only adapter + sample fixture

apps/backend/tests/
  loop-governor-adapter.test.ts  — 50 tests
```

## Tests

50 tests covering:
- All 11 Loop Governor state → lifecycle mappings
- Missing/invalid identifier rejection
- COMPLETE without validation/evidence rejection (all terminal states)
- Timestamp order validation
- Security blocklist (codex, ollama, openclaw, live-execution, shell-command, URLs)
- Sample fixture completeness
- Manifest JSON serialization round-trip
- Failed/cancelled state → COMPLETE with synthetic failure
- Explicit failure override
- Custom runtimeId prefix
- Timestamp population for mid-lifecycle states
- Edge cases for evidence ID generation and policy timeout values
- Regression check: existing agent-runtime tests still pass
