# CHANTER OS — End-to-End Operational Assembly P0 — Result V1

**Verdict: PASS**

One canonical CHANTER OS generic mission path is now executable through a single
documented local command and leaves reviewable evidence:

> Operator submission → persisted human approval → Agent Runtime execution →
> Loop Governor manual-loop creation → durable result/evidence → replay/recovery
> without duplication → Operator-visible terminal state.

---

## 1. Repository state

| Repository | Branch | Starting HEAD | Ending HEAD |
| --- | --- | --- | --- |
| `apps/chanter-Operator` | `os/persisted-approval-authority-consumer-migration-p0` | `53159194dee7f8432d3daf8a015e39119869e82c` | this commit |
| `apps/chanter-agent-runtime` | `runtime/durable-mission-value-evidence-p0` | `4ab64e50f047f02ac33af7c27ad0812c93a59b6e` | `4ab64e50f047f02ac33af7c27ad0812c93a59b6e` (unchanged) |
| `apps/chanter-loop.governor` | `governor/native-task-bound-validation-p0` | `cc115c21163976b9ec60694840b276070eae308e` | `cc115c21163976b9ec60694840b276070eae308e` (unchanged) |

All three working trees were clean at preflight.

**Preflight discrepancy (recorded, not silently accepted).** The task brief gave
the Operator HEAD as `53159194dee7f8432d3dafa8015e39119869e82c`. The actual HEAD
is `53159194dee7f8432d3daf8a015e39119869e82c` — the same 40-character SHA with
two hex characters transposed (`...dafa8015...` vs `...daf8a015...`). Short SHA
`5315919` and the commit subject (`feat(operator): run cross-process replay
evidence on signed approval authority`) confirm it is the intended commit. The
actual SHA is authoritative above.

Agent Runtime and Loop Governor required **zero** source changes: their halves of
the contract were already correct and are unmodified at their expected HEADs.
This is therefore a single-repository change with one commit, in `chanter-Operator`.

---

## 2. Root cause of the missing seam

The generic Loop Governor mission lane — the exact path this task specifies —
**could not execute end to end at HEAD**, and its only end-to-end proof was red.

Running the repository's own proof first (rather than reasoning about it):

```
npm run test:phase2c:mission
# tests 3 / pass 0 / fail 3   — all three asserted "succeeded", observed "failed"
```

A direct probe against `GenericMissionService` returned the typed cause:

```json
{
  "status": "failed",
  "errors": [{
    "code": "OPERATOR_APPROVAL_AUTHORITY_NOT_CONFIGURED",
    "message": "Persisted approval checkpoint authority is not configured, so no approval can authorize execution."
  }],
  "approvalDecision": { "required": true, "approved": false, "approvedBy": null }
}
```

with `executor.configured = true` but `executor.approvalAuthorityConfigured = false`.

**Cause.** The persisted-approval-authority contract (Operator `183dbaa` →
`5315919`, Runtime `5ab993b`) made a persisted, signed, repository-bound approval
mandatory before any approval-required adapter call. The AutoPoster lane and the
production `runtime.ts` wiring were migrated; the generic Loop Governor lane's
proof harness (`tools/phase2c/mission-loop.integration.test.mts`) was not. It
still constructed `createLoopGovernorMissionExecutor({...})` with no
`approvalAuthority`, so every approved generic mission failed closed.

Two things follow, and only the second is a defect:

- The **fail-closed behaviour is correct** — no approval, no execution. The
  safety property held.
- The **path was unprovable and unrunnable**. `tools/` sits outside the backend
  `tsconfig` `include: ["src"]`, so the harness rotted silently: nothing
  typechecked it and no suite in `npm test` ran it.

There was also no operator-facing way to run this path at all: no command, no
example envelope, no runbook, no machine-readable result.

---

## 3. Implementation decision

Smallest correct diff, using existing canonical surfaces in place.

1. **Restore the regression proof (3 lines of wiring).** `tools/phase2c/…` now
   builds its executor with `approvalAuthority: approvalAuthorityFixtureFor(databasePath)`,
   importing the repository's canonical `apps/backend/tests/helpers/approvalAuthorityFixture.ts`
   rather than duplicating ~50 lines of repository/issuer provisioning. Keying by
   database path is required: a restart against the same durable mission universe
   must reuse the same checkpoints, observations, and claims, or the restart
   behaviour under test is silently hidden.

2. **Add one canonical operator command.** `tools/os-assembly/run-end-to-end-assembly.mts`
   (`npm run os:assembly`) drives the **real Operator server process**
   (`apps/backend/src/server.ts`, i.e. the production `createRuntime()` wiring)
   over HTTP against disposable temporary state. Driving the real server — not a
   hand-assembled harness — is deliberate: it proves the deployable path, and it
   allows a genuine process kill/restart rather than an in-process rebuild.

No production source file changed. No approval or validation check was weakened;
the approval requirement is now *satisfied* by real signed authority instead of
being unreachable.

---

## 4. Files changed (`apps/chanter-Operator` only)

```
 README.md                                       | 38 +++++++++++++++++++++++++
 package.json                                    |  3 +-
 tools/phase2c/mission-loop.integration.test.mts |  8 ++++++
 tools/os-assembly/run-end-to-end-assembly.mts   | (new)
 tools/os-assembly/mission-envelope.example.json | (new)
 CHANTER_OS_END_TO_END_OPERATIONAL_ASSEMBLY_P0_RESULT_V1.md | (new, this file)
```

Product surface added, and nothing more:

- one canonical run command — `npm run os:assembly`;
- one example mission envelope — `tools/os-assembly/mission-envelope.example.json`;
- one runbook section — README, "Runbook — CHANTER OS end-to-end operational assembly";
- one machine-readable terminal result — `var/os-assembly/terminal-result.json`;
- one evidence artifact — `var/os-assembly/assembly-evidence.md` (run output, git-ignored)
  plus this committed result document.

---

## 5. Validation

| Command | Result |
| --- | --- |
| `npm run typecheck` (Runtime) | PASS |
| `npm run build` (Runtime) | PASS |
| `npm test` (Runtime) | **579 / 579 pass**, 0 fail |
| `npm run typecheck` (Operator, backend + frontend) | PASS |
| `npm run build` (Operator) | PASS |
| `npm run test:backend` (Operator) | **903 / 903 pass**, 35 files |
| `npm run test:phase2c:mission` (Operator) | **3 / 3 pass** (was 0 / 3 before the fix) |
| `npm run test:approval-migration:e2e` (Operator) | **7 / 7 pass** |
| `npm run os:assembly` (Operator) | **PASS**, run twice |
| `python -m unittest discover -s tests` (Governor) | 1221 tests, 1 pre-existing error (below) |
| `git diff --check` | clean (only Windows CRLF advisories) |

**Governor pre-existing failure, not introduced here.**
`test_operator_ledger_port.OperatorLedgerPortTests.test_error_response_token_redacted`
errors under full discovery but passes in isolation
(`python -m unittest tests.test_operator_ledger_port.OperatorLedgerPortTests.test_error_response_token_redacted`
→ `Ran 1 test … OK`). It is a known environment-sensitive local-port test,
observed at the unmodified baseline HEAD `cc115c2` before any change. Loop
Governor has zero changes in this task.

`pytest` is not installed in this environment; the repository's other declared
native command (`unittest`, per its README) was used rather than installing a
dependency.

---

## 6. Cross-process proof

`npm run os:assembly`, isolated temporary data directories, real Python child
process, real Operator server process. Observed IDs from the recorded run:

```
missionId              chanter-os-assembly-msh3fr1b
missionPayloadHash     97e32065b172df42e03a48a60eefdb8f28ec45ad9ed3a64dc688f2bfff99bbc2
downstreamOperationType loop_governor.task.create_manual_loop
taskId                 task-ae508875
loopId                 70e4c8b1   (authoritativeLoopId 70e4c8b1)
approvalRepositoryHead 244c5fa95f3263d505808540a57fb1938225d741
operator PIDs          19672  →  12748   (abrupt kill, then restart)
realAgentExecution     false
```

| # | Step | Observed |
| --- | --- | --- |
| 1 | Submit mission | `201`, `approval_required`, **0** Governor tasks |
| 2 | Approval-required state on canonical read route | `approval_required`, `approvedBy: null`, payload hash bound |
| 3 | Approval refused without control capability | submit token `401`, anonymous `401`, still 0 tasks |
| 4 | Persist approval → execute → downstream | `200`, `succeeded`, `evidenceStatus: authoritative`, `created: true` |
| 5 | Exactly one Governor task + loop | task list `["task-ae508875"]`, loop count `1`, task scope carries `[chanter-mission:<id>]`, `task.json.loop_id` matches |
| 6 | Terminal result on canonical read route | `succeeded`, `completed`, payload hash unchanged |
| 7 | Restart process abruptly | PID 19672 killed, PID 12748 serving same durable state |
| 8 | Replay after restart | resubmit `200` `replayed: true`; re-approve `200` `succeeded`; **same** `task-ae508875` / `70e4c8b1` |
| 9 | No duplication | Governor task count **1**, loop count **1** |
| 10 | Different payload, same mission ID | `409 OPERATOR_MISSION_PAYLOAD_MISMATCH`, task count still **1** |

Replay/no-duplication and typed-failure evidence are steps 8–10 above: the second
process returns the identical downstream identity rather than re-executing, and a
changed payload under a bound mission ID is refused with a typed conflict before
any side effect.

Run twice end to end with independent mission identities; both PASS.

---

## 7. Final git status

```
apps/chanter-Operator          M README.md
                               M package.json
                               M tools/phase2c/mission-loop.integration.test.mts
                               ?? tools/os-assembly/
                               (+ this result document)
apps/chanter-agent-runtime     clean, HEAD 4ab64e5
apps/chanter-loop.governor     clean, HEAD cc115c2
```

Nothing was pushed, merged, deployed, or published.

---

## 8. Residual risks

1. **`tools/` is still outside the typecheck include.** This is the latent
   condition that let the phase2c proof rot unnoticed, and the new
   `run-end-to-end-assembly.mts` lives under the same blind spot. It is covered
   by being executed (`npm run os:assembly`), not by static checking. Closing
   this properly is the recommended next P0 — it was deliberately left out of
   scope here as a broad change.
2. **`npm run os:assembly` is not part of any aggregate suite.** Like the other
   `tools/` integration proofs it must be invoked explicitly, so it can drift
   until risk 1 is closed.
3. **The proof binds approval authority to a disposable Git checkout.** That is
   correct for an isolated local proof, but it does not exercise the deployable
   *managed checkout* mode against a live product repository; that mode is
   covered separately by `test:approval-migration:e2e`.
4. **Governor's `test_operator_ledger_port` remains order/environment sensitive**
   under full discovery (pre-existing).
5. **The example envelope's `missionId` is overridden per run.** The committed
   JSON is a template; submitting it verbatim twice would legitimately replay
   rather than create.

---

## 9. Verdict

**PASS** — the full path is implemented, executable through one documented
command, and proven with directly observed evidence including restart, replay
without duplication, and typed refusal. Every result recorded here was observed
in a real run; nothing is inferred.
