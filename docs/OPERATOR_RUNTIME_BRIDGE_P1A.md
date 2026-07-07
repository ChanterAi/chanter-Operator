# CHANTER Operator — Runtime Bridge (P1A)

## Status

**Contract-only, decision-only bridge.** No execution. No network. No cross-repo imports. Not wired into any route/API/UI.

## Overview

`chanter-agent-runtime` (sibling repo, hardened at commit `bd1f310`) defines one shared execution
contract for CHANTER's control products:

```
Goal -> Plan -> Task -> Approval Gate -> Execution State -> Evidence
     -> Validation -> Review -> Result -> Next Recommendation
```

The Runtime Bridge is Operator's side of that contract: a backend module that lets Operator
represent its own work as `RuntimeTask`s, evaluate risky actions against the shared policy
model, build redacted evidence/review exports, and select a provider/tool route — all as pure,
synchronous, side-effect-free functions. It does not perform any of the actions it evaluates.

This is **P1A**, not a rewrite of Operator's existing systems, not a deploy/post/commit loop,
and not wired into Operator's live routes. It sits alongside the existing P1.1–P1.6
`agentRuntime/` module (the `AgentRunManifest` / six-state `PLAN→...→COMPLETE` contract), which
remains unchanged and untouched.

## Why a mirrored module instead of a package dependency

`chanter-agent-runtime` is a sibling repository with its own independent `package.json` and
`dist/` build output. `chanter-Operator`'s npm workspaces (`apps/*`) are scoped to its own apps
only — there is no existing workspace link between the two repos. Adding a
`"chanter-agent-runtime": "file:../../chanter-agent-runtime"` dependency would:

- reach outside `chanter-Operator`'s repo boundary (the mission for this loop explicitly
  restricts changes to this repo), and
- assume a specific sibling-directory layout that may not hold for every machine or CI runner
  that clones `chanter-Operator` on its own.

Instead, `apps/backend/src/agentRuntime/runtimeBridge/` is a **structural mirror**: every
type, transition rule, redaction pattern, task-lifecycle function, evidence-bundle shape,
action-policy rule, and provider-routing rule is copied field-for-field from
`chanter-agent-runtime`'s public exports (`src/index.ts`) and verified against that source. This
is the same convention already used by every adapter in `agentRuntime/adapters/`
(`safeCommitAdapter.ts`, `autoPosterAdapter.ts`, `loopGovernorAdapter.ts`), and by
`chanter-agent-runtime`'s own `safeCommitAdapter.ts`, which mirrors SafeCommit's
`AdvisoryContract` for the identical reason.

**Next-loop path to a real dependency:** once a workspace/package link is established (e.g.
`chanter-agent-runtime` published to a private registry, or a monorepo restructure that puts
both repos under one workspace root), the eight files under `runtimeBridge/` can be deleted and
replaced with `import ... from "chanter-agent-runtime"` without changing
`operatorRuntimeBridge.ts`'s public API — every exported name and shape already matches.

## Module layout

```
apps/backend/src/agentRuntime/runtimeBridge/
  contract.ts             — RuntimeTask/RuntimeStatus/... types + transition rules
  redaction.ts             — redactText / redactJsonValue / redactRecord
  tasks.ts                   — pure task-lifecycle functions (createTask, attachPlan, ...)
  evidence.ts                  — createEvidenceBundle / summarizeTaskForReview
  policy.ts                     — evaluateRuntimeActionPolicy (read/write/shell/network/commit/deploy/publish/delete)
  providerRouting.ts             — selectProviderRoute (no-network candidate selection)
  operatorRuntimeBridge.ts        — Operator-facing composed API (primary entry point)
  index.ts                         — barrel export

apps/backend/tests/
  operator-runtime-bridge.test.ts  — 75 deterministic tests
```

`agentRuntime/index.ts` re-exports the bridge's primary functions alongside the existing
P1.1–P1.6 exports, so both contracts remain reachable from one place during the transition
period referenced in `chanter-agent-runtime`'s own `docs/RUNTIME_CONTRACT.md` §2 (which
recommends eventually converging Operator's dormant six-state contract onto the richer
`RuntimeTask` model — not attempted in this loop).

## What is decision-only vs execution

Every function in this module is pure and synchronous: it takes data in, returns data out,
and performs no I/O.

