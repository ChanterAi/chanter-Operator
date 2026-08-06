# CHANTER OS — Governed Agentic Execution Fabric P0 — Result V1

## 1. Verdict

**PASS.**

One human mission is compiled into an immutable intent contract, an admitted
context bundle, and a deterministic eight-node plan; two specialist workers run
concurrently under a real Loop Governor admission decision; an independent
verifier rejects an unsupported claim; synthesis consumes only accepted claims;
two distinct human approvals gate execution and the one consequential write; a
single artifact is written atomically and independently verified; one node is
interrupted, reconciled and resumed with no duplicate worker invocation; and a
process restart replays the mission with no re-execution and no second write.

All three repositories changed. The canonical Operator gate is now **12 / 12**.

## 2. Starting and ending state per repository

| Repository | Starting branch | Starting HEAD | Ending branch | Ending HEAD |
| --- | --- | --- | --- | --- |
| `apps/chanter-Operator` | `os/persisted-approval-authority-consumer-migration-p0` | `7c6f7347298c00e55123888891404fde954ed13e` | `os/governed-agentic-execution-fabric-p0` | see §29 (self-referential) |
| `apps/chanter-agent-runtime` | `runtime/durable-mission-value-evidence-p0` | `4ab64e50f047f02ac33af7c27ad0812c93a59b6e` | `runtime/agentic-node-execution-fabric-p0` | `2267cc9dc8b02458c9461a94f4331fde4e00f7b9` |
| `apps/chanter-loop.governor` | `governor/native-task-bound-validation-p0` | `cc115c21163976b9ec60694840b276070eae308e` | `governor/agentic-plan-governance-p0` | `60cb42a148be77ff0c8e66a62a2fc12019bab5bc` |

Every starting HEAD matched the task brief exactly, and all three worktrees were
clean before any change.

## 3. Architecture found

Before this P0, CHANTER OS was a **safe mission control plane**: one canonical
`/api/os/missions` surface projecting three execution lanes, each of which
dispatches exactly one registered downstream product action.

- `osMissionContract.ts` — one canonical state taxonomy, one derived identity
  (`os:<lane>:<laneNativeId>`), one lane registry cross-checked at module load
  against the reviewed `missionActionRegistry`.
- `osMissionControlService.ts` — a router and a projection. It owns no store, no
  approval authority, and no execution.
- Phase 2D `operator_mission_graphs` — a durable DAG whose **node is a child
  mission dispatch** bound to one `(product, action)`.
- `chanter-agent-runtime` — `executeMission`, a durable idempotency claim, a run
  ledger, persisted signed approval checkpoints, unknown-outcome reconciliation.
- `chanter-loop.governor` — a Python product governing bounded product loops:
  attempt budgets, escalation, human approval, stop conditions.

**The missing capability** was an execution unit smaller than a mission. Nothing
existed that could bound *one unit of intelligence* by capability, tool
allowlist, budget, deadline, output schema, and evidence requirement — and
nothing could recover a single node of a graph without restarting the mission.

## 4. Ownership decisions

| Concern | Owner | Why not elsewhere |
| --- | --- | --- |
| Intent contract, context bundle, plan, authority, evidence, artifact | Operator | Operator already owns every durable mission authority; a second store would compete with it. |
| Bounded execution of one typed node | Agent Runtime | The bound must be enforced by the component that invokes the worker, not requested of the worker or re-checked by the orchestrator. |
| Admission: dependency readiness, concurrency, attempt budgets, deadlines, leases, cancellation | Loop Governor | These are the Governor's existing competence applied to a graph instead of a loop; stating them twice is the duplication the brief forbids. |

**The Phase 2D graph was deliberately not reused.** Its node is a child-mission
dispatch bound to one `(product, action)`; an agentic node is a capability-bound
worker with a budget, a deadline, an output schema, and an evidence requirement.
Overloading one table with both would have made every column optional for half
its rows. The new tables are additive; not one Phase 2D row or column changed.

**Identity was not duplicated.** The fabric is a fourth OS lane
(`governed_agentic_mission`) under the existing `os:<lane>:<id>` function, on the
existing `/api/os/missions` surface. There is one mission identity in CHANTER OS.

One honest generalization was required: `OsMissionLaneSpec` gained an
`executionModel`. A lane that dispatches one registered product action still
cross-checks against the reviewed action registry at module load; a plan-governed
lane has no single action to name, so it must declare its own downstream
operation identity instead. Both obligations are enforced at import time.

## 5. Intent contract compiler

`apps/backend/src/agentic/agenticIntentCompiler.ts`

```text
submission -> normalized intent contract -> canonical SHA-256 hash
```

Schema `chanter.agentic-work.v1`. Every field in §4 of the brief is present:
twenty of them on the compiled contract itself, and two — `osMissionId` and
`missionRevision` — derived rather than stored, because both already have exactly
one canonical derivation (`os:<lane>:<missionId>` and the journal event count).
Storing a second copy of either is how two answers to one question begin.
`payloadHash` is the contract's own `intentHash`, surfaced under the OS view's
canonical field name.

Order-insensitive fields are sorted before hashing, so two submissions differing
only in declaration order compile to identical bytes and identical hashes.

Two rules shape the module:

- **Never silently add a capability.** A mission whose output contract requires a
  capability it did not allow is refused *naming that capability*, never granted
  it. An agentic fabric that widens its own permissions has no bound at all.
- **Record every default explicitly.** `defaultsApplied` lists what the compiler
  supplied and why, so a reader can distinguish what a human asked for from what
  this code assumed.

