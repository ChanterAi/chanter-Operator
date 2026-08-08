# CHANTER OS — Collective Synthetic Intelligence Governed Model-Worker P0 — Result V1

## 1. Verdict

**BLOCKED.**

Everything the task specifies is implemented, tested, and proven **except one
thing**: no authorized *billed external* model provider exists in this
environment, so **monetary cost could not be measured or enforced against a live
provider**. §11 and §21 of the brief make that a hard PASS requirement, and §19
makes it an explicit stop condition. A BLOCKED result with exact evidence is
preferable to a fake PASS, so this is BLOCKED.

What *is* proven, with real measurements rather than simulation:

- **Real provider-backed model execution.** Two independent specialist nodes
  executed as bounded model workers against a real local inference server
  (`ollama` / `gemma4:e4b`), producing genuine inference.
- **Non-null measured token usage.** 1 364 input + 740 output = **2 104 tokens**,
  read from the provider's own `prompt_eval_count` / `eval_count`, never
  estimated.
- **Enforceable cost bounds.** Proven end to end — pre-dispatch worst-case
  refusal, post-call breach detection, and refusal of an unenforceable ceiling —
  but against a *priced test binding*, because the live provider is unbilled.
- **Everything else in §21**: closed hash-bound provider selection, no unadmitted
  context, no general tools, evidence-gated synthesis, deterministic fallback,
  reconciliation on unknown outcomes, no duplicate provider call across
  interruption or replay, one approval gating one atomic write, independent
  disk verification, and no persisted secret or hidden reasoning.

The Operator canonical gate is now **13 / 13**, run twice. The existing
Governed Agentic Execution Fabric proof remains green.

### The precise blocking fact

| Requirement | Status |
| --- | --- |
| At least one real authorized model-provider call | **Met** — 2 live calls, `mode: "live"` |
| Non-null measured token usage | **Met** — 2 104 tokens, provider-reported |
| Monetary cost measured **and** bounded against that provider | **Not met** |

The available provider is a local process. No provider bills it, so no invoice
exists to measure. This fabric therefore reports `monetaryCost: null` with a
stated reason rather than `0`, and **refuses** a monetary ceiling declared
against it rather than pretending to enforce one. Reporting `0` would be a claim
about a charge that was never issued; that is the single dishonest answer
available here, and it is the one this P0 declines to give.

