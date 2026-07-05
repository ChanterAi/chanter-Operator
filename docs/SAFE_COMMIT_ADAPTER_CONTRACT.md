# CHANTER Operator — SafeCommit Adapter Contract (P1.3)

## Status

**Current implementation: contract-only.** No real SafeCommit execution. No git add/commit/push. No cross-repo imports. No Codex/Ollama/OpenClaw integration.

## Overview

The SafeCommit Adapter maps SafeCommit review concepts into `AgentRunManifest` objects so that Operator can represent commit review summaries in its standard lifecycle dashboard. Pure data transformation — never imports SafeCommit code, never executes git, never stages/commits/pushes.

## State Mapping

| SafeCommit State              | Agent Lifecycle State |
|-------------------------------|----------------------|
| `review_created`, `diff_received` | `PLAN`               |
| `analyzing_diff`, `classifying_risk` | `EXECUTE`            |
| `validating`, `checks_running` | `VALIDATE`           |
| `evidence_collected`, `report_ready` | `EVIDENCE`           |
| `awaiting_human_review`, `recommendation_ready` | `HUMAN_REVIEW`       |
| `accepted`, `rejected`, `blocked`, `completed` | `COMPLETE` |

### Terminal verdicts

- `accepted` → COMPLETE with no failure record
- `rejected` → COMPLETE with synthetic failure (`SAFECOMMIT_REJECTED`)
- `blocked` → COMPLETE with synthetic failure (`SAFECOMMIT_BLOCKED`)
- `completed` → COMPLETE (verdict determines pass/fail)

Strict `verifyCompletedManifest` checks are enforced only for `accepted` verdicts. Rejected/blocked/terminal states accept non-passing validation (they document what went wrong).

## Input Types

### SafeCommitReviewInput

```typescript
interface SafeCommitReviewInput {
  reviewId: string;              // Required
  taskId: string;                // Required
  state: SafeCommitReviewState;  // Required — one of 14 states
  changedFiles?: SafeCommitChangedFileInput[];
  risk?: SafeCommitRiskInput;
  verdict?: SafeCommitVerdict;   // Required for COMPLETE
  validation?: SafeCommitValidationInput;
  evidence?: SafeCommitEvidenceInput[];
  failure?: SafeCommitFailureInput;
  stateTimestamps?: Partial<Record<AgentRunLifecycleState, string>>;
  runtimeIdPrefix?: string;      // Default: "sc-"
}
```

### SafeCommitChangedFileInput

```typescript
interface SafeCommitChangedFileInput {
  filename: string;           // Must be relative — no absolute paths
  classification: "safe" | "risky" | "blocked" | "needs_review";
  linesAdded: number;
  linesRemoved: number;
  riskNotes?: string;
}
```

## Strict Validation

`mapSafeCommitReviewToManifest()` enforces:

1. **Unknown state rejection** — only the 14 defined states are valid
2. **Missing identifiers** — empty/whitespace reviewId or taskId rejected
3. **COMPLETE requirements** — validation, evidence, and verdict ALL required for any terminal state
4. **Path security** — rejects absolute paths, parent traversal, `.env*`, `secret*`, `credential*`, `.pem`, `id_rsa`, `.ssh/`, `.aws/`
5. **Git automation blocklist** — rejects `git add`, `git commit`, `git push`, `git merge`, `git rebase`
6. **Deploy/agent blocklist** — rejects `deploy`, `codex`, `ollama`, `openclaw`, `live execution`, `shell command`, `child_process`, URLs
7. **Timestamp order** — rejects out-of-order state timestamps
8. **Risk notes scanning** — unsafe references in `riskNotes` are also blocked

### Path Security Details

The following patterns are rejected in `changedFiles[].filename` and `changedFiles[].riskNotes`:

| Pattern              | Example blocked paths                    |
|----------------------|------------------------------------------|
| Absolute paths       | `C:\Users\...`, `/home/...`              |
| Parent traversal     | `../../etc/passwd`                       |
| Dotenv files         | `.env`, `.env.production`, `config/.env.local` |
| Secrets/credentials  | `credentials.json`, `secret-key.pem`, `id_rsa` |
| SSH config           | `.ssh/config`, `.ssh/authorized_keys`    |
| AWS config           | `.aws/credentials`, `.aws/config`        |

## Sample Fixture

`SAMPLE_SAFE_COMMIT_INPUT` is a deterministic sample that maps into a complete `AgentRunManifest`. It uses mock file names (`src/components/StatusBadge.tsx`, `docs/CHANGELOG.md`), no real diffs, no private paths, no operational data.

The fixture includes:
- 2 mock changed files (both `safe` classification)
- Low-risk assessment with 0 risky/blocked files
- Verdict: `accepted`
- 4 validation gates (typecheck, test, build, diff-check)
- 3 explicit evidence entries + auto-generated file-list and risk-report evidence

## Auto-Generated Evidence

Beyond user-provided evidence, the adapter automatically generates:
- **Changed files summary** — `sc-files-{reviewId}` with all filenames + classifications hashed
- **Risk assessment evidence** — `sc-risk-{reviewId}` with risk level and summary hash

## Future Integration Path

```
SafeCommit (separate repo/app)
  │
  │  emits review summary (reviewId, state, changedFiles, risk, verdict, evidence)
  ▼
Operator P1.3 Adapter (this module)
  │
  │  mapSafeCommitReviewToManifest(input) → AgentRunManifest
  ▼
Operator UI
  │
  │  displays lifecycle timeline, changed files, risk assessment, verdict
  ▼
Human Reviewer
```

No SafeCommit code is imported. No git operations are executed. The adapter is a contract-only bridge.

## Exclusions

- ❌ No SafeCommit execution
- ❌ No git add / commit / push / merge / rebase
- ❌ No file staging
- ❌ No Codex / Ollama / OpenClaw integration
- ❌ No shell execution
- ❌ No network access
- ❌ No cross-repo imports
- ❌ No database migration
- ❌ No frontend UI changes
- ❌ No deployment changes

## Module Location

```
apps/backend/src/agentRuntime/adapters/
  safeCommitAdapter.ts       — Contract-only adapter + sample fixture

apps/backend/tests/
  safe-commit-adapter.test.ts  — 79 tests
```

## Tests

79 tests covering:
- All 14 SafeCommit state → lifecycle mappings
- Missing/invalid identifier rejection
- COMPLETE without validation/evidence/verdict rejection (×4 terminal states)
- Timestamp order validation
- Path security (absolute, parent traversal, .env variants, secrets, SSH, AWS)
- Git automation blocklist (add, commit, push, merge)
- Deploy/agent blocklist (deploy, codex, ollama, openclaw, live execution, shell command)
- URL rejection
- Sample fixture completeness (state, productId, evidence count, validation, timestamps, no failure)
- Manifest JSON serialization round-trip
- Auto-generated evidence (changed-files summary, risk assessment)
- Failed/rejected/blocked → COMPLETE with synthetic failure
- Explicit failure override
- Custom runtimeId prefix
- Policy timeout values
- Regression: existing agent-runtime + Loop Governor tests still pass
