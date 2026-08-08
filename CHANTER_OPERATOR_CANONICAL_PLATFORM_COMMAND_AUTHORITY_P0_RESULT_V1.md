# CHANTER Operator — Canonical Platform Command Authority P0 — Result V1

**Verdict: PASS**

The canonical platform command path is proven end to end and is now an enforced
stage of `npm run validate:os`:

> Platform command intake → exact command identity/payload binding → persisted
> human authority → Agent Runtime execution → AutoPoster draft creation →
> durable observation/evidence → stable replay without duplication → typed
> refusal on conflicting payload → no publication.

---

## 1. Repository state

| | Branch | HEAD |
| --- | --- | --- |
| Starting | `os/persisted-approval-authority-consumer-migration-p0` | `2a0da5e52447a404169b058f9e1c85e977face64` |
| Ending | `os/persisted-approval-authority-consumer-migration-p0` | this commit |

Preflight matched the brief exactly: expected branch, expected HEAD, clean tree,
both prior P0 commits present (`a9dc684`, `1f6fdff`). `validate:os` passed
before any modification, and the known `409` reproduced exactly.

---

## 2. Observed failure — the exact `409`

Captured by temporary instrumentation of the proof (added, read, reverted with
`git checkout --`; tree verified clean afterwards). **The expected status code
was never changed.**

```json
{
  "error": "The canonical graph did not complete draft execution (failed_recoverable).",
  "code": "PLATFORM_COMMAND_EXECUTION_INCOMPLETE"
}
```

HTTP `409` from
`POST /api/platform/autoposter-commands/{commandId}/execute`, asserted at
`tools/platform-canonical/platform-canonical.integration.test.mts:704`.

That code is a *symptom*, so the durable state was read directly rather than
patched. `operator_mission_graph_nodes.typed_error_json` and
`autoposter_runtime_missions.runtime_result_json` both carried the real cause:

```json
{
  "code": "OPERATOR_APPROVAL_AUTHORITY_NOT_CONFIGURED",
  "message": "Persisted approval checkpoint authority is not configured, so no approval can authorize execution."
}
```

with, on the runtime mission record:

```text
mission   graph:platform-autoposter-e52da4af…-graph:node:autoposter_schedule
action    autoposter.post.schedule
status    failed
approvalDecision  { required: true, approved: false, approvedBy: null }
idempotency       { outcome: "not_applicable" }
output    null      evidence  null
```

---

## 3. Root-cause trace

```text
POST /api/platform/autoposter-commands            -> 201, durable command + graph   OK
POST .../{id}/execute  (control capability)
  -> PlatformAutoPosterCommandService.execute                                        OK
  -> MissionGraphService -> MissionGraphChildDispatcher                              OK
  -> AutoPosterMissionService.approveAndExecute -> executeMission                    OK
  -> Agent Runtime pre-adapter approval guard      REFUSED
       OPERATOR_APPROVAL_AUTHORITY_NOT_CONFIGURED
  -> runtime mission           status = failed
  -> mission graph node        status = failed_recoverable
  -> mission graph             status = failed_recoverable
  -> PlatformAutoPosterCommandService refuses to claim success
       HTTP 409 PLATFORM_COMMAND_EXECUTION_INCOMPLETE
```

**Authoritative rejecting component:** the Agent Runtime's pre-adapter approval
guard, surfaced through Operator's single `persistedApprovalAuthority` seam.
Every layer above it behaved correctly — the platform service refusing to report
success for a `failed_recoverable` graph is the safety property working, not the
bug.

**Side effects before refusal: none.** `boundary.scheduleContractCalls === 0` and
`boundary.posts.length === 0` were already asserted immediately before the
execute call, and the refusal happened *before* the adapter — evidenced by
`output: null`, `evidence: null`, and `idempotency.outcome: "not_applicable"` on
the failed runtime mission. No stale temporary state was reused: the harness
creates a fresh `mkdtemp` root per run, and the failure reproduced identically on
first and repeated runs.

**Classification: (1) stale proof fixture.** The harness predates the
persisted-approval-authority contract (`183dbaa` → `5315919`). Production wires
one authority into both mission executors in `apps/backend/src/runtime.ts`; this
proof harness constructed both executors without it, so approval-required
execution correctly failed closed. **No production contract defect was found.**

This is the third instance of the same drift class, after the Phase 2C harness
and the `tools/` typecheck blind spot.

---

## 4. Implementation decision

Smallest correct diff: wire the repository's existing, already-reviewed
`approvalAuthorityFixtureFor` helper into the harness, mirroring how
`runtime.ts` shares one `config.approvalAuthority` across both executors.