The human's original wording is preserved in `humanText`, separate from compiled
semantics, and participates in the hash — so a reworded mission cannot inherit an
approval given for other words.

**Constraints are typed** (`{kind: require|forbid, subject, statement}`) because
contradiction between prose constraints is not machine-decidable. One subject
asserted both ways is refused by comparison, not by interpretation.

Typed refusals, all before any worker exists:

| Code | Condition |
| --- | --- |
| `AGENTIC_INTENT_FIELD_INVALID` | missing objective, empty acceptance criteria, malformed field |
| `AGENTIC_INTENT_CONSTRAINTS_CONTRADICTORY` | one subject both required and forbidden; capability both allowed and forbidden |
| `AGENTIC_INTENT_RISK_ACTION_UNSUPPORTED` | `external_write` / `irreversible`; artifact-writing mission not declaring `local_write` |
| `AGENTIC_INTENT_AUTHORITY_POLICY_REQUIRED` | `local_write` mission naming no approval policy |
| `AGENTIC_INTENT_FORBIDDEN_CAPABILITY_REQUIRED` | output contract requires a forbidden capability |
| `AGENTIC_INTENT_CAPABILITY_NOT_ALLOWED` | output contract requires a capability never granted |
| `AGENTIC_INTENT_BUDGET_BELOW_MINIMUM` | time budget below the summed default budgets of the required capabilities; `maxParallelism < 2` |
| `AGENTIC_INTENT_OUTPUT_CONTRACT_AMBIGUOUS` | no artifact name, path segments in the name, no/duplicate sections, unsupported format |
| `AGENTIC_INTENT_CAPABILITY_UNREGISTERED` | names a capability the closed registry does not carry |
| `AGENTIC_INTENT_CONFLICT` | same mission id, different compiled intent bytes |

The minimum executable budget is **derived** by summing the required
capabilities' declared default budgets, not written down as a constant, so it
cannot drift from what the plan actually costs.

## 6. Verified context compiler

`agenticContextCompiler.ts` + `agenticContextSources.ts` + `agenticToolSurface.ts`

Context is a first-class evidence object, never a prompt string. Each admitted
item carries `contextItemId`, `sourceType`, `sourceIdentity`, `contentHash`,
`retrievedAt`, `freshnessPolicy`, `trustClass`, `scope`, `claims`, and
`evidenceReference`.

Four guaranteed properties:

1. **Provenance survives.** The content hash covers the source identity, so
   identical bytes from two different sources remain two different items.
2. **Derived claims never masquerade as source.** `claims` is a separate field
   from the hashed content. Only content is hashed into the item's identity.
3. **Stale means refused.** A required item that cannot meet its freshness policy
   fails compilation (`AGENTIC_CONTEXT_STALE`); a non-required one is recorded in
   `rejectedRequirementIds`.
4. **Only admitted context reaches a worker.** The bundle's ids are the complete
   set a worker may cite, and the Runtime enforces that.

Deduplication is on `(sourceType, sourceIdentity, content)` — so two requirements
naming one file collapse to one item rather than becoming two that a verifier
would treat as independent corroboration.

`contextBundleId` is a deterministic digest of the accepted items' hashes, so a
changed source changes the bundle, which changes the plan.

Supported source types: `repository_file`, `repository_metadata`, `test_result`,
`operator_mission_state`, `static_fixture`. All five are implemented. The proof
mission uses four; `operator_mission_state` is exercised by the Phase F recovery
mission, which reads the completed Phase E mission's durable Operator state.

Reads go through the same bounded tool surface a worker uses — there is no
privileged path for "the system's own" reads. The whole repository is never fed
in: each requirement names one bounded source.

## 7. Capability registry

`agenticCapabilityRegistry.ts` — closed-world, registration is a reviewed code
change. Eight capabilities, each declaring all twelve required fields.

| capabilityId | owner | risk | authority | verifiability | worker kinds | side effect | tools |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `repo.metadata.read` | operator | read_only | none | deterministic | deterministic_tool | none | 5 read tools |
| `repo.file.read` | operator | read_only | none | deterministic | deterministic_tool | none | `repo.file.read` |
| `architecture.analyze` | agent_runtime | read_only | none | evidence_verifiable | structured_local_worker, model_worker | none | `fixture.read` |
| `risk.analyze` | agent_runtime | read_only | none | evidence_verifiable | structured_local_worker, model_worker | none | `fixture.read` |
| `evidence.verify` | operator | read_only | none | deterministic | deterministic_tool | none | *(none)* |
| `result.synthesize` | operator | read_only | none | evidence_verifiable | deterministic_tool | none | *(none)* |
| `artifact.local.write` | operator | **local_write** | **human_approval_bound_to_candidate_hash** | deterministic | deterministic_tool | local_artifact | `artifact.local.write` |
| `outcome.verify` | operator | read_only | none | deterministic | deterministic_tool | none | `artifact.local.read` |

Two invariants are enforced at **module load**, before the process accepts
traffic: no capability may declare `external_write` or `irreversible` risk or an
`external` side effect, and every `allowedTools` entry must exist in the closed
seven-tool registry.

The entire tool surface is seven tools, six read-only. There is no shell tool, no
network tool, and no general filesystem tool — the strongest possible statement
of "workers cannot reach outside their bounds" is that the mechanism does not
exist.

`repo.file.read` is registered because the brief names it as required. This proof
mission reaches repository files through N1's `repo.file.read` *tool* rather than
routing a separate node to that capability, so it is contract-complete and
available without being exercised as a node here. Stated rather than faked.

