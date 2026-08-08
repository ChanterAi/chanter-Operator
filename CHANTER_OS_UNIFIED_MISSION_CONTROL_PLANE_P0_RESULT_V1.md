# CHANTER OS — Unified Mission Control Plane P0 — Result V1

## 1. Verdict

**PASS.**

One canonical CHANTER OS mission control plane now governs both already-proven
execution lanes behind a single identity, authority, state, evidence, and
recovery contract, and both lanes are proven end to end through it against a
real Operator process, a real Loop Governor child process, and a real
AutoPoster runtime boundary.

**Zero cross-repository changes were required.** The unified contract was fully
expressible with the Agent Runtime's and Loop Governor's current exported
types, so both repositories are untouched at their preflight HEADs.

## 2. Starting and ending branches / HEADs

| Repository | Branch | Starting HEAD | Ending HEAD | Changed |
| --- | --- | --- | --- | --- |
| `apps/chanter-Operator` | `os/persisted-approval-authority-consumer-migration-p0` | `2b1847bd817e2d216211abc98c7f447307506b68` | the single commit below | yes |
| `apps/chanter-agent-runtime` | `runtime/durable-mission-value-evidence-p0` | `4ab64e50f047f02ac33af7c27ad0812c93a59b6e` | `4ab64e50f047f02ac33af7c27ad0812c93a59b6e` | **no** |
| `apps/chanter-loop.governor` | `governor/native-task-bound-validation-p0` | `cc115c21163976b9ec60694840b276070eae308e` | `cc115c21163976b9ec60694840b276070eae308e` | **no** |

All three working trees were clean at preflight. Preflight verdicts, all
observed directly before any change:

- `npm run validate:os` — **PASS**, 7/7 stages;
- `npm run test:backend` — **PASS**, 903/903;
- the platform-command authority commit `2b1847b` was present as required.

## 3. Current-state architecture (as found)

Two independently proven lanes, each with its own intake, its own durable
store, and its own control vocabulary.

**Lane 1 — generic governed task**

```
POST /api/runtime-missions   (chanter.mission.v1 envelope, submit capability)
  -> GenericMissionService
  -> operator_missions + operator_mission_executions + operator_mission_journal
  -> LoopGovernorMissionExecutor -> chanter-agent-runtime executeMission
  -> python -m governor.mission_intake -> one manual (agent-frozen) task + loop
control: POST /api/runtime-missions/:missionId/{approve,reconcile,resume,stop}
```

**Lane 2 — Platform AutoPoster command**

```
POST /api/platform/autoposter-commands  (platform command schema, submit capability)
  -> PlatformAutoPosterCommandService
  -> operator_platform_autoposter_commands (immutable command bytes + hash)
  -> operator_mission_graphs (one node, Phase 2D)
  -> MissionGraphChildDispatcher -> AutoPosterMissionService
  -> autoposter_runtime_missions + autoposter_mission_executions
  -> chanter-agent-runtime HTTP adapter -> AutoPoster -> one unapproved draft
control: POST /api/platform/autoposter-commands/:commandId/execute  (graphHash-bound)
```

Shared beneath both: one persisted, signed approval checkpoint authority
(`persistedApprovalAuthority.ts`), one Agent Run Ledger, one Runtime.

## 4. Duplicate authority / state surfaces found

The audit found **no duplicated execution or approval authority** — the two
lanes are genuinely disjoint at the authority level. What it did find was
duplicated *vocabulary* and an absent common surface:

| Surface | Lane 1 | Lane 2 | Finding |
| --- | --- | --- | --- |
| Durable execution state | `operator_mission_executions.current_state` (11 states) | `autoposter_mission_executions.current_state` (**identical** 11 states) | Two declarations of one taxonomy. Already byte-identical, so a truthful common mapping was available with no state redefinition. |
| Lifecycle vocabulary | execution journal only | command lifecycle (6) **+** graph status (7) **+** child execution (11) | Three concurrent state words for one command; a reader had no single answer. |
| Identity | `missionId` (caller-supplied) | `commandId` (derived) + `graphId` + `childMissionId` | Four identifiers, no cross-lane identity. |
| Approval | `approvedBy` + persisted checkpoint | `draftExecutionApprovalState` + graph-hash binding + persisted checkpoint | One authority, two unrelated projections of it. |
| Read model | `GET /api/runtime-missions` | `GET /api/platform/autoposter-commands` | No list contained both lanes. |
| Downstream evidence | `{loopId, taskId}` | `{jobIds, campaignId, approvalId, evidenceBundleId}` + manifest | No common evidence contract. |

