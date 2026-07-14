# Resilience and recovery evidence procedure

This procedure is hermetic: it uses temporary SQLite files, in-memory AutoPoster test storage, local loopback HTTP, and synthetic media URLs. It does not invoke provider publishing APIs or production data.

## Authority and recovery contract

- Operator SQLite owns the mission execution record and append-only transition journal. Each execution-row update and journal append commits under one SQLite savepoint, including when the caller already owns a transaction. Governed states are `approval_required`, `approved`, `execution_started`, `downstream_request_prepared`, `downstream_result_observed`, `result_persisted`, `completed`, `failed_recoverable`, `failed_terminal`, `reconciliation_required`, and the bounded claim state `recovery_in_progress`.
- Runtime owns the stable SHA-256 payload identity over product, action, exact tenant scope, and canonical input. Replay is bound to mission ID, action, workspace, provider, canonical account ID, the unmodified idempotency key, exact payload hash, and downstream operation type before any stored evidence is returned.
- AutoPoster Firestore remains downstream truth. Its read-only reconciliation contract returns explicit `not_found`, `unique`, `conflict`, `scope_mismatch`, `idempotency_mismatch`, or `payload_mismatch`; a unique result is reusable only when exact mission, action, workspace, provider, account, idempotency key, payload hash, schedule string, unapproved state, and blocked publishing state all match.
- Required classifications are `RECOVERED_EXISTING_DOWNSTREAM_RESULT`, `SAFE_RETRY_COMPLETED`, `RECONCILIATION_REQUIRED`, `RECOVERY_SCOPE_MISMATCH`, `RECOVERY_DOWNSTREAM_UNAVAILABLE`, and `RECOVERY_EVIDENCE_INVALID`. Operator additionally records `DURABLE_REPLAY` for an exact completed replay.
- A not-found reconciliation permits one atomic retry claim. A unique result is attached without queue creation. A conflict permits only `Stop / escalate`.

Run from `C:\Users\IT\OneDrive\Desktop\CHANTER` in this order:

```powershell
Set-Location .\apps\chanter-agent-runtime
npm run typecheck

Set-Location ..\chanter-auto-poster
node --test test/autoposter-application-service.test.js test/runtime-control-routes.test.js
npm test
npm run build

Set-Location ..\chanter-Operator
npm run test:runtime:clean-source
npm run test:backend -- --run tests/runtime-mission-recovery.test.ts tests/runtime-missions.test.ts
npm run test:frontend -- --run src/test/runtime-missions.test.tsx
npm run test:backend
npm run test:frontend
node tools/resilience-evidence/clean-source-validation.mjs -- C:\Windows\System32\cmd.exe /d /s /c "npm run typecheck"
node tools/resilience-evidence/clean-source-validation.mjs -- C:\Windows\System32\cmd.exe /d /s /c "npm run build"
npm run test:resilience:cross-process
```

`test:runtime:clean-source` and `clean-source-validation.mjs` compile Runtime source into an isolated temporary directory, temporarily point Operator's local Runtime package junction at that fresh package, execute the requested validation, restore the original junction, and remove the temporary output. No pre-existing ignored Runtime `dist` is consumed.

Evidence mapping:

- Scenario A and B: `runtime-mission-recovery.test.ts`, normal execution and full database/service/Runtime executor recreation.
- Scenario C: injected `after_autoposter_durable_create_before_response`, followed by exact unique reconciliation and recovered completion.
- Scenario D: injected `before_autoposter_durable_create`, followed by genuine not-found reconciliation and the single permitted retry.
- Scenario E: Runtime and Operator mutation tests plus AutoPoster exact reconciliation scope, idempotency, payload, provider, and schedule tests.
- Scenario F: `cross-process-replay.mjs` starts two independent Node Runtime processes against the real AutoPoster application scheduling service and requires one AutoPoster create attempt, one downstream record, one queue ID, caller convergence, final Operator completion, one evidence chain, no split brain, and zero provider calls.
- Scenario G: conflicting downstream records force `reconciliation_required` and expose only `Stop / escalate`.
- All twelve required boundaries are covered by the boundary table in `runtime-mission-recovery.test.ts`; the AutoPoster and Runtime suites additionally assert the durable state immediately around their native internal hooks.