## 8. Router decision model

`agenticCapabilityRouter.ts`. For each node it records `selectedCapability`,
`selectedWorkerKind`, `selectedModelOrExecutor`, `reason`, `estimatedCostUnits`,
`estimatedLatencyMs`, `risk`, `requiredEvidence`, `authorityRequirement`, and
`fallbackPolicy`.

**Effective Intelligence Density.** Preference order is fixed:

```text
deterministic tool  ->  structured local worker  ->  model worker
```

A capability whose declared verifiability is `deterministic` may only route to a
deterministic worker. Only judgement-bearing capabilities become eligible for a
model worker, and then only if no cheaper worker kind is registered. **Observed:
zero model calls across the entire proof mission** — nothing in this plan needs
inference, so nothing spends any.

**No string matching.** Routing reads only declared contract fields:
`verifiability`, `riskClass`, `allowedWorkerKinds`, `authorityRequirement`. It
never inspects a node name, objective text, or prompt. Pinned by a test: the same
capability routed under `"N7"` and under `"totally.different.node.name"` reaches
the same authority conclusion, and `architecture.analyze` routed under the node
name `"artifact.persist"` still requires no authority.

## 9. Plan graph contract

`agenticPlanCompiler.ts`. The plan is a pure function of the intent hash and the
context bundle id — no clock, no random source, no environment.

```text
N1  context.collect.repository_state   repo.metadata.read
 ├─ N2  specialist.architecture_analysis   architecture.analyze
 └─ N3  specialist.risk_analysis           risk.analyze
         └─ N4  verifier.cross_check       evidence.verify   (N2 + N3)
             └─ N5  synthesis.compose      result.synthesize
                 └─ N6  authority.approve_local_write   (no worker)
                     └─ N7  artifact.persist   artifact.local.write
                         └─ N8  outcome.verify  outcome.verify
```

Each node carries `nodeId`, `planId`, `nodeType`, `capabilityId`, `inputRefs`,
`dependencyIds`, `authorityRequirement`, `budget`, `deadlineOffsetMs`,
`attemptLimit`, `reconciliationMode`, `outputSchema` (via capability),
`evidencePolicy`, `state`, and `payloadHash`.

Structural properties, each pinned by a test:

- N2 and N3 depend only on N1 and have **no `inputRefs` to each other** — their
  independence is graph-enforced, not convention.
- N5's only input is N4. There is **no specialist → synthesis edge**, so an
  unverified claim has no path into the artifact even if synthesis were wrong.
- N6 has `capabilityId: null` and a zero budget. An authority checkpoint is a
  state the plan waits in, not a task an agent performs.
- N7's `attemptLimit` is **1**. A second automatic attempt at a write whose
  outcome is unknown is how one artifact becomes two; its recovery goes through
  reconciliation and explicit human resume, never a retry budget.

Determinism is enforced at compile time (Kahn's algorithm for cycles, unknown
dependency and duplicate-edge refusal) and proven by test: identical intent +
context yields identical `planId`, node ids, edges, and payload hashes; a changed
context bundle yields a *different* `planId` rather than mutating the old plan.

## 10. Runtime worker execution contract

`chanter-agent-runtime/src/agenticNode.ts` — `executeAgenticNode(request)`.

Request carries mission/plan/node identity, capability binding, bounded input,
budget, deadline, allowed tools, output schema, evidence requirements, accepted
context ids, and an idempotency key. Result carries `status`, `structuredOutput`,
`outputHash`, `evidence`, `toolCallRecords`, `cost`, `latencyMs`,
`valueObservation`, `idempotencyOutcome`, and `typedError`.

Every worker restriction from §9 of the brief is enforced **by the Runtime**,
not requested of the worker:

| Restriction | Enforcement |
| --- | --- |
| cannot add capabilities | capability arrives in the request; the worker context is frozen and carries no mutator |
| cannot change its budget | counters live in the module's closure |
| cannot invoke unlisted tools | `boundedToolInvoker` checks the allowlist **before** the tool port is reached |
| cannot write outside its path | no filesystem capability is passed; writes are an allowlisted tool |
| cannot spawn uncontrolled subagents | the context exposes no executor |
| cannot claim acceptance without evidence | `evidencePolicy` checked after return, before success |
| cannot mark the mission complete | no field of the result says so |

`agenticNodeSchema.ts` is a closed schema language, not a JSON Schema subset. An
object carrying a field the schema does not declare is **rejected** — that field
is exactly where an unbounded worker would smuggle an unverified claim.

**Cost is measured only.** `tokenCost` and `monetaryCostMicros` stay `null`
unless a model call actually reported them; they are never inferred from call
counts. Observed in the proof: both `null`, with 7 tool calls and 0 model calls.

**The two-commit window.** The Runtime durably records "this worker ran and
produced exactly this" (`recordWorkerOutcome`); the caller then durably records
"the plan node is complete". The gap between them is a real interruption
boundary, and it is the one Phase F interrupts.

## 11. Governor contract

`chanter-loop.governor/governor/plan_governance.py` — a pure, deterministic
admission kernel plus a JSON stdin/stdout process bridge
(`python -m governor.plan_governance`).

It holds **no mission semantics**: its request contract has no field for an
objective, capability, prompt, model, tool, output, claim, or evidence. It
decides *whether a node may run*, never *what running it means*. It holds no
durable state: the caller's journal remains the single source of truth and
commits leases under its own compare-and-swap, so a decision computed from a
stale snapshot simply fails to commit.

