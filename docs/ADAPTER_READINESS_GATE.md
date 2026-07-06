# CHANTER Operator — Adapter Registry Readiness Gate (P1.6)

## Status

**Visibility-only readiness derivation.** No execution. No adapter invocation. No run/deploy controls. No network.

## Overview

The readiness gate derives a deterministic readiness status for each adapter registered in the P1.5 catalog. It answers one question for Operator: *if this adapter were asked to map a run, is its contract complete and permitted?* Nothing is executed — the gate only inspects registry metadata.

## Readiness Statuses

Evaluated in strict precedence order (first match wins):

| Status | Meaning | Usable |
|--------|---------|--------|
| `UNKNOWN` | Adapter id is not registered / no metadata | no |
| `INCOMPLETE` | Required contract sections missing or empty | no |
| `BLOCKED` | Availability blocked/deprecated, or allowed/forbidden action conflict | no |
| `MISSING_EVIDENCE` | No evidence requirements, no validation commands, or no sample fixture | no |
| `NEEDS_APPROVAL` | Complete and unblocked, but requires human approval (or high risk) | yes |
| `READY` | Complete, unblocked, evidenced, approval-free | yes |

`NEEDS_APPROVAL` and `READY` are the only usable statuses. `NEEDS_APPROVAL` is explicitly distinct from `BLOCKED`: an approval-required adapter is usable pending human sign-off; a blocked adapter is not usable at all.

## Governance Metadata (added to the P1.5 registry)

```typescript
interface AdapterGovernance {
  riskLevel: "low" | "medium" | "high";
  requiresApproval: boolean;
  allowedActions: string[];        // contract-level mapping actions only
  forbiddenActions: string[];      // never permitted
  evidenceRequirements: string[];  // what a run must evidence
  validationCommands: string[];    // declarative — never run by Operator
  availability: "available" | "blocked" | "deprecated";
}
```

Current catalog governance:

| Adapter | Risk | Approval | Availability | Derived Status |
|---------|------|----------|--------------|----------------|
| `loop_governor` | low | no | available | `READY` |
| `safecommit` | medium | yes | available | `NEEDS_APPROVAL` |
| `autoposter` | high | yes | available | `NEEDS_APPROVAL` |

## Derivation Rules

1. **UNKNOWN** — adapter id not in the catalog.
2. **INCOMPLETE** — any of: empty `adapterId` / `productId` / `displayName` / `contractDocPath`, `contractOnly !== true`, empty `supportedSourceStates` / `safetyNotes` / `exclusions`, `lifecycleStates` not covering all 6 lifecycle states, missing or malformed `governance` section.
3. **BLOCKED** — `availability` is `blocked` or `deprecated`, or any action appears in both `allowedActions` and `forbiddenActions`.
4. **MISSING_EVIDENCE** — empty `evidenceRequirements`, empty `validationCommands`, or `hasSampleFixture !== true`.
5. **NEEDS_APPROVAL** — `requiresApproval: true` or `riskLevel: "high"`.
6. **READY** — everything above passed.

Every report includes human-readable `reasons` explaining the verdict.

## API

| Function | Returns | Description |
|----------|---------|-------------|
| `deriveAdapterReadiness(metadata)` | `AdapterReadinessReport` | Pure derivation over (possibly partial) metadata |
| `evaluateAdapterReadiness(id)` | `AdapterReadinessReport` | Lookup + derive, never throws |
| `evaluateRegistryReadiness()` | `AdapterRegistryReadinessSummary` | All adapters + per-status counts |

## Explicitly Out of Scope

- No adapter execution or invocation.
- No run/deploy/approve buttons or controls.
- No changes to Loop Governor, SafeCommit, or AutoPoster adapter behavior.
- `validationCommands` are declarative metadata — Operator never runs them.
