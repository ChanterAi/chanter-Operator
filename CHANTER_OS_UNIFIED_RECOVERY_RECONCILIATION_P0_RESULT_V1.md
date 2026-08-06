# CHANTER OS — Unified Recovery and Reconciliation Proof P0 — Result V1

## 1. Verdict

**PASS.**

The recovery half of the unified CHANTER OS contract is now proven against
genuinely interrupted executions driven through the unified plane, rather than
inferred from a pure-function mapping.

## 2. Why this slice existed

`CHANTER_OS_UNIFIED_MISSION_CONTROL_PLANE_P0_RESULT_V1.md` closed the unified
control plane and proved both lanes' happy paths, restart replay, and typed
conflict. It named one residual gap, which this slice closes:

> §3.7 recovery semantics were asserted through *mapping and typed refusals*,
> not through a live interrupted execution.

Concretely, the OS states that only exist mid-recovery —
`downstream_request_prepared`, `downstream_result_observed`,
`failed_recoverable`, `stopped` — were verified only as a pure function over
synthetic inputs. No test had ever produced one of them from real durable state
and read it back through `/api/os/missions`.

**Scope discipline.** Lane-level recovery is already owned by
`apps/backend/tests/runtime-mission-recovery.test.ts` (739 lines, per-boundary
AutoPoster recovery, restart, bounded safe retry, conflicting downstream truth)
and by the generic mission spine suite. This slice deliberately does **not**
re-prove any of that. Its claim is narrower and additive: that the unified
projection tells the truth about interrupted missions, that OS control actions
delegate correctly, and that no OS-driven recovery produces a duplicate
downstream artifact.

## 3. Starting and ending state

| Repository | Branch | Start | End | Changed |
| --- | --- | --- | --- | --- |
| `apps/chanter-Operator` | `os/persisted-approval-authority-consumer-migration-p0` | `872f4b2` | the single commit below | yes |
| `apps/chanter-agent-runtime` | `runtime/durable-mission-value-evidence-p0` | `4ab64e5` | `4ab64e5` | **no** |
| `apps/chanter-loop.governor` | `governor/native-task-bound-validation-p0` | `cc115c2` | `cc115c2` | **no** |

**No production source file changed in this slice.** The proof uses only
seams that already existed (`GenericMissionService.failureInjector`) and the
unified surface committed in `872f4b2`.

## 4. What was built

| File | Purpose |
| --- | --- |
| `tools/os-recovery/os-recovery.integration.test.mts` | the recovery proof (5 scenarios) |
| `tools/validation/osValidation.mts` | `test:os-recovery` added as gate stage 4 |
| `tools/validation/osValidation.test.mts` | ordering + fail-fast contract for the new stage |
| `package.json`, `tsconfig.tools.json`, `README.md` | script, static coverage, documentation |

The proof runs fully in process against disposable state — no server process,
no Loop Governor subprocess, no network — in roughly eleven seconds. Every
scenario interrupts a *real* execution at a *real* durable boundary and then
drives the entire recovery over real HTTP through
`/api/os/missions/:osMissionId/{reconcile,resume,stop}`, asserting the
projected OS state **and** the downstream side-effect count at every step.

Downstream side effects are counted by a Loop Governor port that records every
create call and every lookup separately from the set of durable bindings that
actually exist, so "created nothing" and "called nothing" are distinguishable
claims rather than one blurred assertion.

## 5. Scenario results (5/5 PASS)

### R1 — result observed, not yet journaled

Interrupted at `after_operator_observes_runtime_result_before_persistence`.

| Claim | Observed |
| --- | --- |
| the downstream loop genuinely exists | create calls `1`, bindings `1` |
| OS never claims completion without the journaled boundary | `status=downstream_result_observed`, **not** `completed` |
| evidence is not yet authoritative | `evidenceStatus=pending` |
| only resume is advised | `nextPermittedActions=["resume"]` |
| resume completes on the same identity | `status=completed`, `loopId=loop-1`, `taskId=task-1` |
| recovery replayed from Operator's own journal | create calls still `1` — resume re-dispatched nothing |

### R2 — interrupted before dispatch; reconcile, then one safe retry

Interrupted at `after_downstream_request_preparation_persistence`.

| Claim | Observed |
| --- | --- |
| nothing was dispatched | create calls `0` |
| OS state is truthful | `status=downstream_request_prepared` |
| **retry is locked before reconciliation** | actions `["reconcile","stop"]`; `resume` absent |
| reconciliation reads downstream truth exactly once | lookup calls `1` |
| reconciliation creates nothing | create calls still `0` |
| a proven-absent binding unlocks one retry | `status=failed_recoverable`, `recoveryClassification=SAFE_RETRY_AVAILABLE`, `resume` now offered |
| the retry dispatches exactly once | create calls `1`, bindings `1` |
| exactly one downstream artifact exists | bindings `1`, `loopId=loop-1` |