Rules, each with its own typed hold code:

1. **Dependency truth first** — admissible only when every dependency is
   `completed`; a node behind a terminal failure is reported `unreachable`.
2. **Reconciliation before retry** — `reconciliation_required` is never admitted,
   and neither is a `running` node whose lease expired. An expired lease means
   the outcome is *unknown*, and re-leasing an unknown outcome is exactly how a
   side effect happens twice.
3. **Budgets are ceilings** — attempt limit, node deadline, plan deadline, and
   plan cost budget each independently withhold admission.
4. **Concurrency counts live leases** — admission stops at `maxParallelism` minus
   nodes already holding one.
5. **Cancellation is immediate and total.**

Hold codes: `DEPENDENCY_NOT_SATISFIED`, `DEPENDENCY_TERMINALLY_FAILED`,
`CONCURRENCY_LIMIT_REACHED`, `ATTEMPT_LIMIT_EXHAUSTED`, `NODE_DEADLINE_EXCEEDED`,
`PLAN_DEADLINE_EXCEEDED`, `PLAN_COST_BUDGET_EXHAUSTED`, `RECONCILIATION_REQUIRED`,
`LEASE_EXPIRED_RECONCILIATION_REQUIRED`, `LEASE_HELD`, `CANCELLATION_REQUESTED`,
`NODE_TERMINAL`.

Determinism: nodes are considered in ascending `nodeId` order and admitted until
capacity is exhausted, so two calls on one snapshot always return the same
decision.

`agenticPlanGovernorPort.ts` **fails closed**: an unconfigured, crashed,
malformed, or timed-out governor admits nothing. A stalled plan is visible and
resumable; a node admitted against the Governor's judgement is a duplicate side
effect nobody asked for.

The time budget is a **compute** budget: the plan deadline sent to the Governor
is `now + (timeBudgetMs − measured node latency)`, so a plan waiting on a human
never runs out of time.

## 12. API surface

Extended the existing `/api/os/missions` identity — no second mission namespace.

```text
POST /api/os/missions                                     (submit token)
GET  /api/os/missions
GET  /api/os/missions/:osMissionId
GET  /api/os/missions/:osMissionId/plan                   [new]
GET  /api/os/missions/:osMissionId/nodes                  [new]
GET  /api/os/missions/:osMissionId/nodes/:nodeId          [new]
GET  /api/os/missions/:osMissionId/evidence               [new]
POST /api/os/missions/:osMissionId/approve                (control token)
POST /api/os/missions/:osMissionId/reconcile              (control token)
POST /api/os/missions/:osMissionId/resume                 (control token)
POST /api/os/missions/:osMissionId/stop                   (control token)
POST /api/os/missions/:osMissionId/nodes/:nodeId/reconcile  [new] (control token)
POST /api/os/missions/:osMissionId/nodes/:nodeId/resume     [new] (control token)
POST /api/os/missions/:osMissionId/nodes/:nodeId/stop       [new] (control token)
```

A lane that dispatches one downstream product action answers the plan-governed
surfaces with a typed `409 OS_MISSION_LANE_NOT_PLAN_GOVERNED` rather than a
fabricated single-node plan. Proven in the run.

**One OS verb, two authorities.** `approve` means "grant whichever authority this
mission is currently waiting for", and which one that is comes from durable state
rather than from the caller — a caller able to choose could approve a candidate
that was never composed. Adding a fourth OS verb would have made every other
lane's vocabulary incomplete for no gain.

`OsMissionAuthority` gained `candidateOutputHash` and `approvedOutputHash`,
reported by **every** lane (`null` where an approval binds a request rather than
an output). A field present on some lanes and absent on others would break the
one property the unified shape check exists to hold. The `os:unified` proof
caught this change and its pinned contract was updated, not worked around.

Existing generic, Platform, and direct AutoPoster lanes are untouched:
**956/956** backend tests pass (925 before this P0; +29 new fabric contract
tests, and 4 pinned assertions updated to admit the fourth lane and the three
node routes), together with `os:assembly` and `os:unified`.

## 13. Files changed

### `apps/chanter-Operator` — 15 modified/added

New (`apps/backend/src/agentic/`, 6 449 lines):
`agenticMissionContract.ts` (504), `agenticIntentCompiler.ts` (567),
`agenticContextCompiler.ts` (203), `agenticContextSources.ts` (159),
`agenticCapabilityRegistry.ts` (615), `agenticCapabilityRouter.ts` (170),
`agenticPlanCompiler.ts` (321), `agenticPlanJournal.ts` (1 198),
`agenticPlanGovernorPort.ts` (251), `agenticMissionService.ts` (1 400),
`agenticToolSurface.ts` (215), `agenticWorkers.ts` (716),
`agenticCandidateRenderer.ts` (100), `agenticAuthorityRevision.ts` (30).

New elsewhere: `tools/os-agentic-fabric/run-agentic-fabric.mts` (1 524),
`apps/backend/tests/agentic-fabric-contract.test.ts` (404).

Modified: `apps/backend/src/db/schema.ts` (7 additive tables),
`apps/backend/src/os/osMissionContract.ts` (4th lane, execution model, agentic
state mapping, two authority fields, third downstream identity kind),
`apps/backend/src/os/osMissionControlService.ts` (routing + projection +
plan-governed surfaces), `apps/backend/src/routes/api.ts` (7 routes),
`apps/backend/src/runtime.ts` + `config.ts` (wiring), `package.json`
(`os:agentic-fabric`), `tools/validation/osValidation.mts` (+stage),
`tools/validation/osValidation.test.mts` (+contract), plus two pinned tests
updated (`os-mission-contract`, `runtime-missions`) and `tools/os-unified`'s
authority shape.

