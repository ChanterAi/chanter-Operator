# CHANTER OS — Explicit Reconciliation Authority P0 — Result V1

## 1. Verdict

**PASS.** No deviations.

Ambiguous downstream truth is now a first-class durable recovery state, and the
three control actions are separated authorities:

```text
reconcile   investigates; never dispatches, creates, or spends a retry
resume      executes only what a durable reconciliation already permitted
stop        escalates to a human, and stays available throughout
```

A Platform-lane `resume` issued while the downstream outcome is unknown returns
`409 RECOVERY_RECONCILIATION_REQUIRED` **having performed zero downstream
lookups and zero execution side effects**. The prior P0's documented deviation
is inverted and its pinning test replaced with its opposite.

## 2. Starting and ending HEAD

| | |
|---|---|
| Branch | `os/persisted-approval-authority-consumer-migration-p0` |
| Starting HEAD | `53f56bc3a2a7eaf352efb495960d2932b4d00ce5` — `test(operator): prove ambiguous downstream reconciliation` |
| Ending HEAD | the single commit in §22, whose parent is `53f56bc` |
| Working tree at start | clean |
| Preflight gate | `npm run validate:os` → **PASS 11 / 11** |

Lower-level repositories, clean and **unchanged by this P0**:

| Repository | HEAD | Expected | Match |
|---|---|---|---|
| `apps/chanter-agent-runtime` | `4ab64e50f047f02ac33af7c27ad0812c93a59b6e` | `4ab64e5…` | yes |
| `apps/chanter-loop.governor` | `cc115c21163976b9ec60694840b276070eae308e` | `cc115c2…` | yes |

## 3. Reproduced pre-change deviation

Reproduced at HEAD `53f56bc` before any edit, by the prior P0's own pinning
test (`D1`), which **passed** while asserting exactly the deviation:

```text
ambiguous child state
OS status               = reconciliation_required   (inferred, not durable)
nextPermittedActions    = ["resume", "stop", "reconcile"] → corrected to ["reconcile","stop"] by the prior P0
POST /resume            = 200 completed
recoveryClassification  = RECOVERED_EXISTING_DOWNSTREAM_RESULT  (Reality A)
                        = SAFE_RETRY_COMPLETED                  (Reality B)
draftLookupCalls        = 1   ← the resume performed the investigation itself
```

The read model advertised only `reconcile` and `stop`, while the `resume`
endpoint still investigated and then acted. Safety held; the authority contract
did not.

## 4. Authority ownership analysis

| Concern | Owner before | Owner after |
|---|---|---|
| Is downstream truth known? | inferred by OS from the child's permitted actions | **durable child state** `reconciliation_required` |
| May execution advance? | graph, by auto-reconciling inside resume | **child spine**, via `permittedRecoveryActions` |
| Performing the lookup | resume *or* reconcile | **reconcile only** |
| Refusing the resume | nothing refused it | **child spine** raises it; graph enforces it graph-wide |
| Describing the refusal | — | OS enriches with canonical identity; decides nothing |

No new OS-level recovery authority, no new approval authority, no new durable
store. The OS layer strictly lost responsibility in this change: the inference
it carried after the previous P0 is deleted.

## 5. Durable state decision

The existing canonical `MissionExecutionState` member `reconciliation_required`
is reused. No synonym was added. Two transitions had to be opened for it to be
reachable and resolvable:

```text
downstream_request_prepared  → reconciliation_required   (the ambiguity boundary)
reconciliation_required      → recovery_in_progress      (an explicit reconcile claims it)
```

Observed durable record immediately after an unobserved dispatch, read back
after full service reconstruction:

```text
currentState           = reconciliation_required
lastConfirmedBoundary  = downstream_request_prepared
recoveryClassification = RECOVERY_DOWNSTREAM_UNAVAILABLE
reconciliationOutcome  = not_started
retryCount             = 0
nextPermittedActions   = ["Reconcile", "Stop / escalate"]
```

**Deviation from the brief's §5, retained deliberately:** the brief specifies
`reconciliationOutcome = null`. Repository truth uses the canonical
`MissionReconciliationOutcome` member `not_started` for "no reconciliation has
run yet"; `null` is not a member of that union. `not_started` is asserted
instead, because inventing a null would weaken a total type into a nullable one
for no gain.

Only `unavailable` maps here. An observed typed failure and a commercial denial
were both actually answered by the downstream, so they keep `failed_recoverable`
— ambiguity is specifically *absence of an authoritative answer*, not failure.