`env` carries no `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or any other provider
credential. Creating one would mean creating an account, exposing a secret, or
changing billing — all three forbidden by §11.

## 2. Repository starting and ending truth

Every starting value below was derived with `git rev-parse` before any change,
and matched the brief exactly. All three worktrees were clean at start and end.

| Repository | Starting branch | Starting HEAD | Ending branch | Ending HEAD |
| --- | --- | --- | --- | --- |
| `apps/chanter-agent-runtime` | `runtime/agentic-node-execution-fabric-p0` | `2267cc9dc8b02458c9461a94f4331fde4e00f7b9` ✓ as briefed | `runtime/governed-model-worker-admission-p0` | `883b3319a92d66474372d4c6bad94dc8eacaa8b9` |
| `apps/chanter-loop.governor` | `governor/agentic-plan-governance-p0` | `60cb42a148be77ff0c8e66a62a2fc12019bab5bc` ✓ as briefed | `governor/agentic-plan-governance-p0` | `60cb42a148be77ff0c8e66a62a2fc12019bab5bc` — **unchanged** |
| `apps/chanter-Operator` | `os/governed-agentic-execution-fabric-p0` | `cd4c7c09f2661d975a974d4388e09e8238728cce` | `os/collective-synthetic-intelligence-model-workers-p0` | see §22 (self-referential) |

## 3. Architecture found

The Governed Agentic Execution Fabric P0 left the system **model-ready but
model-free**: the capability registry declared `model_worker` eligibility, the
router preferred it only when nothing cheaper sufficed, and `AgenticNodeCost`
already carried `tokenCost` / `monetaryCostMicros` fields — all honestly `null`,
because no capability in that plan routed to a provider.

Three gaps stood between that and real inference:

1. **No provider port.** `AgenticNodeWorkerContext.recordModelCall` existed to
   *account for* a model call, but nothing could *make* one.
2. **No way to ask for one.** A mission had no vocabulary for "this judgement
   needs a model", and the router's Effective Intelligence Density default would
   always pick the cheaper structured worker.
3. **No durable memory of a charge.** `operator_agentic_worker_records` knows
   "this node finished". Nothing knew "this provider was reached" — and those are
   different facts at different moments, separated by exactly the window in which
   a duplicate charge can occur.

## 4. Ownership decisions

Preserved the existing model exactly; nothing moved.

| Concern | Owner | Why not elsewhere |
| --- | --- | --- |
| Which capability may reach which provider binding | Operator | Operator already owns every durable mission authority. Authorization is an authority question. |
| Enforcement of token, cost, deadline, and schema bounds on one provider call | Agent Runtime | A bound must be enforced by whatever performs the action it bounds — not requested of the provider, not re-checked by the orchestrator. |
| Whether a node may run at all | Loop Governor | Unchanged. It decides admission, never what a model should say. |

**The Loop Governor changed by zero lines.** Its plan-cost and node-admission
contracts already sufficed: the plan cost budget it enforces is the *plan*
ceiling, and the per-node monetary ceiling this P0 adds is enforced inside the
Runtime at the moment of dispatch. Those are two different questions — "can this
plan afford to continue" and "may this one call be made at all" — and one number
cannot answer both. Adding a Governor concept for the second would have
duplicated cost accounting across two authorities, which §4 forbids.

**No second store, approval system, or cost ledger was created.** The provider
usage table is the *only* record of provider outcomes; the Runtime defines the
port, and Operator supplies the durable backing over the same SQLite file that
already holds the plan.

## 5. Exact implementation

### `chanter-agent-runtime` — 5 new files, 2 modified

| File | Lines | What it holds |
| --- | --- | --- |
| `src/agenticModelProvider.ts` | 1 134 | The governed invocation port: binding registry, pricing, all bounds, fallback chain, durable usage store contract |
| `src/agenticModelWorker.ts` | 218 | Adapts the port to the existing `AgenticNodeWorker` boundary |
| `src/adapters/ollamaModelAdapter.ts` | 231 | Real local provider transport |
| `src/adapters/simulatedModelAdapter.ts` | 177 | Deterministic failure-mode simulator (test mode only) |
| `tests/agenticModelProvider.test.ts` | 852 | 44 contract tests |
| `src/agenticNodeSchema.ts` | +55 | `agenticSchemaToJsonSchema` — projects the closed schema for constrained decoding |
| `src/index.ts` | +44 | Exports |

### `chanter-Operator` — 4 new files, 16 modified

New: `agenticProviderRegistry.ts` (252), `agenticProviderAdapters.ts` (149),
`tests/agentic-model-worker-admission.test.ts` (455),
`tools/os-csi-model-workers/run-csi-model-workers.mts` (1 688).

Modified: `agenticMissionContract.ts` (+84), `agenticIntentCompiler.ts` (+123),
`agenticCapabilityRegistry.ts` (+107), `agenticCapabilityRouter.ts` (+69),
`agenticPlanCompiler.ts` (+17), `agenticPlanJournal.ts` (+174),
`agenticWorkers.ts` (+172), `agenticMissionService.ts` (+89),
`db/schema.ts` (+54), `config.ts` (+22), `runtime.ts` (+1), `package.json`,
`osValidation.mts` (+13), `osValidation.test.mts` (+104 / −44),
`tsconfig.tools.json` (+2), `tools/os-agentic-fabric/run-agentic-fabric.mts` (+9).

### Durable schema — one additive table, one additive column

`operator_agentic_provider_usage` (PK `provider_call_key`), plus
`operator_agentic_plan_nodes.provider_binding_id`. No existing table or column
changed meaning. Nothing in Phase 2D was touched.

## 6. Provider registry and bindings

`agenticProviderRegistry.ts` — closed-world, registration is a reviewed code
change. Three bindings, each declaring all thirteen required fields.

| binding id | provider | model | mode | cost mode | fallback |
| --- | --- | --- | --- | --- | --- |
| `local.ollama.gemma4-e4b.judgment` | ollama | `gemma4:e4b` | **live** | `unpriced_local_compute` | **terminal (none)** |
| `simulator.primary` | simulator | `sim-judgment-a` | test | `local_price_snapshot` | `simulator.fallback` |
| `simulator.fallback` | simulator | `sim-judgment-b` | test | `local_price_snapshot` | terminal |

Structural obligations enforced at registry construction: duplicate ids, missing
identity fields, non-positive bounds, a locally-priced binding with no versioned
price snapshot, an unpriced binding with no stated reason, a fallback naming an
unregistered binding, and a cyclic fallback chain. Each has its own test.

**Capability → binding authorization** is a separate closed map. Only
`architecture.analyze` and `risk.analyze` appear in it. Every deterministic
capability — `evidence.verify`, `result.synthesize`, `artifact.local.write`,
`outcome.verify` — appears nowhere, which is the enforcement rather than an
omission: there is no binding for a mission to select, so "force the verifier
onto a model" has no representable form.

The live binding's fallback is **terminal on purpose**. There is exactly one
authorized live provider here, so an unavailable provider fails closed rather
than being answered by a simulator. A simulated analysis presented as a real one
would be the worst possible fallback.

`AGENTIC_PRICE_SNAPSHOT_REVISION = "chanter.agentic-price-snapshot.v1"`. The
simulator rates are deliberately fictional, for a deliberately fictional
provider. **No real provider's prices are invented anywhere in this fabric.**

## 7. Worker-selection policy

Two typed values on the intent contract, both in the intent hash:

```text
cheapest_sufficient            (default; recorded in defaultsApplied)
model_required_for_judgment
```

Required invariants, each pinned by a test:

| Invariant | How |
| --- | --- |
| deterministic capabilities can never be forced onto a model | the policy is consulted *after* the deterministic branch returns, and such capabilities authorize no binding at all |
| a mission cannot request an unregistered provider/model | `409 AGENTIC_INTENT_PROVIDER_BINDING_UNREGISTERED` at compile time |
| a mission cannot widen a capability's allowed worker kinds | the policy selects *among* declared kinds; it never adds one |
| worker selection participates in the intent hash | `executionPolicy` and `providerBindings` are hashed fields |
| provider binding participates in the node payload hash | `AgenticPlanNode.providerBindingId` is hashed |
| changed provider policy under one mission id causes conflict | different intent hash → `409 AGENTIC_INTENT_CONFLICT` |
| node-name or prompt-string matching is forbidden | routing reads only declared contract fields; pinned by routing `architecture.analyze` under the node name `"artifact.persist"` and getting an identical decision |

Nothing hardcodes N2/N3. A selection declared under `cheapest_sufficient` is
**refused** rather than accepted and ignored, because silently accepting a field
that changes nothing is how a caller comes to believe something is configured
when it is not.

## 8. Token and cost enforcement

### Before the call — a refusal costs nothing

Allowed provider/model, binding enabled, adapter wired, input bound within the
binding's context window, assembled-prompt character ceiling, node deadline
remaining, cancellation, and the monetary ceiling. Every one refuses **before
dispatch**, so the provider call count stays zero and no charge exists.

The input bound is *derived*, not declared: `maxInputTokens = maxTotalTokens −
binding.maxOutputTokens`. A node whose total cannot cover the binding's output
ceiling is refused rather than dispatched with an input budget of zero.

### Cost enforceability is three distinct modes, not one

Collapsing them would mean claiming enforcement that is not happening:

| cost mode | enforceable | when |
| --- | --- | --- |
| `local_price_snapshot` | `pre_and_post` | worst case is a function of bounds already fixed |
| `provider_reported` | `post_only` | the number does not exist until the provider states it |
| `unpriced_local_compute` | `unenforceable` | **a declared ceiling is refused** |

This split was found by a test. The post-call cost check was initially
unreachable — measured tokens are bounded, so measured cost could never exceed a
worst case computed from the same bounds. Making `provider_reported` post-only
made it reachable and correct, and both directions are now tested.

### After the call

Actual usage is persisted. Unreported usage fails closed
(`AGENTIC_PROVIDER_USAGE_NOT_REPORTED`) — an unmeasurable call is not accepted.
A token or cost breach is recorded **with its real measured usage** and the node
fails; there is deliberately no second call, because a bound that triggers a
retry is a bound that doubles the spend it was meant to cap.

Token cost is never inferred from call count.

## 9. Specialist independence

N2 and N3 both ran as model workers, and their independence is graph-enforced
rather than conventional:

- both depend only on N1; neither has an `inputRefs` edge to the other;
- **separate provider call keys** —
  `…:N2::local.ollama.gemma4-e4b.judgment` and `…:N3::…`;
- **different request hashes** — asserted, because two specialists asking the
  same question would not be two specialists;
- each sees only repository metadata plus **its own** approved fixture scope. The
  other specialist's fixture is withheld deliberately: if they shared evidence,
  the verifier's treatment of them as independent corroboration would be false.

Both use the same provider and model with distinct independent node requests.
**Multi-provider diversity is not claimed**, because only one live provider is
authorized here.

Observed concurrency **2**, `maxParallelism` 2, never exceeded — replayed from
the append-only event journal, not sampled.

## 10. Live-provider evidence

Environment probe, outside the fabric, before any claim about it:
`http://127.0.0.1:11434/api/tags` → `["gemma4:e4b"]`.