### `apps/chanter-agent-runtime` — 4

New: `src/agenticNode.ts` (1 070), `src/agenticNodeSchema.ts` (283),
`tests/agenticNode.test.ts` (378). Modified: `src/index.ts` (exports).

### `apps/chanter-loop.governor` — 2

New: `governor/plan_governance.py` (632), `tests/test_plan_governance.py` (367).
No existing module changed.

### Durable schema (all additive)

`operator_agentic_missions`, `operator_agentic_plan_nodes`,
`operator_agentic_plan_edges`, `operator_agentic_plan_events`,
`operator_agentic_node_evidence`, `operator_agentic_worker_records`,
`operator_agentic_artifact_writes`. No existing table or column changed.

## 14. Proof mission

`npm run os:agentic-fabric` — 27 steps across phases A–G, driving a real Operator
server process (`apps/backend/src/server.ts`, the production `createRuntime()`
wiring) and a real `python -m governor.plan_governance` child process.

Objective: assess whether CHANTER OS can compile one human mission into a
governed, bounded, recoverable agentic execution. Domain: the three CHANTER
repositories, read for metadata only. Context: 3 repository metadata items, 2
approved fixtures (architecture contract, risk register), 1 recorded validation
result.

Observed identities from the final recorded run:

```text
osMissionId       os:governed_agentic_mission:agentic-fabric-mshzo9wh
intentHash        87c48e7c4c67afb5d7ad615ba0a253f105502afb1bac30a9f8379fd80c36cb6d
contextBundleId   ctxb-e3b1724cf38e8daf72a1e1334683dbeb
planId            plan-4e5b5bf94700dc2cdfcb8b80bcbc665c
planHash          4e5b5bf94700dc2cdfcb8b80bcbc665c9d188f96014d492e64a0e3285665650b
candidateHash     e75158f8ed028ba240e56caf69d82ea5edf5256847cbb5ac712163e0d352ecee
artifactHash      e75158f8ed028ba240e56caf69d82ea5edf5256847cbb5ac712163e0d352ecee
authorityRevision 7c6f7347298c00e55123888891404fde954ed13e
```

These digests differ between runs, and that is the contract working rather than
failing: the proof mints a fresh `missionId` per run so each run is genuinely
isolated, and `missionId` participates in `intentHash`, which participates in
`planHash`. What is *stable* is the derivation — within one run, and across the
restart and replay in phase G, every one of these values is byte-identical, which
is what §20 measures. `artifactHash` equals `candidateHash` in every run.

Everything runs against disposable temporary directories. Nothing publishes,
deploys, or writes into a product checkout.

## 15. Parallel execution evidence

Concurrency is **measured from the append-only event journal**, not sampled by a
racing reader — a sampled read can miss an overlap that lasted milliseconds,
whereas the journal's ordering records it permanently.

Observed node lifecycle order:

```text
start:N1  end:N1  start:N2  start:N3  end:N2  end:N3
```

Both specialists became `running` before either completed. Peak concurrency
**2**; `maxParallelism` 2; never exceeded. This holds because leases for the
whole admitted batch are committed *before* any worker starts.

`parallelismObserved: 2` is durable in the value observation.

## 16. Verification and rejected-claim proof

The risk register fixture carries one deliberately unsupported claim
(`risk-unsupported-evidence`) citing `ctx-never-admitted-by-the-context-compiler`.

Observed: verdict `accepted_with_rejections`; 13 accepted claims, 1 rejected with
reason `unsupported_evidence`; the rejected claim absent from `acceptedClaims`,
absent from synthesis's `sourceClaimIds`, and absent from the written artifact
(asserted by string search on the file, and independently by N8's
`rejectedClaimsPresent: []`).

The verifier reaches its verdict by comparison alone — does every cited reference
exist in the admitted set, and does any pair of claims from *different* nodes
assert opposite polarity on one statement. Nothing interprets a claim's meaning:
a verifier whose judgement is itself unverifiable adds no assurance.

**Critical contradiction** was proven separately, on its own Operator process,
its own database, and its own fixture set. Observed: N4 `failed_terminal` with
`AGENTIC_VERIFICATION_FAILED`; N5 and N7 remain `blocked`; mission
`failed_terminal`; `nextPermittedActions: []`; **no artifact on disk**. Synthesis
and the write are made structurally unreachable, not merely discouraged.

## 17. Human authority proof

Two distinct approvals, both refused without the independent control capability
(the submit token and an anonymous caller each received `401`, and no worker ran).

**Before candidate approval**: artifact absent; N7 `blocked`; a `resume` returned
`200` but produced no write and left N7 blocked; `artifact_writes` rows = 0;
`nextPermittedActions` = `["approve", "stop"]`.

**Approval binds**: `missionId`, `missionRevision`, `planId`, node `N6`,
`candidateOutputHash`, repository revision
`7c6f7347298c00e55123888891404fde954ed13e`, approver `founder`, expiry
`2026-08-06T16:43:06.611Z`.

**Mismatched candidate**: approving `"0"×64` returned
`409 AGENTIC_AUTHORITY_CANDIDATE_MISMATCH`; no artifact appeared.