## 6. Files changed

| File | Kind | Change |
|---|---|---|
| `apps/backend/src/runtimeMissions/missionExecutionJournal.ts` | production | two transitions opened (§5) |
| `apps/backend/src/runtimeMissions/autoPosterMissionService.ts` | production | unobserved dispatch → `reconciliation_required`; permitted actions for that state; reconcile accepts it; resume refuses from it |
| `apps/backend/src/missions/missionGraphService.ts` | production | refuses resume while any child awaits reconciliation; no longer auto-reconciles a child that already permits resume |
| `apps/backend/src/os/osMissionControlService.ts` | production | removed the now-dead inference; enriches the refusal with canonical identity |
| `apps/backend/src/services/operatorService.ts` | production | `OperatorError.details` (§11) |
| `apps/backend/src/app.ts` | production | serializes `details` onto the error response |
| `apps/backend/tests/runtime-mission-recovery.test.ts` | test | new unobserved-dispatch scenario; conflict now also asserts resume refusal |
| `apps/backend/tests/mission-graph-autoposter.test.ts` | test | multi-node partial failure updated to the explicit two-step contract |
| `tools/os-ambiguous-reconciliation/…integration.test.mts` | test | E1–E6; the prior deviation test inverted |
| `README.md` | docs | authority table and the refusal contract |

No dependency or lockfile changes. No cross-repository changes. No new gate
stage — `test:os-ambiguous-reconciliation` was strengthened in place, so gate
command identity and ordering are unchanged and the gate contract tests needed
no edit.

## 7. Production root cause

One architecture defect, in one place, with two consequences.

**Root cause:** an unobserved downstream outcome had no durable representation.
It was recorded as `failed_recoverable` — the same state as an *observed*
recoverable failure — so nothing downstream of that record could tell the two
apart. Everything else followed:

- the OS had to *infer* ambiguity from the child's permitted-action list
  (introduced by the previous P0 as the narrowest available fix);
- `MissionGraphService.recoverRunningNode` treats `failed_recoverable` as
  "reconcile, then continue if permitted", so a resume necessarily performed
  the investigation itself — it had no way to know it should not.

**Fix:** give the condition its own durable state. Once `reconciliation_required`
is the record, the child spine can refuse resume from it with the exact code,
the graph can refuse the whole resume before touching anything, and the OS
inference becomes dead code and is deleted. The graph's auto-reconcile path
remains for the states it was written for and is additionally stopped from
re-investigating a child that already carries a reconciliation decision.

## 8. Reality A sequence — E1

```text
approve (transport = drop_after_create)
  request reaches AutoPoster        -> scheduleRequestAttempts = 1
  handler creates the draft         -> durableCreateCalls = 1, drafts = 1
  socket destroyed before response  -> scheduleResponsesObserved = 0
  Operator observes 'unavailable'
tear down Operator; reconstruct against the same SQLite + same AutoPoster store
```

```json
{
  "status": "reconciliation_required",
  "laneState": "failed_recoverable",
  "evidenceStatus": "reconciliation_required",
  "nextPermittedActions": ["reconcile", "stop"],
  "recoveryClassification": "RECOVERY_DOWNSTREAM_UNAVAILABLE",
  "lastConfirmedBoundary": "downstream_request_prepared"
}
```

`resume` → `409 RECOVERY_RECONCILIATION_REQUIRED`, every counter unchanged
(`draftLookupCalls` still 0). `reconcile` → one lookup:

```json
{ "outcome": "unique",
  "boundQueueId": "runtime-53cb02ded3f5f6a0130b37c12170deb92e4ac82b",
  "retryCount": 0,
  "repeatedReconcileCode": "RECOVERY_ACTION_NOT_PERMITTED" }
```

`resume` → `completed`, `evidenceStatus: authoritative`, same `jobId`, one draft.

## 9. Reality B sequence — E2

Identical projection after the ambiguity — Operator genuinely cannot tell the
realities apart:

```json
{ "status": "reconciliation_required",
  "nextPermittedActions": ["reconcile", "stop"],
  "recoveryClassification": "RECOVERY_DOWNSTREAM_UNAVAILABLE" }
```

`resume` → `409 RECOVERY_RECONCILIATION_REQUIRED`; `draftLookupCalls` 0,
`retryCount` 0, `drafts` 0. Unknown was not treated as absent even though
absence happened to be the truth.

`reconcile` → proves absence and only then unlocks the retry:

```json
{ "outcome": "not_found",
  "retryCountAfterReconcile": 0,
  "osActionsAfterReconcile": ["reconcile", "resume", "stop"],
  "repeatedReconcileStatus": 200 }
```

`resume` → `completed`, `retryCountFinal: 1`, one draft, nothing published.

## 10. Lookup-unavailable sequence — E3

Run with Reality A underneath: a draft really exists, so treating a failed
lookup as absence would create a second one.

```json
{
  "afterFailedLookup": {
    "status": "reconciliation_required",
    "nextPermittedActions": ["reconcile", "stop"],
    "reconciliationOutcome": "unavailable",
    "retryCount": 0
  },
  "resumeWhileUnknown": { "status": 409, "code": "RECOVERY_RECONCILIATION_REQUIRED" },
  "converged": { "status": "completed", "jobId": "runtime-53cb02ded3f5f6a0130b37c12170deb92e4ac82b" }
}
```

An unreachable lookup is recorded as `unavailable`, never `not_found`. The
child's own typed error is `RECOVERY_DOWNSTREAM_UNAVAILABLE` and the OS projects
that same classification. The refused resume now performs **no lookup of its
own** — one failed lookup, one successful one, and exactly one draft.

## 11. Conflict coverage — E4

The integration harness derives `documentId` deterministically, so two records
for one exact scope cannot be produced there. **Stated limitation:** conflict is
proven at the closest authoritative boundary instead — the child mission spine,
in `apps/backend/tests/runtime-mission-recovery.test.ts`, against a durable port
that can be forced to hold a duplicate:

```text
reconcile           -> reconciliation_required, reconciliationOutcome: conflict
                       recoveryClassification: RECONCILIATION_REQUIRED
nextPermittedActions = ["Stop / escalate"]
resume              -> 409 RECOVERY_RECONCILIATION_REQUIRED
reconcile again     -> 409 RECOVERY_ACTION_NOT_PERMITTED
jobs unchanged (2), scheduleCalls unchanged (1)
```

A conflict is the one `reconciliation_required` no lookup can resolve, so it
offers escalation only — preserved exactly by keying on
`reconciliationOutcome === "conflict"` rather than loosening the state as a
whole.

## 12. Repeated-action behaviour — E5, E6

| Action | Result | Counters moved |
|---|---|---|
| resume during ambiguity × 3 | `409 RECOVERY_RECONCILIATION_REQUIRED` each time | none |
| resume with wrong graph hash | `409 OPERATOR_GRAPH_APPROVAL_HASH_MISMATCH` | none |
| repeated reconcile after `unique` | `409 RECOVERY_ACTION_NOT_PERMITTED` | none |
| repeated reconcile after `not_found` | `200`, `retryCount` still 0 | lookup only |
| resume after completion | `200`, same `jobId` | none |
| reconcile after completion | `409 RECOVERY_ACTION_NOT_PERMITTED` | none |
| stop during ambiguity | `200`, canonical `stopped` | none |
| resume after stop | `409 OPERATOR_GRAPH_STATE_TERMINAL` | none |

`stop` is offered in `nextPermittedActions` throughout ambiguity: escalating to
a human is never gated on knowing what happened downstream.

## 13. Typed error contract

`RECOVERY_RECONCILIATION_REQUIRED` already existed in the repository and is
reused; no duplicate semantic code was created. Observed response verbatim:

```json
{
  "error": "Node autoposter_schedule dispatched a request whose downstream outcome was never observed. Reconcile it explicitly before any resume.",
  "code": "RECOVERY_RECONCILIATION_REQUIRED",
  "details": {
    "osMissionId": "os:platform_autoposter_command:platform-autoposter-f3044396c9dd032610ca833e8c56313e2c983a96",
    "lane": "platform_autoposter_command",
    "currentState": "reconciliation_required",
    "requiredAction": "reconcile"
  }
}
```

Every scenario asserts the whole `details` object with `deepEqual`, and asserts
that the serialized body contains none of the four capability tokens and no
temporary-directory path.

Note: the mission **read model** continues to report
`PLATFORM_COMMAND_EXECUTION_INCOMPLETE` as its `typedError` during ambiguity.
That is a different question with a different answer — the read model says why
the command is not complete; the refusal says what to do next. Both are
asserted.

## 14. Identity preservation

Asserted `deepEqual` across ambiguity → reconstruction → **refused resume** →
reconcile → successful resume → replay → final read:

| Identity | Value (E1 run) |
|---|---|
| `osMissionId` | `os:platform_autoposter_command:platform-autoposter-f3044396…` |
| `commandId` | `platform-autoposter-f3044396c9dd032610ca833e8c56313e2c983a96` |
| `graphId` | `platform-autoposter-f3044396…-graph` |
| `graphHash` | `067dfa633db9bfd8b51a136db05b3e6def4a6df13be84e6bef6d8ba609fa01eb` |
| `payloadHash` | `4f8fc3e4584e03f9931e28efc8202ed19c01938ecd5c2efc1b5a4d918c4b4cdc` |
| `traceId` | `platform-autoposter-f3044396…-trace` |
| `childMissionId` | `graph:platform-autoposter-f3044396…-graph:node:autoposter_schedule` |
| `runtimeExecutionId` | `2df0fc8f-b6fa-4be2-988e-4df9ad0f2608` |
| `campaignId` | `autoposter-campaign:graph:…:node:autoposter_schedule` |
| `approvalId` | `autoposter-approval:graph:…:node:autoposter_schedule` |
| `evidenceBundleId` | `autoposter-evidence:platform-autoposter-f3044396…-graph` |

- **Reality A** — reconciled `jobId` equals the pre-existing durable draft ID
  (`runtime-53cb02ded3f5f6a0130b37c12170deb92e4ac82b`), asserted against the
  boundary's own `posts[0].id`;
- **Reality B** — no `jobId` at any point before the retry; exactly one
  canonical `jobId` after it.

Nothing is re-minted, including across the refused resume.

## 15. Side-effect counters

| Counter | Reality A (E1) | Reality B (E2) | Lookup failure (E3) |
|---|---|---|---|
| schedule request attempts | 1 | 2 | 1 |
| schedule responses observed | 0 | 1 | 0 |
| durable draft creates | 1 | 1 | 1 |
| draft lookup calls | 1 | 2 | 2 |
| draft bindings found | 1 | 0 | 1 |
| **drafts** | **1** | **1** | **1** |
| **provider publish calls** | **0** | **0** | **0** |
| retryCount | 0 | 1 | 0 |

Matching §9 exactly. Lookup counts are now minimal — one per explicit
reconcile, none from resume — where the previous contract spent an extra lookup
inside every resume.

## 16. No-publication proof

`assertNothingPublished` runs at the end of every scenario:
`providerPublishCalls === 0` (zero by construction — no provider adapter exists
in this proof), and **every** durable draft still `approved: false`,
`approvalState: "unapproved"`, `status: "scheduled"`. The downstream identity
reports `publicationApprovalState: "human_required"` throughout, including
across the stop in E6.

## 17. Compatibility proof

| Suite | Result |
|---|---|
| `test:backend` | **925 / 925**, 36 files (924 before; +1 new scenario) |
| `test:os-recovery` | 5 / 5 unchanged |
| `test:os-platform-recovery` | 5 / 5 unchanged |
| `test:platform-canonical:e2e` | PASS (in gate) |
| `test:phase2c:mission` | PASS (in gate) |
| `test:approval-migration:e2e` | PASS (in gate) |
| `os:assembly`, `os:unified` | PASS (in gate) |
| `test:os-validation` | 15 / 15 unchanged |

One existing test changed behaviour and was updated rather than worked around:
`mission-graph-autoposter.test.ts` → "preserves successful drafts across partial
failure". It drives a **multi-node** graph where one node's dispatch returns
`unavailable` — the same ambiguity class, in a graph shape the Platform lane
never produces. It previously resumed straight through because the graph
auto-reconciled. It now requires an explicit reconcile of that child first, and
additionally asserts the resume performs no lookup of its own. The completed
sibling node's draft is preserved untouched across the refusal.

The refusal is deliberately **whole-graph**, not per-node: advancing the healthy
siblings of a node whose downstream reality is unknown is precisely the
speculative act this contract exists to prevent.

## 18. Static, build, and backend results

| Check | Result |
|---|---|
| `npm run typecheck` | PASS (backend + frontend) |
| `npm run typecheck:tools` | PASS |
| `npm run build` | PASS (in gate) |
| `npm run test:backend` | **925 / 925** |
| `npm run test:os-validation` | **15 / 15** |

No `any`. No suppression directives.

## 19. Two focused runs

```text
npm run test:os-ambiguous-reconciliation   → tests 5, pass 5, fail 0, exit 0
npm run test:os-ambiguous-reconciliation   → tests 5, pass 5, fail 0, exit 0
```

