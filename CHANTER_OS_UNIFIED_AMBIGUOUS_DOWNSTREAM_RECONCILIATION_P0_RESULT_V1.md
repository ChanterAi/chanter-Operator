# CHANTER OS — Unified Ambiguous-Downstream Reconciliation P0 — Result V1

## 1. Verdict

**PASS**, with one deliberate, documented deviation from the brief's prescribed
operator gesture (§7 below, and §24).

Both downstream realities are proven end to end through the real Platform
command, the Phase 2D mission graph, the child AutoPoster mission, the real
AutoPoster durable store, the recovery authority, and the unified OS projection:

- an unobserved dispatch that **did** create a draft binds that existing draft
  and creates no second one;
- an unobserved dispatch that **did not** create a draft proves absence and
  spends exactly one safe retry;
- a reconciliation lookup that **itself** fails leaves truth unknown, keeps the
  retry locked, and refuses a resume with a typed 409.

One narrow production defect was found and fixed. It is a projection defect in
`OsMissionControlService`, not a safety defect: the OS plane was flattening
"downstream truth is unknown" into an ordinary recoverable failure and
advertising a `resume` action that the owning child authority withholds.

**Deviation from the brief:** the brief specifies that `resume` be refused with
a typed 409 until a *separate* `reconcile` call has run. This repository does
not work that way and was not changed to. A Platform `resume` reaching a child
in `failed_recoverable` performs the authoritative lookup itself and only then
decides. The safety property the brief is protecting — *retry is forbidden until
downstream truth is reconciled* — holds exactly; what differs is that the lookup
is not a separate operator gesture. This is pinned by tests rather than hidden
(scenario D1) and is the top residual risk in §24.

## 2. Starting and ending HEAD

| | |
|---|---|
| Repository | `apps/chanter-Operator` |
| Branch | `os/persisted-approval-authority-consumer-migration-p0` |
| Starting HEAD | `5c0e66ae13e1409e6cce52fdc27b0607df0f8364` — `test(operator): prove unified platform recovery` |
| Ending HEAD | the single commit in §23, whose parent is `5c0e66a` |
| Working tree at start | clean |

Required history confirmed present at preflight:

```text
5c0e66a test(operator): prove unified platform recovery
0fe89a1 test(operator): prove unified os recovery and reconciliation
872f4b2 feat(operator): establish unified chanter os mission control
```

Lower-level repositories, both clean and **unchanged by this P0**:

| Repository | HEAD | Expected | Match |
|---|---|---|---|
| `apps/chanter-agent-runtime` | `4ab64e50f047f02ac33af7c27ad0812c93a59b6e` | `4ab64e5…` | yes |
| `apps/chanter-loop.governor` | `cc115c21163976b9ec60694840b276070eae308e` | `cc115c2…` | yes |

Preflight gate before any change: `npm run validate:os` → **PASS 10 / 10**.

## 3. Ambiguity injection seam

The interruption is **not** an exception thrown before the adapter call — that
proves only that Operator never dispatched. It is injected at the **AutoPoster
HTTP transport**, in a test-owned express layer mounted in front of the real
`runtimeControlRoutes`:

```text
tools/os-ambiguous-reconciliation/os-ambiguous-reconciliation.integration.test.mts
  → app.use("/api/runtime", ambiguityInterceptor(boundary), runtimeControlRoutes)
```

| Mode | Behaviour | Downstream reality |
|---|---|---|
| `drop_after_create` | routes into the real handler, lets the durable create complete, then destroys the socket instead of flushing the response | draft **exists** |
| `drop_before_create` | counts the arrival, then destroys the socket before any handler runs | draft **absent** |
| `drop` (lookup) | destroys the socket on the reconciliation route | truth **unobtainable** |

No production semantics were altered to achieve this. The seam changes only the
transport, and the AutoPoster application service, its routes, and its storage
adapter all run unmodified.

The three required facts are tracked as independent counters, never conflated:

```text
dispatch attempted            -> scheduleRequestAttempts   (counted at the HTTP boundary, before any decision)
downstream side effect        -> durableCreateCalls / drafts (counted inside the storage adapter)
Operator observation absent   -> scheduleResponsesObserved   (counted only on a flushed response)
```