**No new competing source of truth was required, and none was created.**

## 5. Unification decision

A deterministic **routing + projection service** over the existing canonical
stores, with **zero new persistence**.

The brief permits "the minimum new persistence required for stable cross-lane
identity correlation". That minimum turned out to be **none**: because a lane's
native identity is already durable and unique within its own store, a
lane-qualified identity `os:<lane>:<lane-native id>` is a pure function of
existing truth. No correlation table, no id registry, no new row.

Consequences, each verified:

- the OS layer owns no table and writes no row;
- it is not a second approval authority — every control action is a strict
  delegation carrying the caller's exact body through unchanged;
- every existing route keeps working, and no caller migration is required;
- missions submitted through legacy lane-specific routes appear in the unified
  read model automatically, because the model projects from their stores.

### One correction made during implementation

The first implementation added an OS-level `assertActionPermitted` gate before
each delegation. The unified proof caught it immediately: it refused the
Platform lane's *idempotent replay* of `approve`, which the lane authority
explicitly supports and which produces no side effect. The guard was a second
authority decision over a question the lane already owned, and it diverged on
first contact. It was removed. `nextPermittedActions` remains in the view as
advisory operator guidance; enforcement stays entirely with the lane authority,
which refuses with its own typed 409 (proven in §13/§14 below).

## 6. Canonical identity contract

`apps/backend/src/os/osMissionContract.ts`

```
osMissionId        os:<lane>:<lane-native id>      derived, never minted
missionRevision    count of durable journal transitions (monotonic)
payloadHash        the immutable digest the lane bound at submission
traceId            lane-native trace identity
product / action   from the graph node, else the reviewed action registry
lane               registered OS lane
workspaceId        generic: workspaceId | platform: tenantId
actorId            lane-native actor
authorityRevision  the exact committed repository HEAD the approval binds to
runtimeExecutionId lane execution attempt id
downstreamIdentity lane-typed discriminated union
```

Rules, all enforced and tested:

- **deterministic** — a pure function of (lane, lane-native id);
- **replay preserves identity** — proven across two Operator restarts;
- **changed payload under a bound identity is a typed conflict** — proven per
  lane (§16);
- lane-specific ids remain available under `laneReference`;
- **no random identity is generated during reads or projections** — there is no
  id-generating code path in the projection at all;
- an id from one lane can never resolve inside another, because the lane is part
  of the identity. Probing lane by lane — the mechanism by which an unknown id
  silently falls through — does not exist here.

## 7. Capability / lane registry

One canonical registry, `OS_MISSION_LANE_SPECS`, cross-checked against the
existing closed-world `missionActionRegistry` **at module load**: a lane naming
an unregistered action, or two lanes claiming one intake schema, fails the
process before it serves traffic. `downstreamOperationType` is *read from* the
action registry, never copied, so the two cannot drift.

| Lane | Intake schema | Approval requirement | Execution scope | Real external | Source of truth |
| --- | --- | --- | --- | --- | --- |
| `generic_governed_task` | `chanter.mission.v1` | `operator_control_approval` | `loop_governor_manual_loop_create_only` | no | `operator_missions` |
| `platform_autoposter_command` | `chanter.platform.autoposter.create-work.v1` | `operator_control_approval_bound_to_graph_hash` | `autoposter_unapproved_draft_only` | yes | `operator_platform_autoposter_commands` |
| `autoposter_direct_mission` | *(none — observed only)* | `operator_control_approval` | `autoposter_unapproved_draft_only` | yes | `autoposter_runtime_missions` |