From `operator_agentic_provider_usage` on the final recorded run:

```text
provider            ollama
model               gemma4:e4b
mode                live                 (not "test")
provider calls      2                    (one per specialist node)
input tokens        1364                 measured (prompt_eval_count)
output tokens        740                 measured (eval_count)
total tokens        2104
finish reason       stop
fallback decision   not_required
request hash        64-hex, per call
raw response hash   64-hex, per call     (proves what returned; never stored)
response hash       64-hex, per call     (accepted document only)
provider request id null                 (Ollama issues none; none fabricated)
monetary cost       null
monetary source     unpriced_local_compute
pricing revision    null
```

`monetaryCostUnavailableReason` reads, in full: *"This binding runs a local
inference process. No provider bills it, so no invoice exists to measure;
estimating electricity or hardware amortization would be a fabricated number, and
reporting zero would be a claim about a charge that was never issued."*

Three distinct hashes on purpose. `requestHash` covers the bounded request;
`rawResponseHash` covers the complete provider response **including any hidden
reasoning it may have emitted**, proving what came back without that reasoning
ever becoming a stored artifact; `responseHash` covers only the accepted
document, and only after it passed the node's closed schema.

## 11. Verifier and rejected-claim evidence

The verifier and synthesis nodes are `deterministic_tool` — asserted at run time,
not assumed. On the live mission the model cited correctly: **8 accepted claims,
0 rejected**, contributed by both N2 and N3. Every accepted claim's
`evidenceRefs` was independently re-checked against the durable context bundle
rather than trusting the verifier's own verdict.