## 4. Why Operator cannot know the outcome

Operator's AutoPoster port issues **one attempt per call with no automatic
retries** (`autoPosterHttpPort.ts:7` — "a retry could double-create"). When the
socket dies mid-exchange the `fetch` throws, and the port maps that to a single
stable code:

```text
apps/chanter-agent-runtime/src/adapters/autoPosterHttpPort.ts:1255-1258
  catch (error) {
    // Timeout, DNS failure, connection refused — AutoPoster is unreachable.
    return failure('unavailable', `AutoPoster ${reason} (${method} ${path}).`);
  }
```

`unavailable` carries no information about whether the request was processed.
Both injected realities produce byte-identical Operator-side observations; they
differ only in AutoPoster's durable store. That is precisely the condition the
proof requires, and it is why inference is not an option.

The mission spine records this truthfully rather than guessing
(`autoPosterMissionService.ts:1470-1506`): status `unavailable` → durable state
`failed_recoverable`, classification `RECOVERY_DOWNSTREAM_UNAVAILABLE`, with
`reconciliationOutcome` left unset because nothing has been reconciled yet.

## 5. Authoritative lookup contract

| | |
|---|---|
| Operator call | `executor.reconcileSchedule(request)` |
| Transport | `POST /api/runtime/schedule/reconcile` |
| Downstream owner | `reconcileRuntimeSchedule` (`chanter-auto-poster/src/autoposterApplicationService.js:1980`) |
| Store queried | AutoPoster's durable post store, via `storageAdapter.getPosts(userId)` |
| Primary lookup key | `post.runtimeMissionId === metadata.missionId` — the **child mission ID** |
| Source of that key | the child mission's own durable journal; the request is rebuilt from it and its payload hash is re-verified against `execution.missionPayloadHash` before the lookup runs (`autoPosterMissionService.ts:1774-1777`) |

Candidates matched on `runtimeMissionId` must then satisfy **exact equality** on
every one of:

```text
runtimeIdempotencyKey   runtimePayloadHash   runtimeAction
workspaceId             provider             accountId          scheduledAt
```

No fuzzy matching, no timestamp inference, no array-position inference. Outcomes
and how each changes recovery classification:

| Lookup outcome | Durable state | Classification | Retry unlocked |
|---|---|---|---|
| `unique` + `safeToReuse` | `downstream_result_observed`, `downstreamQueueId` bound | `RECOVERED_EXISTING_DOWNSTREAM_RESULT` | no |
| `not_found` | `failed_recoverable`, `reconciliationOutcome=not_found` | `SAFE_RETRY_AVAILABLE` | yes, exactly one |
| transport failure | `failed_recoverable`, `reconciliationOutcome=unavailable` | `RECOVERY_DOWNSTREAM_UNAVAILABLE` | **no** |
| `conflict` | `reconciliation_required` | `RECONCILIATION_REQUIRED` | no, human only |
| `*_mismatch` | `failed_terminal` | `RECOVERY_*_MISMATCH` | no |

## 6. Files changed

| File | Kind | Why |
|---|---|---|
| `tools/os-ambiguous-reconciliation/os-ambiguous-reconciliation.integration.test.mts` | **new** | the proof surface (5 scenarios) |
| `apps/backend/src/os/osMissionControlService.ts` | **production** | the one narrow defect in §7 |
| `tools/validation/osValidation.mts` | gate | new stage at position 6 of 11 |
| `tools/validation/osValidation.test.mts` | gate | ordering, omission, and fail-fast contract |
| `package.json` | gate | `test:os-ambiguous-reconciliation` script |
| `tsconfig.tools.json` | gate | static coverage for the new tool surface |
| `README.md` | docs | runbook + the gate is now eleven stages |

No dependency or lockfile changes. No cross-repository changes: `chanter-agent-runtime`
and `chanter-loop.governor` are byte-identical to their preflight HEADs.

## 7. Production defect found and fixed

**Exactly one**, in the OS projection layer.

### Root cause

`OsMissionControlService` did not represent "the request left, no response came
back, nobody knows whether the side effect happened" as a distinct condition. It
flattened that into an ordinary recoverable failure, and then **minted a
`resume` action of its own** regardless of what the owning authority permitted:

```ts
// osMissionControlService.ts, platformActions (before)
const actions = new Set<OsMissionAction>(["resume", "stop"]);
for (const action of osActionsFrom(childActions)) {
  if (action === "reconcile") actions.add(action);
}
```

`resume` was unconditional; only `reconcile` was ever *read* from the child. The
observed projection during ambiguity was therefore:

```text
status:               failed_recoverable            (should be reconciliation_required)
evidenceStatus:       reconciliation_required       (already correct)
nextPermittedActions: ["resume", "stop", "reconcile"]   (resume must not be offered)
```

This violates §4 ("the unified OS plane remains a router/projector") and §13
("adding OS-owned recovery authority"). The child mission spine was already
correct and needed no change — `permittedRecoveryActions`
(`autoPosterMissionService.ts:356-360`) already withholds `Resume safely` from
`failed_recoverable` unless reconciliation proved absence and no retry has been
spent:

```ts
if (execution.currentState === "failed_recoverable") {
  return execution.reconciliationOutcome === "not_found" && execution.retryCount === 0
    ? ["Reconcile", "Resume safely", "Stop / escalate"]
    : ["Reconcile", "Stop / escalate"];
}
```

### Fix — in the smallest authoritative owner, removing authority rather than adding it

`platformActions` now projects the child's permitted actions verbatim while the
child owns the execution, and `platformStatus` names the condition the child is
already describing:

- `childOwnsExecution(execution)` — true until the child reaches `completed` or
  `failed_terminal`; before a child exists and after it finishes, the command
  and its graph are the only things left to advance, so `resume` remains right;
- `childRequiresReconciliation(execution)` — true when the child offers
  `Reconcile` and withholds `Resume safely`. That *is* the OS
  `reconciliation_required` condition, read from the authority rather than
  decided in the projection.

Net effect: the OS makes strictly fewer decisions than before. `stop` stays
available throughout — escalating to a human is never gated on knowing what
happened downstream.

### The deviation this did *not* change

`missionGraphService.ts:697-712` resumes a `failed_recoverable` child by calling
`reconcileMission` first and acting only on its result. Consequently a Platform
`resume` during ambiguity is **accepted (200)**, not refused (409) as the brief
specifies. This was left alone deliberately:

- it is a second owner, and §11 forbids fixing more than one defect;
- changing it would alter `os-platform-recovery` and `os:unified` semantics;
- it is **not a safety violation**: the retry is locked behind an authoritative
  lookup either way, which A3 proves directly by refusing the resume when the
  lookup cannot succeed.

Scenario D1 pins the behaviour in both realities so it cannot drift silently.

## 8. Reality A — full sequence

Draft exists, response lost. Scenario **A1**.

```text
submit command                         -> 201, graph approval_required
approve (schedule transport = drop_after_create)
  request reaches AutoPoster boundary  -> scheduleRequestAttempts = 1
  handler creates the draft durably    -> durableCreateCalls = 1, drafts = 1
  socket destroyed before response     -> scheduleResponsesObserved = 0
  Operator observes 'unavailable'      -> child failed_recoverable
approve returns 409 PLATFORM_COMMAND_EXECUTION_INCOMPLETE
tear down Operator; reconstruct against the same SQLite + same AutoPoster store
```

Immediately after the ambiguity, read through `/api/os/missions`:

```json
{
  "status": "reconciliation_required",
  "laneState": "failed_recoverable",
  "evidenceStatus": "reconciliation_required",
  "nextPermittedActions": ["reconcile", "stop"],
  "recoveryClassification": "RECOVERY_DOWNSTREAM_UNAVAILABLE",
  "lastConfirmedBoundary": "downstream_request_prepared",
  "typedError": {
    "code": "PLATFORM_COMMAND_EXECUTION_INCOMPLETE",
    "message": "The canonical graph did not complete draft execution (failed_recoverable)."
  }
}
```

`jobId` is `null`: Operator holds no authoritative downstream identity. Reconcile:

```json
{
  "outcome": "unique",
  "boundQueueId": "runtime-53cb02ded3f5f6a0130b37c12170deb92e4ac82b",
  "retryCount": 0,
  "repeatedReconcileCode": "RECOVERY_ACTION_NOT_PERMITTED"
}
```