E1 Reality A · E2 Reality B · E3 lookup unavailable · E5 repeated/out-of-order
actions · E6 stop during ambiguity. E4 (conflict) is proven at the child-spine
boundary per §11. Every run uses a fresh `mkdtemp` root per scenario, removed in
`after`, and leaves zero repository residue.

## 20. Two aggregate runs

```text
npm run validate:os   → Verdict: PASS, 11 / 11, exit 0
npm run validate:os   → Verdict: PASS, 11 / 11, exit 0
```

Negative fail-fast, re-observed against the real gate:

```text
--- FAIL [6/11] OS ambiguous-downstream reconciliation proof (exit 19)
  SKIP  Canonical Platform command authority proof (not run)
  SKIP  Phase 2C generic mission proof (not run)
  SKIP  Signed approval migration E2E (not run)
  SKIP  OS end-to-end operational assembly (not run)
  SKIP  OS unified mission control plane (not run)
Verdict: FAIL (exit 19)        aggregate process exit = 19
```

## 21. Final git status

```text
 M README.md
 M apps/backend/src/app.ts
 M apps/backend/src/missions/missionGraphService.ts
 M apps/backend/src/os/osMissionControlService.ts
 M apps/backend/src/runtimeMissions/autoPosterMissionService.ts
 M apps/backend/src/runtimeMissions/missionExecutionJournal.ts
 M apps/backend/src/services/operatorService.ts
 M apps/backend/tests/mission-graph-autoposter.test.ts
 M apps/backend/tests/runtime-mission-recovery.test.ts
 M tools/os-ambiguous-reconciliation/os-ambiguous-reconciliation.integration.test.mts
?? CHANTER_OS_EXPLICIT_RECONCILIATION_AUTHORITY_P0_RESULT_V1.md
```

No residue from any proof or gate run.

## 22. Commit

Exactly one local Operator commit, on
`os/persisted-approval-authority-consumer-migration-p0`, including this
artifact:

```text
feat(operator): require explicit downstream reconciliation
  parent: 53f56bc3a2a7eaf352efb495960d2932b4d00ce5
```

A commit cannot contain its own hash, so the SHA is resolvable from the parent:

```bash
git rev-parse os/persisted-approval-authority-consumer-migration-p0
```

**Not pushed.** No merge, deploy, or release.

## 23. Residual risks

1. **The whole-graph refusal is coarse (highest).** One node awaiting
   reconciliation refuses the entire graph resume, including unrelated healthy
   nodes. Conservative and correct for the single-node Platform lane, but a
   large multi-node graph now needs every ambiguous child reconciled before any
   further progress. There is no per-node reconcile through
   `/api/os/missions`; the child-level route is the only way to resolve one.
2. **`execution_started` and `downstream_request_prepared` still auto-reconcile
   on resume.** A process that dies mid-dispatch leaves those states, and the
   graph still investigates inside resume for them. They were out of scope —
   fixing them is a second architecture change — but they are the same
   authority conflation in a narrower window.
3. **Ambiguity is transport-injected, not process-killed.** A real crash between
   the durable create and the response is still not exercised at this boundary.
4. **Conflict is proven one layer down.** The deterministic `documentId` makes a
   real duplicate impossible in the integration harness, so E4 rests on the
   child-spine test rather than the full OS path.
5. **The generic Loop Governor lane is untouched.** It has no authoritative
   downstream lookup, so it cannot represent this state at all; a resume there
   is still governed only by its own permitted-action list.
6. **`details` is a new public error field.** Any consumer that treats error
   bodies as exactly `{error, code}` will now see a third key.

## 24. Recommended next P0

**Per-node reconciliation control for mission graphs** — close risk 1 and 2
together, since both are the same question at node granularity:

- expose reconciliation for one node's child through the OS surface
  (`/api/os/missions/:id/reconcile` currently resolves the Platform lane's
  single child implicitly), so a multi-node graph can be resolved node by node;
- narrow the graph refusal from whole-graph to "the nodes that cannot advance",
  returning the typed refusal while still recovering nodes whose truth is known;
- extend the durable ambiguity state to `execution_started` and
  `downstream_request_prepared` so a process killed mid-dispatch lands in
  `reconciliation_required` rather than being auto-reconciled by a later resume.

The proof surface for it already exists: `mission-graph-autoposter.test.ts`
drives a genuine multi-node graph with a partial ambiguous failure, and this
P0's E-series supplies the refusal and counter assertions to reuse.