Because a real model that cites correctly cannot be made to cite badly on demand
without fabricating its output, the **rejection** proof runs where it is
deterministic — the simulator scenario, whose document deliberately contains one
claim citing `ctx-never-admitted-by-the-context-compiler`:

```text
verdict            accepted_with_rejections
rejected           2  (one per specialist, reason: unsupported_evidence)
accepted           2  (each specialist's supported claim survives)
contributing nodes N2, N3
```

### A real defect this P0 found

The verifier keyed unsupported and contradicting claims by `claimId` **alone**.
Claim ids are only unique *within* a node, and model workers number their
findings from one every single time — both live specialists returned
`claim1 … claim4`. One node's unsupported citation would therefore have rejected
the *other* node's well-evidenced claim: a silent loss of verified work, and the
opposite of what verification is for.

Fixed by keying on `nodeId::claimId`. Pinned by two tests: the colliding-id case
rejects only the node that cited badly, and a genuine cross-node contradiction
under colliding ids is still detected. Invisible with fixture-authored claims;
unavoidable the moment real models entered the plan.

## 12. Fallback evidence

| Scenario | Observed |
| --- | --- |
| primary transport never established | 4 provider records: 2 primary `AGENTIC_PROVIDER_UNREACHABLE`, 2 `fallback_used` from `simulator.primary`, both nodes `completed` |
| unknown outcome (timeout) | 2 records, **no fallback attempted**, both nodes `reconciliation_required`, N7 `blocked`, no artifact |
| malformed document | typed failure, `response_hash` null, **no fallback**, N5 never ran, no artifact |
| live provider unreachable | fails closed on the live binding; **no simulator fallback**, N7 `blocked`, no artifact |

A fallback cannot exceed the original bounds: it inherits the same request and
computes its timeout from the **original** deadline, so a chain cannot buy itself
more time, tokens, or money than the node was granted. Pinned by a test in which
the fallback breaches the *original* token bound and is refused.

## 13. Human-authority evidence

Unchanged from the prior P0 and re-proven here. The submit capability received
`401` on approve, and **zero provider calls existed at that point**. Before
candidate approval: no artifact, N7 `blocked`, 0 write rows, and a `resume`
produced no write. A mismatched candidate hash returned
`409 AGENTIC_AUTHORITY_CANDIDATE_MISMATCH` with no artifact.

Approval bound candidate hash `e8699349…6bc89d` and repository authority revision
`cd4c7c09f2661d975a974d4388e09e8238728cce`. Two human approvals total.

## 14. Artifact-write evidence

One atomic write inside the allowlisted directory.

```text
CHANTER_OS_COLLECTIVE_SYNTHETIC_INTELLIGENCE_MODEL_WORKER_READINESS_REPORT_V1.md
2331 bytes, all 9 required sections present
operator_agentic_artifact_writes rows = 1   (enforced by primary key)
```

N8 verified **from the bytes on disk**: `artifactExists true`,
`hashMatchesApprovedCandidate true`, `missingSections []`, `writeCount 1`,
`outcomeVerified true`.

## 15. Interruption and reconciliation evidence