Exactly one lookup, one binding found, zero creates, zero publishes. Resume then
converges on that same `jobId` with `evidenceStatus: authoritative`, and a
re-read returns identical truth.

## 9. Reality B — full sequence

Draft absent, response lost. Scenario **A2**.

```text
approve (schedule transport = drop_before_create)
  request reaches AutoPoster boundary  -> scheduleRequestAttempts = 1
  socket destroyed before the handler  -> durableCreateCalls = 0, drafts = 0
  Operator observes 'unavailable'      -> child failed_recoverable
tear down Operator; reconstruct against the same SQLite + same AutoPoster store
```

The projection immediately after the ambiguity is **identical to Reality A** —
which is the point; Operator genuinely cannot tell them apart:

```json
{
  "status": "reconciliation_required",
  "laneState": "failed_recoverable",
  "evidenceStatus": "reconciliation_required",
  "nextPermittedActions": ["reconcile", "stop"],
  "recoveryClassification": "RECOVERY_DOWNSTREAM_UNAVAILABLE"
}
```

Reconcile proves absence, and only then is a retry offered:

```json
{
  "outcome": "not_found",
  "retryCountAfterReconcile": 0,
  "osActionsAfterReconcile": ["reconcile", "resume", "stop"],
  "repeatedReconcileStatus": 200
}
```

Resume spends the single retry: `retryCountFinal: 1`, one draft, one durable
create, `evidenceStatus: authoritative`, nothing published.

## 10. Lookup-failure sequence

Scenario **A3**, run with Reality A underneath — a draft really does exist, so
treating a failed lookup as absence would create a second one.

```json
{
  "afterFailedLookup": {
    "status": "reconciliation_required",
    "laneState": "failed_recoverable",
    "evidenceStatus": "reconciliation_required",
    "nextPermittedActions": ["reconcile", "stop"],
    "reconciliationOutcome": "unavailable",
    "retryCount": 0
  },
  "resumeWhileUnknown": { "status": 409, "code": "PLATFORM_COMMAND_EXECUTION_INCOMPLETE" },
  "converged": { "status": "completed", "jobId": "runtime-53cb02ded3f5f6a0130b37c12170deb92e4ac82b" }
}
```

The three things that matter:

- an unreachable lookup is recorded as `unavailable`, **never** as `not_found` —
  timeout is not absence;
