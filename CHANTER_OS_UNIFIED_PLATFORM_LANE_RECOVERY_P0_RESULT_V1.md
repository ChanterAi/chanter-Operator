# CHANTER OS — Unified Platform-Lane Recovery P0 — Result V1

## 1. Verdict

**PASS.**

A Platform AutoPoster mission interrupted after its child mission created the
draft recovers through the unified CHANTER OS control plane onto the **same**
`jobId`, child mission, graph, and command, with exactly one draft, zero
provider publishes, and the draft still unapproved.

One genuine production defect was found in the unified projection layer and
corrected with a single narrow change (§4, §6).

## 2. Starting and ending HEAD

| Repository | Branch | Start | End | Changed |
| --- | --- | --- | --- | --- |
| `apps/chanter-Operator` | `os/persisted-approval-authority-consumer-migration-p0` | `0fe89a1b60a357814c5b898965d27a772fef6129` | the single commit below | yes |
| `apps/chanter-agent-runtime` | `runtime/durable-mission-value-evidence-p0` | `4ab64e50f047f02ac33af7c27ad0812c93a59b6e` | `4ab64e50f047f02ac33af7c27ad0812c93a59b6e` | **no** |
| `apps/chanter-loop.governor` | `governor/native-task-bound-validation-p0` | `cc115c21163976b9ec60694840b276070eae308e` | `cc115c21163976b9ec60694840b276070eae308e` | **no** |

Preflight, observed before any change: working trees clean, `npm run validate:os`
**PASS 9/9**, `npm run test:backend` **PASS 924/924**.

## 3. Exact native failure boundaries and semantic mapping

All boundary names are repository-native. None were invented.

| # | Semantic point required by the brief | Native boundary | Owning authority |
| --- | --- | --- | --- |
| 1 | after graph approval persisted, before child execution starts | `after_graph_approval_persistence` | `MissionGraphFailureBoundary` |
| 2 | after node running, before the child result is persisted | `after_child_mission_created` | `MissionGraphFailureBoundary` |
| **3** | **after the child created the draft, before node completion is persisted** | **`after_operator_observes_runtime_result_before_persistence`** | **`MissionFailureBoundary`** (AutoPoster child spine) |
| 4 | after node completion, before graph completion is persisted | `after_node_completed_persistence` | `MissionGraphFailureBoundary` |

**Why the mandatory case #3 uses a child-spine boundary.** The graph hands an
entire child execution to the AutoPoster mission spine in one call
(`executeChildMission` → `children.approveAndExecute`), so no *graph*-level
boundary exists between "draft created" and "node completion persisted" — the
graph is inside a single await for that whole window. The child spine's own
boundary sits exactly there: at `autoPosterMissionService.ts:1456` the Runtime
has already observed the real queue draft and the queue id has already been
journaled as `downstream_result_observed`, but the child result, the node
completion, and the graph completion are all still unpersisted.

This was verified from durable state, not assumed. Immediately after the
interruption the proof observes `graphStatus: "running"`, `nodeStatus:
"running"`, `lastConfirmedBoundary: "downstream_result_observed"`, and one real
draft in AutoPoster's store.

Interruptions are thrown as plain `Error`s deliberately: `recordChildDispatchError`
rethrows anything that is not an `OperatorError`, so a plain error propagates
and freezes durable state mid-flight with the node still `running` — a faithful
crash rather than a typed refusal the graph would have tidied up.

## 4. Root cause of the one production defect

**Symptom.** Scenario P1 interrupted after graph approval but before any child
dispatch. Durable truth: the command row recorded `lifecycle_state =
'failed_recoverable'` with `product_state = 'recovery_required'` and an error
code; the graph recorded `status = 'approved'`; no child mission existed. The
unified plane projected **`approved`**.

**Root cause.** `OsMissionControlService.platformStatus` resolved the OS state
by falling through to the deepest available evidence — child execution, else
graph status. That is right when deeper evidence is *more* advanced, but a
Platform command spans three durable authorities, and an interrupted execution
can leave the command recording a failure while the graph or child still
reports how far execution *got*. The fallback therefore answered "how far did
execution reach" when the operator asked "what state is this mission in", and
silently dropped the durably recorded fact that an attempt failed and recovery
was required.

