# CHANTER Operator — Runtime Bridge (P2A): Agent Runtime Real Dependency

## Status

**Dependency convergence only.** No new runtime behavior. No new routes/API/UI. Not wired into
Memory Vault, SafeCommit, MCP Server, Loop Governor, or AutoPoster.

## What changed

P1A's `runtimeBridge/` was a **structural mirror** of `chanter-agent-runtime`'s public contract,
hand-copied and manually kept in sync (see [P1A](./OPERATOR_RUNTIME_BRIDGE_P1A.md) — "Why a
mirrored module instead of a package dependency"). P2A replaces that mirror with a real
dependency for the four files that had zero Operator-specific behavior on top of the upstream
source:

| File | Before | After |
|---|---|---|
| `contract.ts` | Hand-copied types + transition functions, citing `chanter-agent-runtime` commit `bd1f310` | Re-exports types + transition functions from the real `chanter-agent-runtime` package |
| `policy.ts` | Hand-copied `evaluateRuntimeActionPolicy` | Re-exports from `chanter-agent-runtime` |
| `providerRouting.ts` | Hand-copied `selectProviderRoute` | Re-exports from `chanter-agent-runtime` |
| `redaction.ts` | Hand-copied `redactText`/`redactJsonValue`/`redactRecord` (byte-identical to upstream) | Re-exports from `chanter-agent-runtime` |

`tasks.ts` and `evidence.ts` are **unchanged in behavior** — they still redact `objective`,
`RuntimeResult.summary`, and `RuntimeValidationResult.summary` at both the write and export
boundary, a deliberate hardening beyond upstream that predates P2A and remains local to this
repo (upstream doesn't cover those three fields; see the comment in `redaction.ts`).
`operatorRuntimeBridge.ts`'s public API is unchanged — every exported name and shape is identical
to P1A.

## Why the hand mirror was removed

Both repos' own audits flagged the same drift risk: a manually-synced copy with no compile-time
enforcement that it stays in sync with its source. `contract.ts`/`policy.ts`/`providerRouting.ts`/
`redaction.ts` had no Operator-specific deviation from upstream, so hand-copying them added
maintenance risk (silent drift on the next `chanter-agent-runtime` change) with no corresponding
benefit. Converting them to real imports closes that risk permanently for those four files.

## Exact dependency path used

Added to `apps/backend/package.json`:

```json
"chanter-agent-runtime": "file:../../../chanter-agent-runtime"
```

Verified relative path from `apps/backend/package.json` to
`CHANTER/apps/chanter-agent-runtime/package.json` — resolves correctly (confirmed via
`path.resolve` and a live ESM `import()` of the linked package). Installed via
`npm install --workspace=@chanter/operator-backend` from the `chanter-Operator` root, which
created a Windows junction at `node_modules/chanter-agent-runtime` and a 16-line, scoped
`package-lock.json` update (no unrelated dependency changes).

## What is still a structural mirror (deliberately, out of scope for P2A)

`operatorRuntimeBridge.ts` §5 (`RuntimeAdapterInputEnvelope`, `RuntimeAdapterResult`,
`RuntimeProductAdapter`) remains a local structural mirror of
`chanter-agent-runtime/src/adapters/runtimeAdapter.ts`'s generic adapter contract — converging
that is a separate, larger decision (it would mean deciding whether Operator's own adapter should
implement the upstream `RuntimeProductAdapter<T>` interface directly) and was left alone to keep
this checkpoint narrow. Tracked in `operatorRuntimeBridge.ts`'s `NOT_YET_IMPLEMENTED` list.

## Validation commands

From `chanter-agent-runtime` (read/build-only, no commits made there):

```bash
npm run typecheck
npm run build
npm test
```

From `chanter-Operator`:

```bash
npm run typecheck
npm run test:backend
npm run build
git diff --check
```

## Explicitly out of scope (P2A)

❌ Wiring the bridge into any HTTP route/API/UI ❌ Memory Vault, MCP Server, SafeCommit, Loop
Governor, or AutoPoster changes ❌ Converging the adapter-contract types in
`operatorRuntimeBridge.ts` §5 ❌ Any new runtime behavior — this is a dependency-convergence-only
checkpoint ❌ Deploy, push, publish, or network actions

## Suggested next checkpoint

**Memory Vault P1B — Hardening & Integration Contract.** Now that Operator has a real,
non-mirrored path to `chanter-agent-runtime`'s `RuntimeTask`/evidence-bundle shape, Memory Vault's
runtime-intake adapter can eventually be validated against a real payload instead of
hand-written fixtures only — that is a separate, deliberate checkpoint, not implied or started
by this one.