Injected at the real two-commit boundary — after the Runtime durably recorded
N3's provider outcome, before Operator committed the node — because no HTTP
request can be timed into that window. The **recovery then ran through a real
restarted Operator server process** on the same SQLite file.

```text
N3 provider calls before recovery        1
POST .../nodes/N3/resume    -> 409 AGENTIC_NODE_RECONCILIATION_REQUIRED
POST .../nodes/N3/reconcile -> 200, outcome worker_result_found
    provider calls across the reconcile  1 -> 1   (reconcile only reads)
POST .../nodes/N3/resume    -> 200, state completed, attempts 1
N3 provider calls after resume           1
```

The recovered mission then converged: candidate composed, approved, artifact
written, `artifactWriteCount` 1, and `providerCallCount` **2** for the whole
mission — two specialists, two provider calls, even after an interruption.

Its durable value observation carries `recoveryEvents: 1`,
`duplicateExecutionsPrevented: 1`, and `duplicateModelCallsPrevented: 1`.

That last metric was initially wrong and is worth recording. It was keyed on
`attempts > 1`, which reports **zero exactly when a duplicate was most
decisively prevented** — because the entire point of recovery is that attempts do
*not* increase. It is now keyed on the reconciliation outcome.

## 16. Restart and replay evidence

Operator killed abruptly, restarted on a new port, identical submission resent:

| Observation | Before | After |
| --- | --- | --- |
| HTTP status | — | `200` with `replayed: true` |
| `planId` / `planHash` | `plan-b558ac13…` | identical |
| **Provider calls** | 2 | **2** |
| **Total tokens** | 2 104 | **2 104** |
| **Monetary cost** | `null` | **`null`** |
| Artifact write rows | 1 | **1** |
| Journal events | 33 | **33** |
| Artifact bytes | 2 331 | byte-identical |

A completed replay called no provider again.

Beneath the mission-level guard sits a deeper one: the provider usage store is
consulted **before any bound is evaluated**, so even a node whose worker record
was lost cannot re-purchase a recorded call — it returns
`AGENTIC_PROVIDER_ALREADY_INVOKED` with `outcomeUnknown: true`, forcing
reconciliation rather than a second charge.

## 17. Durable value observation

Read back through the unified OS view. Every `null` is genuinely unmeasured.

```json
{
  "objectiveSatisfied": true,
  "acceptanceCriteriaPassed": true,
  "acceptedClaimCount": 8,
  "rejectedClaimCount": 0,
  "evidenceCoverage": 5,
  "uncertaintyCount": 0,
  "artifactHash": "e8699349409159749058442c980d7f8ba5647f9c9c999e0a30e228bf716bc89d",
  "artifactWriteCount": 1,
  "workerCount": 7,
  "modelWorkerCount": 2,
  "providerCallCount": 2,
  "providerFallbackCount": 0,
  "inputTokenCount": 1364,
  "outputTokenCount": 740,
  "totalTokenCount": 2104,
  "tokenCostSource": "provider_measured",
  "monetaryCostMicros": null,
  "monetaryCostSource": "unpriced_local_compute",
  "modelIdentitiesUsed": ["ollama/gemma4:e4b"],
  "providerUsageReferences": ["…:N2::local.ollama.gemma4-e4b.judgment", "…:N3::…"],
  "parallelismObserved": 2,
  "toolCallCount": 5,
  "humanApprovals": 2,
  "recoveryEvents": 0,
  "duplicateExecutionsPrevented": 0,
  "duplicateModelCallsPrevented": 0
}
```

`tokenCost` moved from `null` to **2 104** — the number the previous P0 named as
its own last unmeasured gap. `monetaryCost` stays `null`, honestly.

Every field is derived from the durable provider usage rows rather than from a
copy on the node records: a summary should be derived from the fact, not from a
duplicate of it. All other OS lanes are unaffected.

## 18. Negative proofs

All twenty required by §12, each observed rather than asserted.