| Capability | Function | Executes anything? |
|---|---|---|
| Represent Operator work as a runtime task | `createOperatorRuntimeTask` | No — builds a `RuntimeTask` object in `draft` status |
| Move a task through its lifecycle | `attachPlan`, `requireApproval`, `approveTask`, `startExecution`, `attachEvidence`, `startValidation`, `passValidation`/`failValidation`, `completeTask`/`failTask`, `blockTask`, `cancelTask`, `attachRecommendation` | No — each is `RuntimeTask -> RuntimeTask`; none run a shell command, write a file, or call the network |
| Decide whether an action may proceed | `evaluateOperatorRuntimeAction` | No — returns a `RuntimeActionDecision`; enforcement (actually refusing to run something) is the caller's responsibility |
| Export a redacted snapshot | `buildOperatorEvidenceBundle`, `summarizeOperatorRuntimeTask` | No — read-only projection of an existing task |
| Pick a provider/tool | `selectOperatorProviderRoute` | No — selects from an in-memory candidate list; never calls a model, tool, or endpoint |
| Report bridge readiness | `createOperatorAdapterReadinessReport` | No — pure derivation over a static primitive list |

## Policy and approval boundaries

`evaluateOperatorRuntimeAction(task, request)` evaluates one `RuntimeActionType` — `read`,
`write`, `shell`, `network`, `commit`, `deploy`, `publish`, `delete` — against a task's current
`status`, `riskLevel`, and `executionPolicy`:

- **`read`** is allowed at every non-terminal status.
- **`write` / `shell` / `network`** are gated by the task's approval state: blocked while
  `draft` (no plan) or `blocked`; `approvalRequired: true` while `approval_required` or while
  `planned` with an unresolved gate; allowed once `planned` (no gate needed), `approved`,
  `executing`, or `validating`.
- **`commit`** requires `executionPolicy` of `commit_guarded` or `requires_safecommit_review`,
  else `blocked: true` with `requiredPolicy: "commit_guarded"`.
- **`deploy`** requires `deploy_guarded`; **`publish`** requires `publish_guarded`; same
  blocked-with-`requiredPolicy` shape otherwise.
- **`delete`** is blocked by default — no delete execution path exists anywhere in this bridge.
  A `dryRun` request reports that honestly rather than faking a preview.
- **High/critical risk** (`riskLevel: "high" | "critical"`) forces `task.approvalRequired = true`
  at task-creation time regardless of `executionPolicy` — `requiresApprovalBeforeExecution`.
- **`dryRun: true`** on any request forces `allowed: false` in the decision — a dry run never
  reports as having actually been allowed to run.
- **Terminal tasks** (`completed` / `failed` / `cancelled`) cannot perform any action, `read`
  included; a new task must be created instead.

Operator's existing `ActionType` vocabulary (`apps/backend/src/types.ts`, used by
`ExecutionStep.action_type`) maps onto `RuntimeActionType` via
`mapOperatorActionTypeToRuntimeActionType`: `analysis`/`read_file` → `read`,
`file_write`/`file_edit` → `write`, `shell_command` → `shell`, `unknown` → `read` (the only
action allowed unconditionally, chosen as the conservative default).

## Redaction guarantees

`redaction.ts` mirrors `chanter-agent-runtime`'s pattern set: `KEY=value`/`KEY: value`
assignments for API/access/secret/private keys, passwords, secrets, tokens, and credentials;
`Bearer <token>` headers; OpenAI/Anthropic-style `sk-...` keys; GitHub `ghp_...` /
`github_pat_...` tokens; PEM private-key blocks; a fallback net for long (32+ char) mixed-case
alphanumeric tokens; and wholesale redaction of JSON object values under a
password/secret/token/`*_key`/credential key, regardless of shape. It is applied at the write
boundary (`tasks.ts`, when each field is constructed) and again, defensively, at the export
boundary (`evidence.ts`) so a hand-assembled `RuntimeTask` is still safe to export.

**Hardened beyond the upstream source:** while writing this bridge's end-to-end
no-secret-leakage test, `RuntimeTask.objective`, `RuntimeResult.summary`, and
`RuntimeValidationResult.summary` were found to pass through *unredacted* in
`chanter-agent-runtime`'s own `tasks.ts`/`evidence.ts` (verified against the source at commit
`bd1f310`) — only `inputs`, evidence `detail`/`source`, validation-check `message`, result
`output`, and recommendation `reason` are covered there. Since this loop cannot modify
`chanter-agent-runtime`, `runtimeBridge/tasks.ts` and `runtimeBridge/evidence.ts` additionally
redact those three fields at both boundaries — a one-line deviation from a literal mirror,
called out in each edited function and recommended for upstreaming in the next
`chanter-agent-runtime` hardening pass (see **Remaining risks** in the P1A delivery report).

Redaction is best-effort pattern matching, not a cryptographic guarantee, and is not a
substitute for keeping real secrets out of task data in the first place.

## Provider routing (no network)