The same root cause had a second manifestation, found by scenario P3: after an
interruption *following* node completion, the child reported `completed` while
the command's linkage and evidence were unfinished, so the mission would have
projected as **`completed`** when it was not.

**Correction (smallest that fixes both).** Deeper evidence may only ever
*deepen* the answer. When the command lifecycle durably records
`failed_recoverable`, the OS state stays `failed_recoverable` unless deeper
evidence reports something strictly more severe (`reconciliation_required`,
`failed_terminal`, `stopped`). A cancelled graph is still checked first, so
human-stop truth continues to win outright.

No lane authority semantics were altered. Exactly one defect was found.

## 5. Files changed

**Created**

| File | Purpose |
| --- | --- |
| `tools/os-platform-recovery/os-platform-recovery.integration.test.mts` | the 5-scenario proof |
| `CHANTER_OS_UNIFIED_PLATFORM_LANE_RECOVERY_P0_RESULT_V1.md` | this artifact |

**Modified**

| File | Change |
| --- | --- |
| `apps/backend/src/os/osMissionControlService.ts` | **the one production fix** (§4) |
| `tools/validation/osValidation.mts` | `test:os-platform-recovery` as gate stage 5 |
| `tools/validation/osValidation.test.mts` | ordering + fail-fast contract for the new stage |
| `package.json`, `tsconfig.tools.json`, `README.md` | script, static coverage, documentation |

**Production source changed: yes — one file, one narrow behavioural fix**, under
the allowance in the brief's §11.

## 6. Scenario results (5/5 PASS)

### P1 — interrupted before child dispatch

| Claim | Observed |
| --- | --- |
| nothing dispatched | `scheduleContractCalls=0`, `durableCreateCalls=0`, `drafts=0`, `providerPublishCalls=0` |
| OS state truthful | `failed_recoverable` (**was `approved` before the fix**) |
| evidence | `reconciliation_required` |
| no downstream identity yet | `jobId = null` |
| graph truth preserved | graph `approved` — approval persisted, no node ran |
| recovery completes | resume → `completed`, one draft created |
| final counts | `1 / 1 / 1 / 0` |
| draft unapproved | `approved=false`, `approvalState=unapproved` |

### P2 — CORE: draft created, graph completion never persisted

Directly observed, one representative run:

**Immediately after interruption**

```json
{ "status": "failed_recoverable", "laneState": "failed_recoverable",
  "evidenceStatus": "reconciliation_required",
  "graphStatus": "running", "nodeStatus": "running",
  "nextPermittedActions": ["resume", "stop"],
  "lastConfirmedBoundary": "downstream_result_observed" }
```

with `scheduleContractCalls=1, durableCreateCalls=1, drafts=1, providerPublishCalls=0`.

The graph is **not** falsely completed; the child mission exists; the draft
exists; nothing was published.

**Reconcile** returned `409` and produced **zero** side effects. That refusal is
correct and is itself the finding: Operator already holds the exact observed
downstream result (`lastConfirmedBoundary: downstream_result_observed`), so
re-reading downstream truth could only weaken evidence it already has. The
child authority owns that decision; the OS layer adds no second gate. Identity
was unchanged across the call and the permitted next action was classified
(`["resume", "stop"]`).

**After resume**

```json
{ "status": "completed", "laneState": "completed",
  "evidenceStatus": "authoritative", "evidenceReference": "manifest.json",
  "graphStatus": "completed", "nodeStatus": "completed",
  "nextPermittedActions": [] }
```

with side-effect counts **identical** to before recovery, and
`draftApprovalState: "unapproved"`.

### P3 — node completed, graph completion interrupted

Child result and draft already authoritative (`1 / 1 / 1 / 0`). Interrupted OS
state `failed_recoverable` (**would have been `completed` before the fix**),
with `nodeStatus: completed` and graph not completed. Resume finalized graph
state: same `jobId`, same `childMissionId` (never re-minted), counts unchanged,
graph and node both `completed`.

### P4 — stop from a recoverable Platform state

`status=stopped`, `nextPermittedActions=[]`, draft count unchanged, publishes
`0`, a fresh read still `stopped`, and a subsequent resume refused `409` with a
typed lane-owned code — after which counts and state were re-verified unchanged.

### P5 — redundant and invalid recovery actions