| # | Required proof | Result | Where |
| --- | --- | --- | --- |
| 1 | unregistered provider binding refused before worker creation | `409 AGENTIC_INTENT_PROVIDER_BINDING_UNREGISTERED`, 0 provider calls | proof step 3 |
| 2 | deterministic capability forced to model → refused | `409 AGENTIC_INTENT_MODEL_WORKER_NOT_PERMITTED` | proof step 4 |
| 3 | model worker requests unlisted tool → denied before tool port | model budget `maxToolCalls: 0`; observed tool calls 0 | test + registry assertion |
| 4 | model cites unadmitted context id → verifier rejects claim | 2 rejected, `unsupported_evidence`, supported claims survive | proof step 21 |
| 5 | malformed structured output → typed failure, no synthesis | `AGENTIC_PROVIDER_OUTPUT_NOT_JSON`, N5 `blocked`, no artifact | proof step 23 |
| 6 | provider timeout, no safe known outcome → reconciliation required | both nodes `reconciliation_required` | proof step 22 |
| 7 | provider recorded, Operator interrupted → resume refused until reconcile | `409 AGENTIC_NODE_RECONCILIATION_REQUIRED` | proof step 19 |
| 8 | reconcile finds durable outcome → no second provider call | 1 → 1 across the reconcile | proof step 19 |
| 9 | provider unavailable → declared fallback **or** fail closed | both proven separately | proof steps 21, 26 |
| 10 | fallback cannot exceed original token/cost/deadline bounds | fallback breaching the original bound is refused | Runtime test |
| 11 | per-node cost ceiling insufficient → provider call count zero | 0 provider records | proof step 24 |
| 12 | candidate write before approval → impossible | N7 `blocked`, 0 write rows, no file | proof step 14 |
| 13 | candidate bytes changed after approval → refused | `409 AGENTIC_AUTHORITY_CANDIDATE_MISMATCH` | proof step 15 |
| 14 | restart/replay → provider call count unchanged | 2 → 2 | proof step 20 |
| 15 | restart/replay → monetary cost unchanged | `null` → `null` | proof step 20 |
| 16 | artifact write count remains one | 1 → 1 | proof step 20 |
| 17 | no chain-of-thought or hidden reasoning in durable records | full-database sweep for `"thinking"`, `<think>`, `chain-of-thought` | proof step 12 |
| 18 | no credential in logs, state, artifacts, fixtures, git diff | full-database sweep + `Bearer`/`sk-`/`api_key` patterns + this run's real tokens; git diff scanned | proof step 12 + §21 |
| 19 | cancellation before provider call → call count zero | `AGENTIC_PROVIDER_CANCELLED_BEFORE_DISPATCH`, 0 dispatches | Runtime test |
| 20 | cancellation during call → typed cancellation, no duplicate call | `outcomeUnknown: true` → reconciliation, no retry | Runtime test |

Additional refusals proven beyond the required list: an unpriced provider
refusing an unenforceable ceiling; a model policy whose budget only covers the
cheapest plan; provider bindings declared under `cheapest_sufficient`; two
different bindings for one capability; unreported provider usage.

## 19. Validation results

Every command the brief requires, run against the final tree.

### Operator

| Command | Result |
| --- | --- |
| `npm run typecheck` | PASS (backend + frontend) |
| `npm run typecheck:tools` | PASS — **now covering both proof runners** (see §23) |
| `npm run build` | PASS |
| `npm run test:backend` | **981 / 981** (38 files; 956 before this P0, +25 new) |
| `npm run test:os-recovery` | PASS |
| `npm run test:os-platform-recovery` | PASS |
| `npm run test:os-ambiguous-reconciliation` | PASS |
| `npm run test:platform-canonical:e2e` | PASS |
| `npm run test:phase2c:mission` | PASS |
| `npm run test:approval-migration:e2e` | PASS |
| `npm run os:assembly` | PASS |
| `npm run os:unified` | PASS |
| `npm run os:agentic-fabric` | PASS (27 / 27 steps) |
| `npm run os:csi-model-workers` | **PASS (26 / 26 steps)** |
| `npm run test:os-validation` | **20 / 20** |
| `npm run validate:os` | **PASS 13 / 13** |

### Agent Runtime

| Command | Result |
| --- | --- |
| `npm run typecheck` | PASS |
| `npm run build` | PASS |
| `npm test` | **642 / 642** (598 before this P0, +44 model-provider tests) |

### Loop Governor — unchanged

| Command | Result |
| --- | --- |
| `git status --porcelain` | empty — **zero lines changed** |
| `python -m unittest tests.test_plan_governance` | **26 / 26** |
| `python -m unittest discover -s tests` | **1 247 tests, 1 failure** (exit 1) — see below |

The full-suite failure is
`test_operator_ledger_port.OperatorLedgerPortTests.test_oversized_http_error_body_rejected`.
Because this P0 changed the Loop Governor by **zero lines**, its worktree is
identical to the clean starting HEAD, so this failure is *by definition*
pre-existing rather than introduced here. It binds local HTTP ports and is
unrelated to plan governance. The same module and the same failure were recorded
as a residual risk by the previous P0. **The Governor's full suite is not
reliably green on this machine, and this result does not claim it is.**

### Focused and aggregate repetition