Keyed by **database path**, which is required rather than cosmetic: the proof
stops the Operator and restarts it against the same SQLite to test restart
replay. A fresh approval state directory would have produced new checkpoints and
silently destroyed the very restart-replay property under test.

No production source changed. No assertion was added, removed, weakened, or
relaxed — the diff of the proof file contains only the import, the shared
`approvalAuthority` binding, its two call sites, and the cleanup hook.

---

## 5. Files changed

```text
 README.md                                                        | 15 +++++-----
 tools/platform-canonical/platform-canonical.integration.test.mts | 21 +++++++++++--
 tools/validation/osValidation.mts                                |  4 +++
 tools/validation/osValidation.test.mts                           |  1 +
 CHANTER_OPERATOR_CANONICAL_PLATFORM_COMMAND_AUTHORITY_P0_RESULT_V1.md | new
```

34 insertions, 7 deletions. No dependency or lockfile change. No new TypeScript
files, so tools static coverage needed no change — the edited files are already
inside `tsconfig.tools.json` and `npm run typecheck:tools` exits `0`.

---

## 6. Proven guarantees

All assertions below already existed in the proof; the fix restored the path that
makes them reachable.

### 6.1 Canonical intake

Deterministic `commandId` (`derivePlatformAutoPosterCommandId`), `graphId`,
`graphHash`, `missionId`, and `traceId`, bound to exact workspace/account scope
(`workspace-platform-canonical` / `tt-platform-canonical`). Durable rows after
submit: commands `1`, graphs `1`, runtime missions `0` — submission creates no
side effect.

### 6.2 Human authority

- Submit capability **cannot** execute: `401`.
- Wrong `graphHash` under the control capability: `409`, with
  `scheduleContractCalls === 0` and `posts.length === 0` — refused before any
  side effect.
- Execution proceeded only once persisted, signed authority bound to an exact
  repository revision existed. `draftExecutionApprovalState: "approved"`,
  `approvalId: autoposter-approval:{missionId}`.
- No test-only bypass: the fix supplies *real* authority through the production
  seam rather than skipping the check. Before the fix the guard refused; the
  guard itself is unchanged.

### 6.3 Exactly one bounded draft

```text
boundary.scheduleContractCalls   1
boundary.durableCreateCalls      1
boundary.posts.length            1
boundary.providerPublishCalls    0
executed.body.jobIds.length      1
```

### 6.4 No publication

```text
draft.approved                        false
draft.approvalState                   "unapproved"
draft.status                          "scheduled"
publicationApprovalState              "human_required"
runtimeOutput.publishing              "blocked_until_human_approval"
boundary.providerPublishCalls         0
```

No provider adapter is installed or called anywhere in the proof.

### 6.5 Replay identity and no duplication

Two independent replays, both `200` with `replayed: true` and byte-identical
`commandId`, `graphId`, `graphHash`, `missionId`, `runtimeExecutionId`,
`campaignId`, `approvalId`, `evidenceBundleId`, `traceId`, and `jobIds`:

1. immediate execute replay;
2. **replay after a full Operator stop/restart** against the same durable state.

After both: `scheduleContractCalls` still `1`, `durableCreateCalls` still `1`,
`posts.length` still `1`, `providerPublishCalls` still `0`. Final durable rows:
commands `1`, graphs `1`, runtime missions `1`. `runtimeOutput.duplicate: false`.

### 6.6 Typed conflict, before any side effect

- Same command identity with a changed `requestedAt`: `409`
  `PLATFORM_COMMAND_PAYLOAD_MISMATCH` — semantically asserted, not a bare status.
- Wrong `graphHash` on execute: `409` with zero schedule contract calls and zero
  posts.

### 6.7 Evidence and observability

`evidenceAvailable: true`, `evidenceBundleId: autoposter-evidence:{graphId}`,
`evidenceReference` matching `/\.json$/`, `lifecycleState: "completed"`,
`productState: "draft_created"`, `error: null`, and
`runtimeMission.execution.state === "completed"`. The command detail route
returns the record with no temporary path leakage
(`JSON.stringify(detail.body).includes(root) === false`).

---

## 7. Canonical gate integration

Added one stage to the existing gate — no parallel aggregate command:

| # | Stage | Script |
| --- | --- | --- |
| 1 | Repository typecheck (backend + frontend) | `typecheck` |
| 2 | Tools static typecheck | `typecheck:tools` |
| 3 | Production build | `build` |
| **4** | **Canonical Platform command authority proof** | **`test:platform-canonical:e2e`** |
| 5 | Phase 2C generic mission proof | `test:phase2c:mission` |
| 6 | Signed approval migration E2E | `test:approval-migration:e2e` |
| 7 | OS end-to-end operational assembly | `os:assembly` |