| Action on a completed mission | Result | Side effects |
| --- | --- | --- |
| reconcile (authoritative result already held) | `409 RECOVERY_ACTION_NOT_PERMITTED` | unchanged |
| stop after terminal completion | `409 OPERATOR_GRAPH_STATE_TERMINAL` | unchanged |
| resume after completion | `200`, idempotent replay, same `jobId` | unchanged |
| resume with wrong graph hash | `409 OPERATOR_GRAPH_APPROVAL_HASH_MISMATCH` | unchanged |
| read an unknown Platform identity | `404`, no lane fall-through | — |

## 7. Identity preservation

Every value below was read from a **named field**, never an array position, and
asserted equal before and after recovery in P2.

| Identity | Preserved across interruption → reconcile → resume → re-read |
| --- | --- |
| `osMissionId` | `os:platform_autoposter_command:platform-autoposter-e8fc9bce…` |
| `commandId` | `platform-autoposter-e8fc9bce565036447b388a184a71c32a6d90b6e0` |
| `graphId` | `…-e8fc9bce…-graph` |
| `graphHash` | `2d179844e4ef86d5260d22f3fbda2754246f7c044d9a35d4654f71350a134c2f` |
| `childMissionId` | `graph:…-graph:node:autoposter_schedule` |
| `runtimeExecutionId` | `242bffa8-bfcc-4e38-9907-2ad63f1dbfde` |
| `jobId` | `runtime-c20c9064eda6887cc8212a8799e07a09d9c7d7ff` |
| `campaignId` | `autoposter-campaign:graph:…:node:autoposter_schedule` |
| `approvalId` | `autoposter-approval:graph:…:node:autoposter_schedule` |
| `evidenceBundleId` | `autoposter-evidence:…-graph` |

## 8. Exactly-once side-effect table

| Stage of P2 | schedule | durableCreate | drafts | providerPublish |
| --- | --- | --- | --- | --- |
| after interruption | 1 | 1 | 1 | 0 |
| after service reconstruction | 1 | 1 | 1 | 0 |
| after reconcile | 1 | 1 | 1 | 0 |
| after resume | 1 | 1 | 1 | 0 |
| after repeated read | 1 | 1 | 1 | 0 |
| after replay / invalid actions (P5) | 1 | 1 | 1 | 0 |

## 9. Authority and graph-hash proof

Draft execution is authorized only by the control capability carrying the exact
graph hash. P5 proves a resume with `graphHash = "0"×64` is refused with
`409 OPERATOR_GRAPH_APPROVAL_HASH_MISMATCH` before anything runs, with counts
unchanged. Persisted approval authority is unchanged and was never bypassed:
the approval-authority fixture is keyed by database path, so the reconstructed
services reuse the same durable checkpoints and observations.

## 10. No-publication proof

`providerPublishCalls` is `0` at every stage of every scenario. No provider
adapter is installed in this proof, so no publish path exists to call — and the
durable product record independently confirms it: the draft stays
`approved=false`, `approvalState="unapproved"`, `status="scheduled"` through
interruption, reconcile, resume, and replay. Recovery never converted
recoverability into publication authority.

## 11. Service reconstruction / durability proof

After **every** interruption the proof calls `operator.stop()` — closing the
Express server and the SQLite handle — and then constructs an entirely new
service graph against the same database file with **no injectors armed**. Every
assertion afterwards is served by services that never saw the interrupted
execution, so recovery is proven to read durable state rather than process
memory.

Terminology, stated precisely per the brief's §10:

- **exception interruption** — used here (injected `Error` at a durable boundary);
- **service reconstruction** — used here (new services, same SQLite file);
- **process restart** — **not** used here. No process is killed in this proof, so
  no process-kill durability is claimed. That property is proven separately by
  `os:unified`, which kills and restarts a real Operator child process.

## 12. Validation results

| Command | Result |
| --- | --- |
| `npm run typecheck` | PASS |
| `npm run typecheck:tools` | PASS (`tools/os-platform-recovery` covered) |
| `npm run build` | PASS |
| `npm run test:backend` | **PASS — 924/924** |
| `npm run test:os-recovery` | PASS — 5/5 |
| `npm run test:os-platform-recovery` | **PASS — 5/5** |
| `npm run test:platform-canonical:e2e` | PASS |
| `npm run test:phase2c:mission` | PASS |
| `npm run test:approval-migration:e2e` | PASS |
| `npm run os:assembly` | PASS |
| `npm run os:unified` | PASS — 20/20 |
| `npm run test:os-validation` | **PASS — 12/12** |