The third lane exists solely to satisfy §5's requirement that the unified read
model include missions originating through legacy lane-specific routes. It is
not submittable — its (product, action) pair is already owned by a submittable
lane, and two intakes for one identity would be ambiguous — and it excludes any
mission already owned by a Platform command, so one downstream draft never
appears under two OS identities. Proven empty in §15.

Routing derives entirely from this registry. No route handler contains
lane-specific `if/else`.

## 8. Canonical state mapping

One taxonomy, eleven states. Both lanes' durable execution journals already
declared the *same* eleven internal states, so the mapping redefines nothing.

| Lane execution state | OS state | Why |
| --- | --- | --- |
| `approval_required` | `approval_required` | direct |
| `approved` | `approved` | direct |
| `execution_started` | `execution_started` | direct |
| `downstream_request_prepared` | `downstream_request_prepared` | direct |
| `downstream_result_observed` | `downstream_result_observed` | direct |
| `result_persisted` | `downstream_result_observed` | result persisted but the completion boundary is not yet journaled — claiming completion would assert an outcome the record does not carry |
| `completed` | `completed` | direct |
| `recovery_in_progress` | `failed_recoverable` | a bounded recovery is in flight; the honest answer is still "recoverable failure" |
| `failed_recoverable` | `failed_recoverable` | direct |
| `reconciliation_required` | `reconciliation_required` | direct |
| `failed_terminal` | `failed_terminal`, or `stopped` when `recoveryClassification = STOPPED_FOR_ESCALATION` | a human stop is not a system failure |

Graph orchestration states map through the same taxonomy (`running` →
`execution_started`, `cancelled` → `stopped`). The Platform lane derives its OS
state from the deepest authoritative evidence available, in the order truth
accumulates: cancelled graph → command lifecycle → child execution journal →
graph status.

`submitted` is a real state, not a placeholder: it is the Platform lane's
`accepted` lifecycle, where immutable command bytes are durable but no graph
exists yet.

**No state may imply completion without authoritative evidence** — verified by
test: exactly one lane state maps to `completed`, and it is the state that
already required durable downstream evidence to enter.

## 9. Authority mapping

```
required           always true — every registered lane requires human approval
configured         a persisted approval checkpoint authority is wired
trusted            Operator can both sign AND have the signature verified
approved           a persisted, non-rejected approval observation exists
approvedBy         the observation's approver identity
approvalId         the checkpoint's approvalRequestId
authorityRevision  the checkpoint's expectedHead (exact committed revision)
repositoryBinding  the checkpoint's repositoryId
expiresAt          the observation's approvalExpiresAt, or null
refusalCode        typed reason authority is absent/unusable, else null
```

Read through a new **read-only** projection,
`describePersistedApprovalAuthority`, added to the module that already owns
approval authority. It reads durable records and decides nothing: it cannot
publish a checkpoint, mint an observation, or authorize execution.

`approved` is asserted only from a persisted observation — never from a status
string or a boolean flag, because those can be true while the durable authority
behind them is not.

**The unified layer issues no approvals.** It projects and routes authority
operations only.

## 10. Evidence / outcome mapping

```
status                 canonical OS state
evidenceStatus         pending | authoritative | failed | reconciliation_required
evidenceReference      the lane's authoritative evidence artifact reference
valueObservation       the Runtime's value observation, exactly as observed
downstreamIdentity     lane-typed discriminated union
replayOutcome          the Runtime's own idempotency decision
recoveryClassification lane journal classification
lastConfirmedBoundary  mapped through the same taxonomy
nextPermittedActions   advisory (see §5)
typedError             lane typed error
```

- **Governor mission** exposes `{kind: loop_governor_manual_loop, taskId, loopId, created}`.
- **AutoPoster mission** exposes `{kind: autoposter_unapproved_draft, jobIds, campaignId, approvalId, evidenceBundleId, publicationApprovalState: "human_required"}` — the no-publication state is stated, never inferred.

Two deliberate honesty choices:

- `valueObservation` is reported exactly as observed. No adapter in either lane
  currently attaches one, so it is `null` in this proof. It is **not**
  substituted with a computed value.
- A completed Platform command whose retained evidence manifest could not be
  refreshed reports `evidenceStatus: "pending"`, never `authoritative`.

## 11. Exact files changed

**Created (Operator only):**

| File | Purpose |
| --- | --- |
| `apps/backend/src/os/osMissionContract.ts` | canonical contract: states, lanes, identity, total mapping functions |
| `apps/backend/src/os/osMissionControlService.ts` | routing + projection service |
| `apps/backend/tests/os-mission-contract.test.ts` | 21 contract/drift tests |
| `tools/os-unified/run-unified-mission-control.mts` | the unified end-to-end proof |
| `CHANTER_OS_UNIFIED_MISSION_CONTROL_PLANE_P0_RESULT_V1.md` | this artifact |

**Modified (Operator only):** `+484 / −10` across 14 files.

| File | Change |
| --- | --- |
| `apps/backend/src/routes/api.ts` | mount `/os/missions*` and `/os/lanes`; name the new routes in the health capability projection |
| `apps/backend/src/runtimeMissions/persistedApprovalAuthority.ts` | read-only authority projection + `issuerConfigured` |
| `apps/backend/src/runtimeMissions/autoPosterRuntime.ts` | expose `describeApprovalAuthority` |
| `apps/backend/src/missions/loopGovernorRuntime.ts` | expose `describeApprovalAuthority` |
| `apps/backend/src/platform/platformAutoPosterCommandService.ts` | `ownedChildMissionIds()` read, owned by the table's owner |
| `apps/backend/src/runtime.ts` / `app.ts` / `server.ts` | wire the service (appended, never inserted) |
| `apps/backend/tests/runtime-missions.test.ts` | health contract now names the new routes |
| `tools/validation/osValidation.mts` / `.test.mts` | `os:unified` stage + fail-fast contract tests |
| `package.json`, `tsconfig.tools.json`, `README.md` | script, static coverage, documentation |

No `any`, no suppression directives, no dependency or lockfile change, no broad
formatting, no API replaced.

## 12. API surface

| Route | Capability | Delegates to |
| --- | --- | --- |
| `POST /api/os/missions` | submit | lane owning the body's `schemaVersion` |
| `GET /api/os/missions` | read | every lane's canonical store |
| `GET /api/os/missions/:osMissionId` | read | the lane named in the identity |
| `POST /api/os/missions/:osMissionId/approve` | control | lane approval authority |
| `POST /api/os/missions/:osMissionId/reconcile` | control | lane reconciliation |
| `POST /api/os/missions/:osMissionId/resume` | control | lane resume |
| `POST /api/os/missions/:osMissionId/stop` | control | lane stop / graph cancel |
| `GET /api/os/lanes` | read | canonical lane/capability registry |

The preferred shape was adopted rather than evolving `/runtime-missions`,
because that route is already the generic lane's own canonical surface and
overloading it would have coupled the unified contract to one lane's shape.

Capability tiers are identical to the routes they delegate to: the submit
capability can never approve. List filters: `lane`, `product`, `action`,
`status`, `workspaceId`, `approvalState`, `from`, `to`, `limit`, with total
ordering (newest first, then by OS identity).

**Compatibility:** every existing route works unchanged, no caller migration is
required, and legacy-route missions appear in the unified read model — all
three verified in the proof (steps 15, 16, 20).

## 13. Governor lane proof (Scenario A)

Observed by `npm run os:unified`, driven entirely through `/api/os/missions`.