Placement is evidence-based, following the module's documented cheapest-and-most-
diagnostic-first rule. Measured stage durations:

```text
test:platform-canonical:e2e    3 405 ms
test:phase2c:mission           8 005 ms
test:approval-migration:e2e   11 770 ms
```

so it is the fastest proof and runs first among them, immediately after build.
The orchestration test asserting the canonical script order was updated in the
same change, so silently dropping the stage fails `test:os-validation`.

---

## 8. Negative fail-fast proof

Using the orchestrator's existing injectable-runner seam (no tracked source
altered), with the platform-canonical stage forced to exit `3`:

```text
stages started: ["typecheck","typecheck:tools","build","test:platform-canonical:e2e"]
failedStage:    test:platform-canonical:e2e
exitCode:       3
skipped:        ["Phase 2C generic mission proof",
                 "Signed approval migration E2E",
                 "OS end-to-end operational assembly"]

  FAIL  Canonical Platform command authority proof (exit 3)
  SKIP  Phase 2C generic mission proof (not run)
  SKIP  Signed approval migration E2E (not run)
  SKIP  OS end-to-end operational assembly (not run)
Verdict: FAIL (exit 3)
```

The three later stages never started and the aggregate preserved the exact child
exit code `3` — not collapsed to `1`.

---

## 9. Validation results

| Command | Result |
| --- | --- |
| `npm run test:platform-canonical:e2e` ×2 | **1 / 1 pass**, both runs, isolated state |
| `npm run typecheck` | PASS |
| `npm run typecheck:tools` | PASS — 0 errors |
| `npm run build` | PASS |
| `npm run test:os-validation` | **6 / 6 pass** |
| `npm run test:backend` | **903 / 903 pass** (35 files) |
| `npm run test:phase2c:mission` | **3 / 3 pass** |
| `npm run test:approval-migration:e2e` | **7 / 7 pass** |
| `npm run os:assembly` | **PASS** |
| `npm run validate:os` ×2 | **PASS, exit 0 both, 7 / 7 stages** |
| `git diff --check` | exit 0 (CRLF advisories only) |

Both aggregate runs executed the new stage and used isolated state, with fully
independent assembly identities:

| | Run 1 | Run 2 |
| --- | --- | --- |
| missionId | `chanter-os-assembly-msh6j36x` | `chanter-os-assembly-msh6k92i` |
| taskId / loopId | `task-aae1b24d` / `b55af05a` | `task-5082d9ce` / `b8e809c5` |
| approval repo HEAD | `99cde5e0…` | `4518f6c4…` |
| Operator PIDs | 26192 → 9688 | 21656 → 2796 |

Each platform-canonical stage execution created exactly one draft within its own
temporary root, returned the same draft on replay, and produced no publication.
No tracked or untracked residue after either run.

---

## 10. Final git status

Before commit:

```text
 M README.md
 M tools/platform-canonical/platform-canonical.integration.test.mts
 M tools/validation/osValidation.mts
 M tools/validation/osValidation.test.mts
(+ this result document)
```

No lockfile drift. No generated evidence staged (`var/` remains ignored). No
`any`, `@ts-ignore`, `@ts-expect-error`, or silencing casts — verified by
grepping the diff.

---

## 11. Residual risks

1. **The drift class is now closed for four proofs, not eliminated.**
   `test:phase2d:graph`, `test:safecommit-closeout:e2e`, and the phase2e/2f
   suites remain outside `validate:os` and can rot exactly as this proof did.
   This proof only entered the gate after it was found broken by accident.
2. **`apps/backend/tests` is still statically uncovered** (225 errors, 146 from
   the `@types/supertest@6` vs `supertest@7` mismatch), so an equivalent stale
   fixture there would still be invisible.
3. **The AutoPoster boundary is an in-repo storage seam, not a live product
   instance.** The draft is real within that seam and no provider adapter is
   installed, which is the intended bound — but it is not proof against a live
   AutoPoster deployment.
4. **The approval authority binds to a disposable Git checkout**, correct for an
   isolated proof but not exercising the deployable managed-checkout mode.
5. **Gate runtime grew to roughly four to five minutes.** Stage 4 adds ~3.4 s, so
   the cost is small, but the total keeps rising as proofs are folded in.
6. **`test:platform-canonical:e2e` uses a fixed future clock** (`2099-07-26`).
   Deterministic today; a distant-future date is an assumption, not a guarantee.

---

## 12. Verdict

**PASS.** The failing proof was diagnosed to an authoritative rejecting component
rather than patched at the symptom, fixed with a wiring-only change that touched
no assertion and no production source, and is now an enforced gate stage whose
failure provably stops the run with the real exit code. Every claim above was
directly observed in command output or durable state.
