# CHANTER Operator — Agent Runtime Contract (P1.1)

## Status

**Current implementation: contract/mock only.** No real runner integration yet.

## Overview

The Agent Runtime Contract defines a shared execution interface that every CHANTER product (Loop Governor, SafeCommit, AutoPoster, Clean Engine, and future products) can implement. Operator orchestrates all products through a consistent six-state lifecycle without knowing product internals.

## Lifecycle

```
PLAN → EXECUTE → VALIDATE → EVIDENCE → HUMAN_REVIEW → COMPLETE
```

| State            | Purpose                                                       |
|------------------|---------------------------------------------------------------|
| **PLAN**         | Task decomposed, inputs validated. Entry point for every run. |
| **EXECUTE**      | Work is performed (mock-only in current implementation).      |
| **VALIDATE**     | Automated validation gates run (typecheck, tests, build, etc).|
| **EVIDENCE**     | Traceable references recorded for audit.                      |
| **HUMAN_REVIEW** | Review step before completion. Terminal — only COMPLETE after.|
| **COMPLETE**     | Final terminal state. No transitions out.                     |

## Core Types

### AgentRunManifest

Serializable JSON object representing one complete agent run. Contains:

- `runtimeId` — unique identifier for the runtime invocation
- `productId` — CHANTER product that initiated the run
- `taskId` — user-facing task identifier
- `lifecycleState` — current state in the lifecycle
- `stateTimestamps` — ISO-8601 timestamps for each state entry
- `policy` — timeout/retry/cancel rules governing the run
- `evidence` — array of `AgentRuntimeEvidenceRef` records
- `validation` — `AgentRuntimeValidationResult` (populated after VALIDATE)
- `failure` — `AgentRuntimeFailure` record if the run failed

### AgentRuntime Interface

```typescript
interface AgentRuntime {
  execute(manifest: AgentRunManifest): Promise<AgentRunManifest>;
  transition(manifest: AgentRunManifest, to: AgentRunLifecycleState): AgentRunManifest;
  cancel(manifest: AgentRunManifest): AgentRunManifest;
  serialize(manifest: AgentRunManifest): string;
  deserialize(json: string): AgentRunManifest;
}
```

## Contract Rules

1. **Forward-only transitions** — states progress in order. Backward transitions require explicit retry policy allowance.
2. **HUMAN_REVIEW is terminal** — only `HUMAN_REVIEW → COMPLETE` is valid; no other exits.
3. **COMPLETE is terminal** — no transitions out.
4. **Validation before COMPLETE** — `AgentRuntimeValidationResult` must be attached before reaching COMPLETE.
5. **Evidence required** — at least one `AgentRuntimeEvidenceRef` must exist at COMPLETE.
6. **Serialization** — every run must be fully representable as JSON and round-trip correctly.

## Future Product Mapping

### Loop Governor
- PLAN: Governor receives task parameters, validates scheduling window
- EXECUTE: Begin loop iteration
- VALIDATE: Check loop invariants (step count, execution time, error rate)
- EVIDENCE: Record iteration logs, metrics snapshots
- HUMAN_REVIEW: Operator reviews governor decisions
- COMPLETE: Loop run complete

### SafeCommit
- PLAN: Parse diff, identify affected files, classify risk
- EXECUTE: Stage files, prepare commit message
- VALIDATE: Run typecheck, tests, diff-check
- EVIDENCE: Record validation output hashes
- HUMAN_REVIEW: Operator reviews the proposed commit
- COMPLETE: Commit accepted or rejected

### AutoPoster
- PLAN: Parse content, destination, schedule
- EXECUTE: Prepare post payload
- VALIDATE: Content checks, link integrity, format validation
- EVIDENCE: Hash content, record preview
- HUMAN_REVIEW: Operator reviews post before publishing
- COMPLETE: Post published or queued

### Clean Engine
- PLAN: Scan target, identify redundant artifacts
- EXECUTE: Analyze dependencies, mark candidates
- VALIDATE: Safety checks (no active references, no runtime dependencies)
- EVIDENCE: Record pre-clean state hash, candidate list
- HUMAN_REVIEW: Operator reviews cleanup candidates
- COMPLETE: Cleanup performed or deferred

## Mock Runtime

`MockAgentRuntime` is a deterministic adapter that:
- Accepts a run manifest
- Progresses through each lifecycle state in order
- Produces deterministic validation results (all gates pass)
- Produces deterministic evidence references with content hashes
- Never touches external files or network
- Every run is serializable as JSON

## Tests

Comprehensive tests cover:
- Lifecycle order enforcement
- Invalid transition rejection
- Manifest JSON serialization round-trip
- Validation result attachment before COMPLETE
- Evidence reference production
- Mock runtime determinism
- Cancel policy enforcement
- Full execute integration
- Edge cases (missing validation, out-of-order timestamps, null timestamps)

Run with:
```bash
npm test -- agent-runtime
```

## Safety Constraints

- No real runner integration
- No network access
- No cross-repo imports
- No external file access
- Existing Operator behavior unchanged
- No deployment changes

## Module Location

```
apps/backend/src/agentRuntime/
  types.ts                  — All shared runtime types
  agentRuntimeContract.ts   — Lifecycle enforcement + verification
  mockRuntime.ts            — Deterministic mock implementation
  index.ts                  — Barrel exports

apps/backend/tests/
  agent-runtime.test.ts     — Comprehensive test suite
```