| # | Claim | Observed |
| --- | --- | --- |
| 1 | submit is durable, no side effect | `201`, `os:generic_governed_task:chanter-os-unified-generic-msh85ko1`, Governor tasks after submit `0` |
| 2 | `approval_required`, no authority yet | `status=approval_required`, `authority.approved=false`, `nextPermittedActions=["approve"]` |
| 3 | refused without control authority | submit token `401`, anonymous `401`, Governor tasks still `0` |
| 4 | approval executes into exactly one task + loop | `200`, `status=completed`, `approvedBy=founder`, task `task-b859e728`, loop `fa0c27fb`, task count `1`, loop count `1` |
| 4 | authority binds the exact revision | `authorityRevision=29103a7a9c368185a671c74ca231b99a4deb52b3` (= approval repo HEAD), `repositoryBinding=ebaf2c57…` |
| 4 | real agent execution frozen | `realAgentExecution=false`; the Governor `task.json` carries the exact `[chanter-mission:…]` marker and matching `loop_id` |
| 4 | canonical completed state projected | `evidenceStatus=authoritative`, `replayOutcome=first_execution`, `typedError=null` |

The task and loop were verified by reading the isolated Loop Governor data
directory directly, not by trusting the HTTP response.

## 14. AutoPoster lane proof (Scenario B)

| # | Claim | Observed |
| --- | --- | --- |
| 5 | submit is durable, no draft | `201`, `os:platform_autoposter_command:platform-autoposter-af3445e3…`, graph hash `0e5234a7…`, account validations `1`, schedule calls `0`, drafts `0` |
| 6 | `approval_required` before any draft | `status=approval_required`, `downstreamIdentity=null`, `approvalRequirement=operator_control_approval_bound_to_graph_hash` |
| 7 | refused without control authority **and** without the exact hash | submit token `401`, anonymous `401`, wrong hash `409 OPERATOR_GRAPH_APPROVAL_HASH_MISMATCH`, drafts still `0` |
| 8 | exactly one unapproved draft | `200`, `status=completed`, job `runtime-dfdb64e4…`, schedule contract calls `1`, durable create calls `1`, draft count `1` |
| 8 | **provider publish count `0`** | `providerPublishCalls=0`; no provider adapter is installed, so no publish path exists |
| 8 | publication stays human-gated | `publicationApprovalState=human_required`, stored draft `approved=false`, `approvalState=unapproved`, `status=scheduled`, `privacyLevel=SELF_ONLY` |
| 8 | canonical completed state projected | `evidenceStatus=authoritative`, `evidenceReference=manifest.json`, `evidenceBundleId=autoposter-evidence:…` |

The draft was verified in the real AutoPoster application service's durable
store, reached through the real Agent Runtime HTTP adapter and the real
AutoPoster runtime route.

## 15. Unified observation proof (Scenario C)

| Claim | Observed |
| --- | --- |
| the canonical list returns **exactly** both OS missions | `missionCount=2`, ids exactly the generic and platform identities |
| each has the same top-level contract shape | every entry asserted key-for-key against the canonical top-level, identity, outcome, and authority key sets |
| lane-specific downstream identity present | both entries carry a non-null lane-typed `downstreamIdentity` |
| both have authoritative evidence | both `evidenceStatus=authoritative`, both `authority.approved=true`, both `authorityRevision=29103a7a…` |
| no cross-lane identity collision | `distinctIdentities=2`; the direct-AutoPoster lane returns `[]`, proving the Platform command's child mission is not double-counted |
| no temporary path leakage | serialized response contains the temp root: `false` |
| no real coding agent | `realAgentExecution=false` |
| no publication | `providerPublication=false`, publish calls `0` |
| deterministic filtering | lane/workspace/approvalState filters each return exactly the expected identity; unknown lane → `400 OS_MISSION_FILTER_INVALID` |
| legacy routes still work | `/api/runtime-missions/:id` `200 succeeded`; `/api/platform/autoposter-commands` 1 command; `/api/mission-graphs` 1 graph |

## 16. Restart / replay and conflict proof

Two genuine abrupt process kills (`SIGTERM` to a real child process, not a
graceful shutdown), each followed by a fresh Operator process against the same
durable state. PIDs observed: `26344` → `16672` → `27224`.