- the child's typed error is `RECOVERY_DOWNSTREAM_UNAVAILABLE`, and no retry is
  unlocked (`Resume safely` absent from the child's permitted actions);
- **a resume issued while truth is unknown is refused with a typed 409 and
  creates nothing.** This is the decisive proof that the retry is locked behind
  established truth rather than behind operator discipline.

A later successful reconciliation then converges on the pre-existing draft:
three lookups total, one binding, still exactly one draft.

## 11. Repeated-reconcile idempotency

| Case | Repeat result | Counters that moved |
|---|---|---|
| After `unique` (Reality A) | `409 RECOVERY_ACTION_NOT_PERMITTED` | none at all |
| After `not_found` (Reality B) | `200`, still `not_found`, `retryCount` still `0` | `draftLookupCalls` only |

In both cases the child's full durable record — execution state, reconciliation
outcome, retry count, bound queue id, permitted actions — is asserted
byte-identical across the repeat (`assert.deepEqual(childAfterRepeat,
childAfterReconcile)`). No second safe-retry permission is ever minted.

## 12. Service reconstruction proof

Every scenario runs `dispatchAmbiguouslyThenReconstruct`, which after the
ambiguous dispatch:

1. stops the Operator HTTP server and **closes the SQLite handle**;
2. constructs an entirely new service graph — database, journal, ledger,
   executor, mission services, graph service, platform command service, OS
   control service — against the **same SQLite file** and the **same still-running
   AutoPoster store**;
3. performs every subsequent read, reconcile, and resume through
   `/api/os/missions` on that new graph.

Nothing from the ambiguous attempt survives in memory, so all reconciliation
below is proven to read durable state. The AutoPoster boundary deliberately
outlives every Operator reconstruction, so the draft count is observed
independently of Operator's own state.

These are injected transport failures plus service reconstruction, **not process
kills**. Nothing here claims process-kill durability; `os:unified` proves that
separately, and it is a distinct stage of the same gate.

## 13. Identity preservation

Asserted equal across ambiguity → reconstruction → reconcile → resume → final
read, in both realities (`assert.deepEqual` on the whole set):

| Identity | Value (Reality A run) | Re-minted? |
|---|---|---|
| `osMissionId` | `os:platform_autoposter_command:platform-autoposter-f3044396…` | no |
| `commandId` | `platform-autoposter-f3044396c9dd032610ca833e8c56313e2c983a96` | no |
| `graphId` | `platform-autoposter-f3044396…-graph` | no |
| `graphHash` | `aed9b8ba29957ca67083f10ac28c8ae73cf0df576197b51fdae8b81d4b3c4eac` | no |
| `payloadHash` | `581d3c59d698095c4b195f528843a7f9bea53db4040c647bee3a11a1b340c605` | no |
| `traceId` | `platform-autoposter-f3044396…-trace` | no |
| `childMissionId` | `graph:platform-autoposter-f3044396…-graph:node:autoposter_schedule` | no |
| `runtimeExecutionId` | `df01119c-a1c9-4122-abb9-80faf3d0e880` | exposed |
| `campaignId` | `autoposter-campaign:graph:…:node:autoposter_schedule` | no |
| `approvalId` | `autoposter-approval:graph:…:node:autoposter_schedule` | no |
| `evidenceBundleId` | `autoposter-evidence:platform-autoposter-f3044396…-graph` | no |

`jobId` behaves exactly as required:

- **Reality A** — no `jobId` before reconciliation; after it, the reconciled
  `jobId` equals the already-existing draft ID
  (`runtime-53cb02ded3f5f6a0130b37c12170deb92e4ac82b`), asserted against the
  boundary's own `posts[0].id`;
- **Reality B** — no `jobId` exists at any point before the safe retry; exactly
  one canonical `jobId` appears after it.

Every identity is read from a **named field**, never an array position.

## 14. Side-effect counters

| Counter | Reality A (A1) | Reality B (A2) | Lookup failure (A3) |
|---|---|---|---|
| schedule request attempts | 1 | 2 | 1 |
| schedule responses observed | 0 | 1 | 0 |
| durable draft creates | 1 | 1 | 1 |
| draft lookup calls | 1 | 3 | 3 |
| draft bindings found | 1 | 0 | 1 |
| **drafts** | **1** | **1** | **1** |
| **provider publish calls** | **0** | **0** | **0** |

Matching the brief's §9 expectations exactly (attempts 1 / creates 1 / drafts 1
for Reality A; attempts 2 / creates 1 / drafts 1 for Reality B).

"Adapter called" and "side effect created" are deliberately separate metrics:
Reality B shows `scheduleRequestAttempts = 2` against `durableCreateCalls = 1`,
which is only meaningful because they are counted at different layers.

The lookup counts above the brief's minimum are explained and asserted, not
incidental: the graph re-proves downstream truth against the live store in the
same call that spends the retry, rather than trusting a reconciliation performed
earlier. In Reality B: two explicit reconciles plus the one the resume performs
itself. In A3: one failed, one during the refused resume, one successful.

## 15. Approval and graph-hash proof

- Every execution and every recovery runs under the persisted approval
  authority: `authority.approved === true`, `authorityRevision`
  `c1d10e099a16a9ebfdd571594140d76f9f42d3d7`, `repositoryBinding`
  `7360830ccf0adc086dd7703b826f0bbd4c9b9f8c48ec3574999b24c0f20c4019`.
- Reconciliation refuses to run at all without persisted approval
  (`autoPosterMissionService.ts:1732-1734`) — recovery cannot bypass approval.
- The recovery request is rebuilt from durable state and its payload hash
  re-verified against `execution.missionPayloadHash` before the lookup, failing
  closed with `RECOVERY_SCOPE_MISMATCH` on drift.
- Every `resume` carries the exact `graphHash` bound at submission; the same
  hash is asserted unchanged in the final read. `os-platform-recovery` P5
  separately proves a wrong hash is refused with
  `OPERATOR_GRAPH_APPROVAL_HASH_MISMATCH`, and that stage still passes.