```text
npm run os:csi-model-workers  ->  PASS (26/26)   [standalone, twice]
npm run os:csi-model-workers  ->  PASS (26/26)   [twice more inside validate:os]
npm run validate:os           ->  PASS 13 / 13
npm run validate:os           ->  PASS 13 / 13
```

Each run uses isolated durable state under a fresh `mkdtemp` root, removed on
exit. Seven Operator server processes and six SQLite databases per run; zero
residue.

### Canonical stage order (13)

```text
 1 typecheck                        8 test:phase2c:mission
 2 typecheck:tools                  9 test:approval-migration:e2e
 3 build                           10 os:assembly
 4 test:os-recovery                11 os:unified
 5 test:os-platform-recovery       12 os:agentic-fabric
 6 test:os-ambiguous-reconciliation 13 os:csi-model-workers   <- new terminal
 7 test:platform-canonical:e2e
```

Appended as terminal on measured cost: it is the only stage performing real
inference (~4 minutes of the gate). Exact child exit codes are preserved, and
the new ordering gained a property the old one could not express — a failure in
`os:agentic-fabric` now **skips** the model-worker proof, so no inference is
spent testing a fabric whose deterministic path is already broken. Every pinned
stage-count and skip-list assertion was updated deliberately.

## 20. The CSI proof mission

`npm run os:csi-model-workers` — 26 steps across phases A–G, driving a real
Operator server process (the production `createRuntime()` wiring), a real
`python -m governor.plan_governance` child process, and a real local model.

Stated plainly, because conflating the two would be the easiest way for this
proof to lie:

- **Real** — phases A–F: two live provider calls per mission across two missions,
  measured usage, real Governor admission, real approvals, real artifact write,
  real interruption, real abrupt kill and restart.
- **Simulated** — phase G only: provider *failure* modes. No real provider can be
  asked to time out on command without lying about what happened. Every record
  produced there is stamped `mode: "test"`, and the runner asserts `mode: "live"`
  on the calls it counts as live-provider evidence.

The runner **refuses to run without a reachable live provider** unless
`--allow-missing-provider` is passed explicitly. A green gate that quietly
skipped the only real inference in the proof would be worse than a red one.

Observed identities from the final recorded run:

```text
osMissionId       os:governed_agentic_mission:csi-model-<runId>
planId            plan-b558ac13127c705642995e5fe57dfc53
candidateHash     e8699349409159749058442c980d7f8ba5647f9c9c999e0a30e228bf716bc89d
artifactHash      e8699349409159749058442c980d7f8ba5647f9c9c999e0a30e228bf716bc89d  (equal)
authorityRevision cd4c7c09f2661d975a974d4388e09e8238728cce
```

Digests differ between runs by design — the proof mints a fresh `missionId` per
run so each is genuinely isolated, and `missionId` participates in `intentHash`,
which participates in `planHash`. What is *stable* is the derivation: within one
run, and across the restart and replay in phase F, every one of these is
byte-identical.

## 21. Security and privacy

- **No credential exists to leak.** The one live provider is a local process
  requiring none. No adapter reads a secret; no binding carries one.
- **No provider URL from mission input.** The base URL comes only from
  configuration and is validated to be a bare http(s) origin — a path, query, or
  fragment is refused, and so is a non-http scheme.
- **Hidden reasoning is never requested.** `think: false` on every call. The
  model family supports a separate reasoning channel; the cheapest way to
  guarantee it is never persisted is to not ask for it. Pinned by a test that
  inspects the actual request body.
- **Only hashes, usage, citations, and bounded diagnostics are persisted.** The
  assembled prompt and the system instruction appear nowhere in durable state —
  swept for across every `operator_agentic_*` table.