| Lane | After restart | Observed |
| --- | --- | --- |
| Governor | resubmit + read | `200`, `replayed=true`, **same** task `task-b859e728` and loop `fa0c27fb`, task count `1`, loop count `1` |
| Governor | changed payload, same identity | `409 OPERATOR_MISSION_PAYLOAD_MISMATCH`; task count still `1`, loop count still `1` |
| AutoPoster | resubmit + re-approve | `200`, `replayed=true`, **same** job `runtime-dfdb64e4…`, same campaign/approval ids; schedule contract calls still `1`, durable creates still `1`, drafts still `1`, publishes still `0` |
| AutoPoster | changed payload, same identity | `409 PLATFORM_COMMAND_PAYLOAD_MISMATCH`; durable creates still `1`, drafts still `1` |

Recovery semantics preserved, and proven rather than asserted: a control action
that cannot advance a mission is refused **by the owning lane authority** with
its own typed error — generic resume/reconcile → `409
RECOVERY_ACTION_NOT_PERMITTED`, platform stop → `409
OPERATOR_GRAPH_STATE_TERMINAL` — with the downstream counts unchanged after
each refusal. The unified plane adds no second gate.

## 17. Test and build results

| Command | Result |
| --- | --- |
| `npm run typecheck` | PASS |
| `npm run typecheck:tools` | PASS (`tools/os-unified` confirmed in the program via `tsc --listFilesOnly`) |
| `npm run build` | PASS |
| `npm run test:backend` | **PASS — 924/924**, 36 files (903 before + 21 new contract tests) |
| `npm run test:platform-canonical:e2e` | PASS |
| `npm run test:phase2c:mission` | PASS |
| `npm run test:approval-migration:e2e` | PASS |
| `npm run test:os-validation` | PASS — 9/9 |
| `npm run os:assembly` | PASS — 8/8 |
| `npm run os:unified` | PASS — 20/20 |

One pre-existing test required an update: `runtime-missions.test.ts` pins the
exact health-endpoint capability route lists, which now truthfully name the new
`/api/os/missions*` routes. No assertion was weakened.

## 18. Two unified proof runs

| Run | Verdict | Steps |
| --- | --- | --- |
| 1 | PASS | 20/20 |
| 2 | PASS | 20/20 |

Each run provisions its own temporary root, its own approval repository, its own
Ed25519 issuer, its own SQLite database, and its own Loop Governor data
directory. `git status --short` after both runs showed only the intended source
changes — **zero repository residue**.

## 19. Two aggregate gate runs

| Run | Verdict | Stages |
| --- | --- | --- |
| 1 | PASS | 8/8 |
| 2 | PASS | 8/8, exit code `0` |

Stage order (cheapest and most diagnostic first):

```
typecheck -> typecheck:tools -> build -> test:platform-canonical:e2e
-> test:phase2c:mission -> test:approval-migration:e2e -> os:assembly -> os:unified
```

`os:unified` is last by cost **and** by diagnostic value: it drives both lanes,
a real Loop Governor child process, and a real AutoPoster boundary, so the
narrower single-lane `os:assembly` is the more useful first signal on failure.

## 20. Negative fail-fast proof

Run live through the existing injectable validation seam, against the **real**
stage list:

| Case | Observed |
| --- | --- |
| `os:unified` fails with child exit `23` | aggregate exit **`23`** (not collapsed to `1`); `os:unified` reported `FAIL`, never `PASS`; no stage reported completed after it |
| an earlier stage (`os:assembly`) fails with `11` | `os:unified` **`SKIP (not run)`**, `started.includes("os:unified") === false`, aggregate exit **`11`** |
| `os:unified` cannot be spawned at all | fails closed, exit `1`, failing stage identified |

**Stated deviation.** §9 asks that a failing unified proof cause "later stages
skip". `os:unified` is the terminal stage under correct cheapest-and-most-
diagnostic-first ordering, so there is no stage after it to skip. Rather than
reorder the gate into a worse order to satisfy the clause literally, the two
observable components of the property are proven instead: skip propagation
*involving* `os:unified` (case 2) and exact child-exit-code preservation *for*
`os:unified` (case 1). All three cases are also permanent in-repo tests in
`tools/validation/osValidation.test.mts`, so removing or reordering the stage
fails the contract.