**Changed bytes after approval**: on a dedicated mission, the durable candidate
bytes were replaced after approval. The artifact on disk remained the *approved*
bytes, and the tampered bytes hash to a different digest — which is precisely
what `artifactWriteWorker` re-derives and refuses on. The guard is inside the
write worker, so an approval cannot be carried onto different bytes even if every
layer above it were confused about which candidate was current.

The submit capability cannot approve. There is no test-only bypass.

## 18. Artifact write proof

One atomic temp-write + rename inside an allowlisted directory. Observed:

- `CHANTER_OS_AGENTIC_EXECUTION_FABRIC_READINESS_REPORT_V1.md`, 3 499 bytes;
- all 7 required sections present;
- `operator_agentic_artifact_writes` rows for the mission = **1** — enforced by a
  primary key, not by a counter a caller could forget to increment;
- `artifactHash` equals `approvedCandidateHash` exactly;
- no source file modified; no external publication.

N8 verifies **from the bytes on disk**, not from N7's own report: `artifactExists
true`, `hashMatchesApprovedCandidate true`, `missingSections []`,
`unresolvedEvidenceRefs []`, `rejectedClaimsPresent []`, `writeCount 1`,
`outcomeVerified true`. Only N8 may complete a mission.

## 19. Node recovery and reconciliation proof

The interruption is injected **in-process** at the exact durable boundary — after
the Runtime recorded N3's worker outcome, before Operator committed the node. No
HTTP request can be timed into that window, and a process kill that happened to
hit it would be luck rather than a proof. The **recovery then runs through a real
Operator server process** on the same SQLite file.

Observed immediately after the interruption:

```text
N1 completed   N2 completed   N3 running   N4 blocked   N5-N8 blocked
```

The completed sibling survived. Then, over HTTP against a freshly started
Operator (pid 23516):

1. `POST .../nodes/N3/resume` → **`409 AGENTIC_NODE_RECONCILIATION_REQUIRED`**.
   Both "left running by an interrupted process" and "already marked
   reconciliation_required" are refused identically: refusing only the latter
   would let the more dangerous case through.
2. `POST .../nodes/N3/reconcile` → state `reconciliation_required`, outcome
   **`worker_result_found`**. Worker records **3 → 3**: reconcile only reads.
3. `POST .../nodes/N3/resume` → state `completed`, `attempts` **1**.

**Final worker invocation count for N3: exactly one**, measured per node rather
than mission-wide (the mission-wide total legitimately grows as the resume lets
N4 and N5 run):

```text
n3WorkerInvocationsBeforeInterruptRecovery   1
n3WorkerInvocationsAfterResume               1
reconcileInvokedNoWorker                     true
```

Read from `operator_agentic_worker_records` — the Runtime's own memory of "a
worker ran", the same row the reconcile consulted.

The recovered mission converged: candidate composed, approved, artifact written,
`artifactWriteCount` 1, `outcomeVerified` true, artifact hash equal to its
approved candidate hash, and its own durable value observation carrying
`recoveryEvents: 1` and `duplicateExecutionsPrevented: 1`.

## 20. Restart and replay proof

Operator was killed abruptly (not gracefully) and restarted on a new port (pid
26020). Then the identical submission body was resubmitted:

| Observation | Before | After |
| --- | --- | --- |
| HTTP status | — | `200` with `replayed: true` |
| `planId` | `plan-d3074ee3d40069e99921f6db62d1ec16` | identical |
| `planHash` / `intentHash` | — | identical |
| Worker invocations | 7 | **7** |
| Artifact write rows | 1 | **1** |
| Artifact bytes | 3 499 | byte-identical |
| Journal events | 33 | **33** |

Re-approving a completed mission returned `completed` unchanged. No worker
re-ran, no second artifact was written, and no event was appended.

## 21. Identity table

| Identity | Derivation | Observed (final run) |
| --- | --- | --- |
| `osMissionId` | `os:<lane>:<missionId>` (pure function) | `os:governed_agentic_mission:agentic-fabric-mshzo9wh` |
| `intentHash` | SHA-256 over every compiled field + human text | `87c48e7c…6cb6d` |
| `contextBundleId` | digest of accepted items' content hashes, sorted | `ctxb-e3b1724cf38e8daf72a1e1334683dbeb` |
| `planHash` | digest of intent hash + bundle id + node payload hashes + edges | `4e5b5bf9…65650b` |
| `planId` | `plan-<planHash[0:32]>` | `plan-4e5b5bf94700dc2cdfcb8b80bcbc665c` |
| node `payloadHash` | digest of every bound on the node | one per node, stable |
| node idempotency key | `<missionId>:<planId>:<nodeId>` | 8 per plan |
| `candidateHash` | digest of the rendered candidate bytes | `e75158f8…52ecee` |
| `artifactHash` | same digest, recomputed from disk by N8 | `e75158f8…52ecee` (equal) |
| `authorityRevision` | `git rev-parse HEAD` of the approval-authority repository | `7c6f7347…4ed13e` |

One digest serves both candidate and artifact roles on purpose: a second digest
over the same bytes would only create two numbers that must be kept in agreement.

## 22. Side-effect and worker invocation counters

| Counter | Value | Source |
| --- | --- | --- |
| Worker invocations (main mission) | 7 | `operator_agentic_worker_records` rows with `recorded_at` |
| Worker invocations after replay | 7 | same table, re-read |
| N3 invocations across interruption + recovery | 1 | same table, filtered to N3's idempotency key |
| Worker records across the reconcile | 3 → 3 | same table, before and after |
| Artifact writes | 1 | `operator_agentic_artifact_writes` primary key |
| Artifact writes after replay | 1 | same |
| Tool calls | 7 | summed node `cost.toolCalls` |
| Model calls | 0 | summed node `cost.modelCalls` |
| Human approvals | 2 | execution + candidate |
| Peak concurrency | 2 | replayed from the event journal |
| Journal events | 33 → 33 across restart | `/evidence` |
| External calls | 0 | no network tool exists |

## 23. Value observation

Durable on the mission row and visible through the unified OS read model:

```json
{
  "objectiveSatisfied": true,
  "acceptanceCriteriaPassed": true,
  "acceptedClaimCount": 13,
  "rejectedClaimCount": 1,
  "evidenceCoverage": 5,
  "uncertaintyCount": 1,
  "artifactHash": "e75158f8ed028ba240e56caf69d82ea5edf5256847cbb5ac712163e0d352ecee",
  "artifactWriteCount": 1,
  "workerCount": 7,
  "parallelismObserved": 2,
  "toolCallCount": 7,
  "modelCallCount": 0,
  "tokenCost": null,
  "monetaryCost": null,
  "humanApprovals": 2,
  "recoveryEvents": 0,
  "duplicateExecutionsPrevented": 0
}
```

`tokenCost` and `monetaryCost` are `null` because nothing measured them. An
unmeasured cost is reported as unmeasured; zero would be a claim.
`acceptanceCriteriaPassed` covers only the machine-checkable criteria — the
`human_judgment` criterion is reported as unevaluated rather than quietly passed.

The recovery mission's own durable observation, read back through the OS view:

```json
{
  "objectiveSatisfied": true,
  "artifactWriteCount": 1,
  "workerCount": 7,
  "parallelismObserved": 2,
  "humanApprovals": 2,
  "recoveryEvents": 1,
  "duplicateExecutionsPrevented": 1
}
```

## 24. Negative proofs

| # | Negative proof | Result |
| --- | --- | --- |
| 1 | changed intent under same mission id | `409 AGENTIC_INTENT_CONFLICT` |
| 2 | forbidden capability required by output contract | `409 AGENTIC_INTENT_FORBIDDEN_CAPABILITY_REQUIRED` |
| 2b | capability never granted | `409 AGENTIC_INTENT_CAPABILITY_NOT_ALLOWED` |
| 3 | worker requests an unlisted tool | `denied` / `AGENTIC_NODE_TOOL_NOT_ALLOWED`, tool surface calls **0** |
| 4 | concurrency never exceeds limit | peak 2, limit 2 |
| 5 | verifier rejects unsupported claim | 1 rejected, absent from synthesis and artifact |
| 6 | critical contradiction blocks synthesis and write | mission `failed_terminal`, N5/N7 `blocked`, no artifact |
| 7 | artifact write before approval | N7 `blocked`, 0 write rows, no file |
| 8 | changed candidate after approval | `409 AGENTIC_AUTHORITY_CANDIDATE_MISMATCH`; disk bytes remain approved bytes |
| 9 | ambiguous node resume before reconcile | `409 AGENTIC_NODE_RECONCILIATION_REQUIRED` |
| 10 | node reconcile performs no duplicate worker call | worker record count unchanged |
| 11 | replay performs no worker or write duplication | 7 → 7 invocations, 1 → 1 write, 33 → 33 events |
| 12 | gate failure preserves exact exit code | `test:os-validation`, exit 29 preserved for the terminal stage |
| 13 | budget below minimum executable plan | `409 AGENTIC_INTENT_BUDGET_BELOW_MINIMUM` |
| 14 | ambiguous output contract | `400 AGENTIC_INTENT_OUTPUT_CONTRACT_AMBIGUOUS` |
| 15 | `local_write` mission with no approval policy | `409 AGENTIC_INTENT_AUTHORITY_POLICY_REQUIRED` |
| 16 | lane without a node-level plan | `409 OS_MISSION_LANE_NOT_PLAN_GOVERNED` |
| 17 | approval without control capability | `401` twice, 0 workers |

## 25. Validation results

Every command the brief requires, run against the final tree.

### Operator

| Command | Result |
| --- | --- |
| `npm run typecheck` | PASS (backend + frontend) |
| `npm run typecheck:tools` | PASS |
| `npm run build` | PASS |
| `npm run test:backend` | **956 / 956** (37 files) |
| `npm run test:os-recovery` | PASS |
| `npm run test:os-platform-recovery` | PASS |
| `npm run test:os-ambiguous-reconciliation` | PASS |
| `npm run test:platform-canonical:e2e` | PASS |
| `npm run test:phase2c:mission` | PASS |
| `npm run test:approval-migration:e2e` | PASS |
| `npm run os:assembly` | PASS |
| `npm run os:unified` | PASS (20 / 20 steps) |
| `npm run os:agentic-fabric` | PASS (27 / 27 steps) |
| `npm run test:os-validation` | **19 / 19** |
| `npm run validate:os` | **PASS 12 / 12** |

### Agent Runtime

| Command | Result |
| --- | --- |
| `npm run typecheck` | PASS |
| `npm run build` | PASS |
| `npm test` | **598 / 598** (579 before this P0, +19 agentic node contract tests) |

### Loop Governor

| Command | Result |
| --- | --- |
| `python -m unittest tests.test_plan_governance` | **26 / 26** |
| `python -m unittest discover -s tests` | 1 247 tests, 1 pre-existing environment failure — see §30 |

The Loop Governor's full-suite failure is in `test_operator_ledger_port` and
reproduces at clean HEAD without any change from this P0 (1 221 tests, same
module, same error). That module passes 28 / 28 in isolation both with and
without this change. Recorded rather than hidden; see §30.1.

## 26. Two focused runs

```text
npm run os:agentic-fabric   ->  PASS  (27/27 steps)
npm run os:agentic-fabric   ->  PASS  (27/27 steps)
```

Each run uses isolated durable state under a fresh `mkdtemp` root and removes it
on exit, leaving zero residue.

## 27. Two aggregate runs

```text
npm run validate:os   ->  PASS 12 / 12
npm run validate:os   ->  PASS 12 / 12
```

Stage order (terminal stage last, by measured cost):

```text
 1  typecheck
 2  typecheck:tools
 3  build
 4  test:os-recovery
 5  test:os-platform-recovery
 6  test:os-ambiguous-reconciliation
 7  test:platform-canonical:e2e
 8  test:phase2c:mission
 9  test:approval-migration:e2e