- No new command or graph is ever generated: `commandId` and `graphId` are
  asserted identical from ambiguity through completion.

## 16. No-publication proof

`assertNothingPublished` runs at the end of every scenario and checks two
independent things:

1. `providerPublishCalls === 0` — zero by construction, since no provider
   adapter exists anywhere in this proof;
2. **every** durable draft still carries `approved: false`,
   `approvalState: "unapproved"`, `status: "scheduled"`.

The downstream identity reports `publicationApprovalState: "human_required"`
throughout. Nothing in the ambiguity, the reconciliation, the retry, or the
recovery path ever moves a draft toward publication.

## 17. Typed refusal proof

| Refusal | Code | Effect on counters |
|---|---|---|
| Resume while the lookup cannot establish truth (A3) | `409 PLATFORM_COMMAND_EXECUTION_INCOMPLETE` | none but the lookup |
| Repeat reconcile after `unique` (A1) | `409 RECOVERY_ACTION_NOT_PERMITTED` | none at all |
| Approve whose dispatch was never observed | `409 PLATFORM_COMMAND_EXECUTION_INCOMPLETE` | none |

Every refusal is asserted on its **exact typed code**, never on a bare 409.

## 18. Static, build, and backend results

| Check | Result |
|---|---|
| `npm run typecheck` | PASS (backend + frontend) |
| `npm run typecheck:tools` | PASS |
| `npm run build` | PASS (inside the gate) |
| `npm run test:backend` | **924 passed / 924**, 36 files |
| `npm run test:os-validation` | **15 passed / 15** |
| `npm run test:os-recovery` | 5 / 5 (unchanged by the fix) |
| `npm run test:os-platform-recovery` | 5 / 5 (unchanged by the fix) |

Static coverage of the new tool proven rather than assumed:

```text
npx tsc -p tsconfig.tools.json --listFilesOnly | grep os-ambiguous-reconciliation
→ .../tools/os-ambiguous-reconciliation/os-ambiguous-reconciliation.integration.test.mts
```

No `any`. No suppression directives.

## 19. Two focused runs

```text
npm run test:os-ambiguous-reconciliation   → tests 5, pass 5, fail 0, exit 0
npm run test:os-ambiguous-reconciliation   → tests 5, pass 5, fail 0, exit 0
```

Scenarios: A1 (Reality A), A2 (Reality B), A3 (lookup failure), D1 × 2 (the
pinned deviation, both realities). A4 (repeat idempotency) is asserted inside A1
and A2; A5 (service reconstruction) is structural in all five.

Both runs use isolated durable state — a fresh `mkdtemp` root per scenario,
removed in `after` — and leave zero repository residue.

## 20. Two aggregate gate runs

```text
npm run validate:os   → Verdict: PASS, 11 / 11, exit 0
npm run validate:os   → Verdict: PASS, 11 / 11, exit 0
```

```text
PASS  Repository typecheck (backend + frontend)
PASS  Tools static typecheck
PASS  Production build
PASS  OS unified recovery and reconciliation proof
PASS  OS unified Platform-lane recovery proof
PASS  OS ambiguous-downstream reconciliation proof
PASS  Canonical Platform command authority proof
PASS  Phase 2C generic mission proof
PASS  Signed approval migration E2E
PASS  OS end-to-end operational assembly
PASS  OS unified mission control plane
```

## 21. Negative fail-fast proof

Both proven against the **real** gate by temporarily pointing a stage at a
process with a known exit code, then restoring it.

**(a) The new stage fails → everything after it skips, exact code propagates:**

```text
--- FAIL [6/11] OS ambiguous-downstream reconciliation proof (exit 19)

  PASS  Repository typecheck (backend + frontend)
  PASS  Tools static typecheck
  PASS  Production build
  PASS  OS unified recovery and reconciliation proof
  PASS  OS unified Platform-lane recovery proof
  FAIL  OS ambiguous-downstream reconciliation proof (exit 19)
  SKIP  Canonical Platform command authority proof (not run)
  SKIP  Phase 2C generic mission proof (not run)
  SKIP  Signed approval migration E2E (not run)
  SKIP  OS end-to-end operational assembly (not run)
  SKIP  OS unified mission control plane (not run)

Verdict: FAIL (exit 19)        aggregate process exit = 19
```