This is the core §3.7 property — *reconciliation before retry after an
ambiguous downstream outcome, with no speculative duplicate execution* —
measured end to end rather than asserted.

### R3 — redundant reconciliation is refused

From `downstream_result_observed`, `reconcile` returns `409
RECOVERY_ACTION_NOT_PERMITTED` and performs **zero** downstream reads (lookup
calls `0`). The refusal is correct: Operator already holds the exact observed
result, so re-reading downstream truth could only weaken evidence it has. The
permitted path, `resume`, lands on the same `loop-1` with no second binding.

### R4 — a human stop is not a system failure

| Claim | Observed |
| --- | --- |
| canonical stopped state | `status=stopped` |
| the lane's own state is preserved verbatim | `laneState=failed_terminal` |
| classification is durable | `recoveryClassification=STOPPED_FOR_ESCALATION` |
| nothing advances further | `nextPermittedActions=[]` |
| stopping dispatches nothing | create calls `0` |
| the stop is durable | a fresh read re-projects `stopped` |

This is the first time the `failed_terminal` → `stopped` split has been proven
against real durable truth rather than a synthetic classification string.

### R5 — a downstream refusal stays recoverable and still gated

| Claim | Observed |
| --- | --- |
| an unproven outcome is recoverable, never terminal | `status=failed_recoverable` |
| evidence names the required action | `evidenceStatus=reconciliation_required`, typed error surfaced |
| retry stays locked | actions `["reconcile","stop"]` |
| the refusal created nothing | create calls `1`, bindings `0` |
| reconciliation unlocks exactly one retry | `resume` offered, bindings still `0` |
| the whole recovery leaves one artifact | bindings `1`, create calls `2` (one refused dispatch + one permitted retry) |

## 6. Gate integration

`test:os-recovery` is **stage 4 of 9**, immediately after `build` and ahead of
every cross-repository proof:

```
typecheck -> typecheck:tools -> build -> test:os-recovery
-> test:platform-canonical:e2e -> test:phase2c:mission
-> test:approval-migration:e2e -> os:assembly -> os:unified
```

This strengthens the gate's cheapest-and-most-diagnostic-first ordering: it is
the only proof needing no server, subprocess, or network, so a broken recovery
contract now surfaces in seconds instead of after several minutes of
cross-repository work.

Two new contract tests keep the ordering honest — one asserts the recovery
stage precedes every cross-repository proof and follows the build, the other
asserts that a failing recovery stage skips all five later stages and
propagates its exact child exit code.

## 7. Validation results

| Command | Result |
| --- | --- |
| `npm run typecheck` | PASS |
| `npm run typecheck:tools` | PASS (`tools/os-recovery` covered) |
| `npm run build` | PASS |
| `npm run test:os-recovery` | **PASS — 5/5**, ~11s |
| `npm run test:os-validation` | **PASS — 11/11** |
| `npm run test:backend` | **PASS — 924/924** |
| `npm run validate:os` (run 1) | **PASS — 9/9** |
| `npm run validate:os` (run 2) | **PASS — 9/9**, exit `0` |

## 8. Residual risks

1. **Generic lane only.** All five scenarios interrupt the generic governed-task
   spine, whose failure-injection seam is the richest. The Platform lane's
   graph-level boundaries (`MissionGraphFailureBoundary`) are not exercised
   through the OS plane; its recovery remains covered at the lane level by the
   existing AutoPoster recovery suite.
2. **In-process, not cross-process.** These interruptions are injected
   exceptions, not process kills. Genuine kill/restart durability is proven
   separately by `os:unified` and `os:assembly`; this proof deliberately trades
   that for the ability to stop at an exact durable boundary.
3. **The `autoposter_direct_mission` lane's control paths remain unexercised**
   end to end, unchanged from the previous slice.

## 9. Recommended next P0

**Unified CHANTER OS Platform-Lane Recovery Proof P0** — extend this proof's
shape to the Platform lane using `MissionGraphFailureBoundary`, covering
interruption after graph approval, after a node starts running, after the child
mission is created, and after node completion. The one property worth proving
that this slice could not: that a graph interrupted *after* its child AutoPoster
mission created a draft, then resumed through `/api/os/missions/:id/resume`,
converges on the same `jobId` with the draft count still exactly one.