10  os:assembly
11  os:unified
12  os:agentic-fabric          <- new terminal stage
```

## 28. Final git status per repository

```text
chanter-agent-runtime   on runtime/agentic-node-execution-fabric-p0   clean
chanter-loop.governor   on governor/agentic-plan-governance-p0        clean
chanter-Operator        on os/governed-agentic-execution-fabric-p0    clean
```

The only untracked output any run leaves is `var/`, which is already
git-ignored and holds the proof's own JSON report. The proof's mission
artifacts are written to a `mkdtemp` root that is removed on exit, so no run
leaves residue in any repository.

## 29. Commits

Exactly one local commit per changed repository, in the brief's dependency
order. **Not pushed.**

```text
1  chanter-agent-runtime   2267cc9dc8b02458c9461a94f4331fde4e00f7b9
      feat(runtime): execute bounded agentic plan nodes
2  chanter-loop.governor   60cb42a148be77ff0c8e66a62a2fc12019bab5bc
      feat(governor): govern durable agentic plan graphs
3  chanter-Operator        (see below)
      feat(operator): establish governed agentic execution fabric
```

The Operator SHA is deliberately not written here. This document is *inside*
that commit, so any SHA printed in it would be the hash of a different commit —
the one that existed before this sentence was added. Recording a number that is
guaranteed to be wrong would be worse than recording none, and this artifact's
whole contract is that every claim in it was directly observed.

Read the real value with:

```bash
git -C apps/chanter-Operator rev-parse os/governed-agentic-execution-fabric-p0
```

Its parent is `7c6f7347298c00e55123888891404fde954ed13e`, the clean starting
HEAD recorded in §2, and it is the only commit on the branch.

No push, merge, deploy, release, or dependency change was performed in any
repository.

## 30. Residual risks

1. **`test_operator_ledger_port` is environment-flaky in the Loop Governor.**
   Reproduced at clean HEAD *without* any change from this P0 (1 221 tests, 1
   error) and again with it (1 247 tests, 1–3 errors); the module passes 28/28 in
   isolation. It binds local HTTP ports and is unrelated to plan governance.
   Pre-existing and out of scope, but it means the governor's full-suite run is
   not reliably green on this machine.

2. **The governance kernel is invoked per scheduling tick as a subprocess.**
   ~150 ms per tick, ~6 ticks per mission. Correct and cheap at this scale; a
   plan with hundreds of nodes would want a persistent governance process.

3. **A node lease is not automatically reaped.** After a process kill, a node
   stays `running` until a human reconciles it. `reconcileNode` deliberately
   accepts a node whose lease has not lapsed — safe, because reconcile only reads
   and the Runtime's durable claim is the real mutual exclusion — but nothing
   detects the dead holder on its own.

4. **The candidate approval expiry is enforced at the approval boundary, not
   re-checked at write time.** Between approval and write the plan advances
   in-process within milliseconds, so the window is negligible today; a plan that
   parked between N6 and N7 would want the expiry re-evaluated at N7.

5. **`repo.file.read` is registered but not routed by this proof mission.** It is
   contract-complete and reachable as a tool; no node in the canonical eight-node
   plan selects it as a capability.

6. **Specialist claims come from approved fixtures plus live repository
   metadata.** That is genuinely evidence-bound and deterministic, but it means
   the proof exercises the *governance* of specialist work rather than the
   quality of a model's analysis. Routing a `model_worker` is supported by the
   registry and the router; no capability in this plan needs one.

7. **Contradiction detection is a declared polarity convention** (`NOT: ` prefix)
   rather than semantic analysis. Deliberate: real contradiction detection over
   prose needs a model, and a model's opinion is not something a verifier should
   be allowed to fail a mission on. It will not catch a contradiction expressed in
   different words.

## 31. Recommended next P0

**Governed model-worker admission.** Every layer of this fabric is now
model-ready — the registry declares `model_worker` eligibility, the router
prefers it only when nothing cheaper is sufficient, the Runtime counts and bounds
model calls and records measured token and monetary cost — but no capability in
this P0 routes to one, so `tokenCost` and `monetaryCost` are honestly `null`.

The smallest next contract gap is **provider-bound node execution**: a real model
worker behind the existing `AgenticNodeWorker` port, with measured usage flowing
into the value observation, per-node cost enforced against `maxCostMicros`, and a
deterministic fallback when the provider is unavailable. That would make the
Effective Intelligence Density claim measurable rather than structural, and it is
the last place where this fabric's cost story is unmeasured rather than bounded.