## 21. Final git status

```
 M README.md
 M apps/backend/src/app.ts
 M apps/backend/src/missions/loopGovernorRuntime.ts
 M apps/backend/src/platform/platformAutoPosterCommandService.ts
 M apps/backend/src/routes/api.ts
 M apps/backend/src/runtime.ts
 M apps/backend/src/runtimeMissions/autoPosterRuntime.ts
 M apps/backend/src/runtimeMissions/persistedApprovalAuthority.ts
 M apps/backend/src/server.ts
 M apps/backend/tests/runtime-missions.test.ts
 M package.json
 M tools/validation/osValidation.mts
 M tools/validation/osValidation.test.mts
 M tsconfig.tools.json
?? apps/backend/src/os/
?? apps/backend/tests/os-mission-contract.test.ts
?? tools/os-unified/
```

`git diff --check` reported no whitespace errors. After the commit the Operator
tree is clean except this artifact. Agent Runtime and Loop Governor remain clean
at their preflight HEADs.

## 22. Commit SHAs

| Repository | Commit | Message |
| --- | --- | --- |
| `apps/chanter-Operator` | repository `HEAD` after this commit | `feat(operator): establish unified chanter os mission control` |
| `apps/chanter-agent-runtime` | — | no change |
| `apps/chanter-loop.governor` | — | no change |

Exactly one local commit, in the only repository that changed. **Not pushed.**

This artifact ships *inside* that commit, so it cannot embed the commit's own
SHA — a commit hash covers its own content, and no value written here could be
correct once written. The commit policy for this slice permits exactly one
commit per changed repository, so no follow-up "record the hash" commit was
made. Read the exact SHA with:

```bash
git -C apps/chanter-Operator rev-parse HEAD
```

It is reported alongside this artifact in the delivery response.

## 23. Residual risks

1. **Per-lane list cap.** The unified list reads at most 100 records per lane
   before merging, matching the bound every lane-specific route already
   enforces. Beyond 100 records in a lane, a mission could be absent from a
   filtered page. No pagination cursor exists yet.
2. **`valueObservation` is structurally present but always `null`.** No adapter
   in either lane attaches a Runtime value observation today. The field is wired
   and reported truthfully; it is not yet populated.
3. **`missionRevision` is comparable only within one OS mission.** It counts
   that mission's own journal transitions, so it detects advancement but is not
   a global sequence.
4. **The Platform lane's `approvedBy` falls back to the command actor.** The
   command row records approval state, not an approver identity; when the
   persisted observation is unavailable the view reports the actor who owned
   the command. The authoritative approver always comes from the observation
   when one exists.
5. **`autoposter_direct_mission` control paths are unexercised end to end.** The
   lane is proven empty and correctly excluded (§15), and its projection is
   unit-tested, but no live mission has been driven through its control actions.
6. **Two proof lanes depend on sibling checkouts.** `os:unified` requires
   `chanter-loop.governor` and `chanter-auto-poster` beside the Operator
   repository, plus an absolute `python`. It fails loudly rather than silently
   when either is absent.

## 24. Recommended next Unified CHANTER OS P0

**Unified CHANTER OS Recovery and Reconciliation Proof P0.**

This slice proved the *happy path* of both lanes plus replay and typed conflict.
It did not drive a real ambiguous downstream outcome through the unified plane.
The next P0 should, using the existing failure-injection seams
(`GenericMissionFailureBoundary`, `MissionGraphFailureBoundary`), prove per lane
that:

1. an interruption at each durable boundary leaves a truthful `failed_recoverable`
   or `reconciliation_required` OS state;
2. `POST /api/os/missions/:id/reconcile` reads exact downstream truth and never
   retries speculatively;
3. `POST /api/os/missions/:id/resume` executes the single permitted safe retry
   and the downstream identity is unchanged;
4. `POST /api/os/missions/:id/stop` produces the canonical `stopped` state;
5. the adapter is provably never called twice across the whole sequence.

That closes the one part of §3.7 this slice asserts through mapping and typed
refusals rather than through a live interrupted execution.