### Two focused proof runs

| Run | Result |
| --- | --- |
| 1 | PASS — 5/5 |
| 2 | PASS — 5/5 |

Each scenario provisions its own temporary root, database, and evidence
directory. `git status --short` after both runs showed only the intended source
changes — zero repository residue.

### Two aggregate gate runs

| Run | Result |
| --- | --- |
| 1 | **PASS — 10/10** |
| 2 | **PASS — 10/10**, exit `0` |

Stage order:

```
typecheck -> typecheck:tools -> build -> test:os-recovery
-> test:os-platform-recovery -> test:platform-canonical:e2e
-> test:phase2c:mission -> test:approval-migration:e2e -> os:assembly -> os:unified
```

## 13. Negative fail-fast proof

Run live against the **real** stage list through the injectable validation
runner:

| Case | Observed |
| --- | --- |
| `test:os-platform-recovery` exits `17` | aggregate exit **`17`**; all **5** later stages reported `SKIP (not run)` |
| `test:os-recovery` fails earlier (exit `9`) | aggregate exit **`9`**; `test:os-platform-recovery` **never started** (`started.includes(...) === false`) |

Both properties are also permanent in-repo contract tests, so omitting or
reordering the stage fails `npm run test:os-validation`.

## 14. Final git status

```
 M README.md
 M apps/backend/src/os/osMissionControlService.ts
 M package.json
 M tools/validation/osValidation.mts
 M tools/validation/osValidation.test.mts
 M tsconfig.tools.json
?? tools/os-platform-recovery/
?? CHANTER_OS_UNIFIED_PLATFORM_LANE_RECOVERY_P0_RESULT_V1.md
```

`git diff --check` reported no whitespace errors. Agent Runtime and Loop
Governor remained clean at their preflight HEADs throughout.

## 15. Commit

One local Operator commit, `test(operator): prove unified platform recovery`,
including this artifact. **Not pushed.**

As with the previous slices, the artifact ships inside the commit and so cannot
embed that commit's own SHA. Read it with:

```bash
git -C apps/chanter-Operator rev-parse HEAD
```

## 16. Residual risks

1. **Boundary #2 is covered by the harness but not by a dedicated scenario.**
   `after_child_mission_created` is wired and reachable; the five scenarios
   cover boundaries 1, 3 and 4 plus stop and invalid-action paths. A dedicated
   scenario for #2 would add a second "before dispatch" case whose durable
   state is nearly identical to P1's.
2. **Exception interruption, not process kill** (§11). Deliberate: exact
   boundary targeting requires in-process injection.
3. **Reconcile on the Platform lane is a refusal in the core scenario.** From
   `downstream_result_observed` the child authority permits only resume, so the
   proof demonstrates reconcile is side-effect-free rather than demonstrating a
   reconciling lookup. A Platform scenario that reaches a state where child
   reconciliation *is* permitted (e.g. an interrupted dispatch with an unknown
   downstream outcome) would exercise that path directly.
4. **Single-node graphs only.** The Platform lane compiles exactly one node
   today, so multi-node dependency recovery is untested by construction.
5. **`autoposter_direct_mission` control paths remain unexercised** end to end,
   unchanged from the previous slices.

## 17. Recommended next Unified CHANTER OS P0

**Unified CHANTER OS Ambiguous-Downstream Reconciliation P0.** Every recovery
proven so far resolves an interruption where the downstream outcome is
*knowable* — the draft either exists or provably does not. The untested and
highest-risk case is the genuinely ambiguous one: the AutoPoster schedule call
times out or the connection drops after the request left Operator but before
any response, so Operator cannot know whether a draft exists. That is the exact
situation the governing principle addresses. The next P0 should force that
state on the Platform lane, prove the OS projects `reconciliation_required`
rather than any state implying an outcome, prove `resume` is refused until
`reconcile` performs an authoritative downstream lookup, and prove that both
possible downstream realities — draft present and draft absent — converge on
exactly one draft.