**(b) An earlier recovery stage fails → the new stage never starts:**

```text
--- FAIL [5/11] OS unified Platform-lane recovery proof (exit 23)

  FAIL  OS unified Platform-lane recovery proof (exit 23)
  SKIP  OS ambiguous-downstream reconciliation proof (not run)
  …
Verdict: FAIL (exit 23)        aggregate process exit = 23
```

`tools/validation/osValidation.test.mts` additionally proves, against the real
stage list and without running the suites: exact declared ordering; that the
stage appears exactly once (omission fails); that a failure at
`test:os-recovery` or `test:os-platform-recovery` prevents this stage from
starting and reports it as skipped; and that the child exit code is never
collapsed to 1.

## 22. Final git status

```text
 M README.md
 M apps/backend/src/os/osMissionControlService.ts
 M package.json
 M tools/validation/osValidation.mts
 M tools/validation/osValidation.test.mts
 M tsconfig.tools.json
?? tools/os-ambiguous-reconciliation/
```

No residue from any proof or gate run. `chanter-agent-runtime` and
`chanter-loop.governor` remain clean at their preflight HEADs.

## 23. Commit

Exactly one local Operator commit, on
`os/persisted-approval-authority-consumer-migration-p0`, including this
artifact:

```text
test(operator): prove ambiguous downstream reconciliation
  8 files changed, +2323 / -25
  parent: 5c0e66ae13e1409e6cce52fdc27b0607df0f8364
```

A commit cannot contain its own hash, so the SHA is not embedded here. It is
resolvable exactly and unambiguously from the parent recorded above:

```bash
git rev-parse os/persisted-approval-authority-consumer-migration-p0
```

**Not pushed.** No merge, deploy, or release.

## 24. Residual risks

1. **The two-step gesture does not exist (highest).** `resume` during ambiguity
   is accepted, not refused: the graph reconciles inside the resume call
   (`missionGraphService.ts:697-712`). The safety invariant holds — A3 proves
   resume is refused whenever the lookup cannot establish truth — but an
   operator cannot express "investigate only, do not act". `nextPermittedActions`
   is documented as advisory, not an enforcement gate, so the corrected
   projection guides but does not bind.
2. **`reconciliation_required` is now inferred from permitted actions.** It is
   read from the child authority rather than stored as its own durable state.
   That keeps authority where it belongs, but it means a future change to
   `permittedRecoveryActions` silently changes the OS status label. The new
   proof would catch it; nothing else would.
3. **Ambiguity is transport-injected, not process-killed.** A real crash between
   the durable create and the response is not exercised here. `os:unified`
   covers process-kill durability, but not for this specific boundary.
4. **`conflict` is unproven end to end.** Two records for one exact scope maps to
   durable `reconciliation_required` with human-only escalation. That path exists
   and is unit-covered, but this proof cannot reach it — the deterministic
   `documentId` makes a real duplicate impossible at the AutoPoster boundary.
5. **The generic Loop Governor lane is untouched.** Only the Platform AutoPoster
   lane has an authoritative downstream lookup. Whether the generic lane can
   represent an ambiguous outcome at all is unknown.
6. **Single-workspace, single-destination.** Fan-out to multiple destinations
   under ambiguity is not covered.

## 25. Recommended next P0

**Explicit reconciliation gating for the Platform lane** — make ambiguity a
first-class durable state with a real two-step operator gesture:

- promote "downstream outcome unobserved" to its own durable execution state in
  the child spine, so `reconciliation_required` is stored truth rather than
  inferred from permitted actions (risk 2);
- have `MissionGraphService` refuse to resume a child in that state with a typed
  `RECOVERY_RECONCILIATION_REQUIRED` instead of auto-reconciling, closing risk 1
  and bringing the repository onto the brief's prescribed contract;
- keep the auto-reconcile path available as an explicit, separately-named
  operator action so nothing regresses operationally.

That is a single-owner change in `missionGraphService.ts` plus one journal state,
and this proof already contains the exact scenarios that would validate it —
scenario D1 simply inverts from "accepted, converges" to "refused, typed 409".