`selectOperatorProviderRoute(request, candidates?)` picks the first `enabled` candidate from an
in-memory `RuntimeProviderRoute[]` matching `product` + `capability`, defaulting to
`DEFAULT_OPERATOR_PROVIDER_ROUTES` (Operator's own local read-only runner, the mock agent
runtime, and the SafeCommit advisory-adapter contract — plus one deliberately `enabled: false`
placeholder demonstrating that an unconfigured capability resolves to a `blocked` decision, not
a silent success). It never calls a model, tool, or network endpoint; wiring an actual provider
call remains entirely the caller's responsibility, same as upstream.

## Adapter / readiness integration

`operatorRuntimeAdapter` is a `RuntimeProductAdapter<CreateOperatorRuntimeTaskInput>`
(`id`, `product: "operator"`, `version`, `mapToRuntimeTask`, `buildEvidenceBundle`) — the same
shape `chanter-agent-runtime`'s `safeCommitAdapter` implements — so generic runtime tooling can
drive Operator's own work the same way it drives SafeCommit's.

Operator's existing P1.5/P1.6 adapter registry (`agentRuntime/adapters/adapterRegistry.ts`) is
a **closed catalog of three external product adapters** (`loop_governor`, `safecommit`,
`autoposter`) that Operator consumes; its tests assert an exact 3-entry catalog. The runtime
bridge is not an external product being consumed by Operator — it is Operator's own capability
to speak the shared contract — so it is deliberately **not** registered as a fourth catalog
entry (doing so would change the catalog's semantics and break ~15 existing P1.5/P1.6 tests for
no safety benefit). Instead, `createOperatorAdapterReadinessReport()` reuses the same
`AdapterReadinessStatus` vocabulary (`AdapterReadinessStatuses` from `adapterReadiness.ts`) for
consistent language, and reports:

- `status` — `"READY"` when every required primitive (task-mapping, action-policy,
  evidence-bundle, provider-routing, redaction, adapter-contract) is implemented, else
  `"INCOMPLETE"` listing what's missing.
- `supportedPrimitives` / `notImplemented` — what this loop shipped vs. what remains explicitly
  out of scope (cross-repo package link, `delete` dry-run preview, real provider invocation,
  live route wiring, guarded-action execution).

`deriveOperatorRuntimeBridgeReadiness(implementedPrimitives)` is exposed separately as a pure
function so tests can exercise the `INCOMPLETE` branch without needing to remove real code.

## Future integration path

- **AutoPoster**: any outbound post maps to a `publish` action — route it through
  `evaluateOperatorRuntimeAction` with `executionPolicy: "publish_guarded"` before treating a
  post as approved (mirrors `chanter-agent-runtime`'s own integration guidance for this product).
- **Loop Governor**: attach one `RuntimeTask` per governed iteration via
  `createOperatorRuntimeTask`; use `blockTask`/`attachPlan` recovery for stalled loops instead of
  fabricating a synthetic completion.
- **SafeCommit**: Operator-initiated commit flows should carry `executionPolicy: "commit_guarded"`
  (or `"requires_safecommit_review"`) so `evaluateOperatorRuntimeAction("commit", ...)` reflects
  the real gate.
- **MCP Server**: expose `buildOperatorEvidenceBundle`/`summarizeOperatorRuntimeTask` output to
  external callers, never raw `RuntimeTask` internals — the bundle is the redacted, JSON-safe,
  stable export shape this contract guarantees.
- **Memory Vault**: anything persisted through this bridge is already redaction-passed at the
  write boundary, but Memory Vault's own storage layer should not be the only place secrets are
  ever checked.
- **Package link**: once `chanter-agent-runtime` is reachable via a real workspace/package
  dependency, replace `runtimeBridge/*.ts` with direct imports (see "Why a mirrored module"
  above) — `operatorRuntimeBridge.ts`'s public API is designed not to need to change.

## Explicitly out of scope (P1A)

❌ No execution of read/write/shell/network/commit/deploy/publish/delete actions
❌ No real provider/model invocation ❌ No network calls
❌ No cross-repo imports / package dependency ❌ No wiring into Operator's routes, API, or UI
❌ No changes to `chanter-agent-runtime` ❌ No changes to the existing P1.1–P1.6 `agentRuntime/`
contract or the P1.5/P1.6 adapter registry/readiness gate ❌ No automatic commits

## Validation commands

```bash
npm run typecheck --workspace @chanter/operator-backend
npm run build --workspace @chanter/operator-backend
npm run test --workspace @chanter/operator-backend
```

Run from `apps/backend` directly (`npm run typecheck` / `npm run build` / `npm test`) also works.