- **This run's real capability tokens** were included in the sweep and are absent.
- **`git diff` scanned** for `sk-`, `Bearer`, `api_key`, and private-key headers:
  clean. `var/` (holding the proof's JSON report) is git-ignored.
- Provider diagnostics pass through the Runtime's existing `redactText`
  boundary before reaching any record.

## 22. Commits

Exactly one local commit per changed repository, in the brief's dependency
order. **Nothing pushed, merged, deployed, released, or published.**

```text
1  chanter-agent-runtime  883b3319a92d66474372d4c6bad94dc8eacaa8b9
      branch runtime/governed-model-worker-admission-p0
      feat(runtime): admit provider-backed model workers under enforced bounds

2  chanter-loop.governor  NOT CHANGED — no branch, no commit
      still 60cb42a148be77ff0c8e66a62a2fc12019bab5bc

3  chanter-Operator       (see below)
      branch os/collective-synthetic-intelligence-model-workers-p0
      feat(operator): admit collective synthetic intelligence model workers
```

The Operator SHA is deliberately not written here. This document is *inside* that
commit, so any SHA printed in it would be the hash of a different commit — the
one that existed before this sentence was added. Read the real value with:

```bash
git -C apps/chanter-Operator rev-parse os/collective-synthetic-intelligence-model-workers-p0
```

Its parent is `cd4c7c09f2661d975a974d4388e09e8238728cce`, the clean starting HEAD
recorded in §2, and it is the only commit on the branch.

Final git status:

```text
chanter-agent-runtime   runtime/governed-model-worker-admission-p0            clean
chanter-loop.governor   governor/agentic-plan-governance-p0                   clean, unchanged
chanter-Operator        os/collective-synthetic-intelligence-model-workers-p0 clean
```

## 23. Residual risks

1. **The blocking one: monetary cost is unmeasured against a live provider.**
   Enforcement is implemented and tested in all three modes, but only
   `local_price_snapshot` was exercised end to end, against a *fictional* test
   provider. Nothing here has ever been checked against a real invoice. This is
   the whole reason the verdict is BLOCKED.

2. **`validate:os` now requires a running local model server.** Stage 13 fails
   loudly without one. That is deliberate — a gate that skipped its only real
   inference would certify governance it never exercised — but it does make the
   canonical gate environment-dependent in a new way, alongside its existing
   python dependency.

3. **A fourth instance of the `tools/`-outside-tsconfig rot class.**
   `tools/os-agentic-fabric` was never added to `tsconfig.tools.json` when the
   prior P0 created it, so it belonged to no TypeScript program and rotted
   silently. This P0's required `providers` config field broke it, and the break
   surfaced only at *stage 12 of a 13-stage gate*, minutes into a run. Both proof
   runners are now inside the program, verified with
   `tsc -p tsconfig.tools.json --listFilesOnly`. **Any new `tools/` directory must
   be added to that include list in the same change that creates it.**

4. **`npm run test:backend` exited 1 once in five runs** while reporting all 38
   files and 981 tests passed. Not reproduced in four subsequent runs. Most
   likely an unhandled rejection or port contention after the summary in one of
   the server-spawning suites. Recorded rather than hidden; unexplained.

5. **`test_operator_ledger_port` remains environment-flaky in the Loop Governor.**
   Observed: 1 247 tests, 1 failure
   (`test_oversized_http_error_body_rejected`), exit 1. Pre-existing by
   construction — this P0 changed the Governor by zero lines, so its worktree is
   the clean starting HEAD. Unrelated to plan governance; the module passes in
   isolation. Its full-suite run is not reliably green on this machine.

6. **The live provider is local, so latency and determinism differ from a hosted
   one.** ~45 s per call here. A hosted provider would introduce network
   partitions, rate limits, and real timeouts — all handled by contract and
   proven against the simulator, none proven against a real remote.

7. **`provider_reported` cost mode is implemented and tested but never live.**
   No available provider reports a charge with its response.

8. **Simulator scenarios are a closed set of reviewed names**, not arbitrary
   data. That is deliberate — "simulate whatever this environment variable says"
   would be an injection surface deciding what a specialist concludes — but it
   means adding a failure mode is a code change.

9. **Two specialists share one provider and model.** Genuinely independent
   requests, but not provider diversity. A correlated provider-side failure would
   affect both, and this proof cannot detect that class.

10. **Contradiction detection remains a declared polarity convention.**
    Unchanged from the prior P0, and now more visible: two *model* specialists
    could contradict each other in different words, and the verifier would not
    catch it. Deliberate — real contradiction detection over prose needs a model,
    and a model's opinion is not something a verifier should fail a mission on.

## 24. Recommended next P0

Do not implement it in this task.

**Billed external provider cost authority.** The single gap between this result
and PASS is one authorized, billed, external provider binding: a credential from
secure configuration that never enters mission state, a `provider_reported` or
versioned-price-snapshot cost contract tied to that exact provider and model, and
a real charge enforced against `maxCostMicros` and reconciled against a real
invoice. Everything else — the port, the bounds, the durable usage record, the
fallback chain, the reconciliation path, the value observation — is already built
and proven, and would need no structural change.

After that, the brief's own recommendation stands: **Evidence-Governed
Operational Exception Mission P0**, binding this now-proven CSI fabric to one
domain-neutral `OperationalExceptionMission` fixture with observed state, desired
state, authority, evidence contract, verification oracle, compensation, and
value-linked closure — still in simulation/read-only mode before any customer
connector or physical operation.
