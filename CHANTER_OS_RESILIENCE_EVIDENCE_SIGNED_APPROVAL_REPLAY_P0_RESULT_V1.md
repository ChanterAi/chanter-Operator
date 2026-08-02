# CHANTER OS — Resilience Evidence Signed Approval Replay P0 — Result V1

**Verdict: PASS**

Date: 2026-08-02. Local only. Nothing pushed, merged, deployed, or published.

---

## 1. Repository and state

| Field | Value |
| --- | --- |
| Repository | `apps/chanter-Operator` |
| Branch | `os/persisted-approval-authority-consumer-migration-p0` |
| Starting HEAD | `82d98f8` |
| Ending HEAD | the single child of `82d98f8` on this branch — derive from repository truth (`git -C apps/chanter-Operator log --oneline -1`); it is not quoted here because this artifact is committed inside that commit |
| Working tree at end | clean |
| Other repositories | `chanter-agent-runtime` (`5ab993b`), `chanter-loop.governor` (`cc115c2`), `chanter-auto-poster` (`72614fb`) — **all unchanged** |

The canonical target named by the previous milestone still exists at its recorded path:
`tools/resilience-evidence/cross-process-replay.mjs`. It has not moved and has no successor, so it
was migrated in place. No parallel evidence tool was created.

---

## 2. Pre-change failure and root cause — correcting the previous artifact

`CHANTER_OS_CROSS_REPOSITORY_APPROVAL_AUTHENTICITY_P0_RESULT_V1.md` §16.5 stated that this tool
"remains unmigrated and fails closed". **That was an inference from the contract, not a
measurement, and it was wrong.** Measured here:

```
npm run test:resilience:cross-process   → exit 1

TypeError: Cannot read properties of undefined (reading 'getRun')
  at AutoPosterMissionLedger.currentEntry (autoPosterMissionLedger.ts:316)
  at AutoPosterMissionLedger.append        (autoPosterMissionLedger.ts:232)
  at AutoPosterMissionLedger.initialize    (autoPosterMissionLedger.ts:83)
  at AutoPosterMissionService.createScheduleMission (autoPosterMissionService.ts:1074)
  at cross-process-replay.mjs:252
```

**Root cause:** the tool constructed `AutoPosterMissionService` without `agentRunLedgerService`,
which `AutoPosterMissionServiceOptions` declares as **required**
(`autoPosterMissionService.ts:208`). The tool is a `.mjs` file under `tools/`, and the backend
`tsconfig.json` sets `"include": ["src"]`, so TypeScript never checked this call site. It rotted
silently when the run-ledger requirement landed.

The practical consequence matters: the tool **crashed during mission creation and never reached
the approval contract at all**. Its transient `approval: { approved: true, approvedBy: "founder" }`
was real but unreachable. "Fails closed" was true only in the trivial sense that a crash executes
nothing.

### 2.1 Every contract bypass found in the original tool

| Location | Bypass |
| --- | --- |
| `cross-process-replay.mjs:244` | `AutoPosterMissionService` missing the required run-ledger service (the crash) |
| `:291` | Hand-assembled `approval: { approved: true, approvedBy }` — legacy transient approval |
| `:276-297` | The whole runtime request hand-built rather than read from Operator's durable binding |
| child process source `:310-313` | `executeMission` with `createInMemoryIdempotencyStore()`, **no** `runLedger`, **no** `approvalAuthority`, **no** `approvalTrustStore` |
| `:337-343` | Recovered executor built with no approval-authority configuration |
| assertions | Adapter entry inferred from the downstream create counter only; the Runtime's own `adapter_started` was never read |

---

## 3. Files changed

**One file:** `tools/resilience-evidence/cross-process-replay.mjs` (+345 / −32).

Nothing else changed in any repository. No new tool, no new npm script, no production source
change, no test weakened.

---

## 4. Migrated execution flow

```
disposable clean Git checkout (real repository identity, exact committed HEAD, clean worktree)
disposable Ed25519 issuer      (private key → mode-0600 temp file; trust file → public key only)
  ↓
Operator creates the mission (real AutoPosterMissionService, real run-ledger service)
  ↓
injected crash at after_downstream_request_preparation_persistence
  → durable state stops at `downstream_request_prepared`   [asserted]
  ↓
runtimeRequestFor(missionId)            ← the exact request Operator durably bound,
                                          read back rather than hand-assembled
  ↓
issuingExecutor.prepareApproval(...)    ← CANONICAL ISSUER BOUNDARY, the only signing step
  → Runtime publishes the immutable checkpoint (returns approval_required, adapter untouched)
  → Operator publishes the Ed25519-signed observation
  → signature bytes, observationHash, issuer id, key id, scheme captured here
  → downstream create attempts still 0   [asserted]
  ↓
database.close()                        ← PROCESS BOUNDARY, after approval persistence
  ↓
2 independent OS child processes, each:
  - reconstructs the durable idempotency store and run ledger from stateDir
  - builds an explicit trust store from PUBLIC key material only
  - resumes with the exact persisted authority tuple (manifestHash + observationHash)
  - never signs, re-authors, or repairs approval state
  ↓
Operator reopens the database → reconcileMission → resumeSafely
  ↓
measured: adapter starts, downstream creates, signature identity, authority decisions
```

---

## 5. Valid replay proof — measured, not inferred

Representative run (all three consecutive runs identical on every measured field):

| Measurement | Value | Meaning |
| --- | --- | --- |
| `independentRuntimeProcessIds` | 2 distinct pids | Genuinely separate OS processes |
| `measuredAdapterStarts` | **1** | Read from the durable run ledger for the mission's main claim scope |
| `downstreamCreateAttempts` | **1** | Real AutoPoster application service reached exactly once |
| `downstreamJobCount` / `duplicateCount` | 1 / 0 | One queue draft, no duplicate |
| `callerStatuses` | `succeeded`, `unavailable` | One executed; the other was refused at the durable claim |
| `callersConverged` | true | Every caller that produced a queue id produced the authoritative one |
| `acceptedAuthorityDecisions` | **1** | Exactly one `approval_authority_accepted` guard decision |
| `authorityDecisionEvidenceHashes` | one sha256 | Content-addressed evidence for that decision |
| `approvalSignatureUnchangedAcrossRestart` | true | Signature bytes, `observationHash`, issuer id, key id, and scheme all identical after restart |
| `childrenObservedIdenticalSignature` | true | Each child saw the same signature before **and** after its own run |
| `downstreamCreatesDuringIssuance` | **0** | Publishing signed authority never crossed the downstream boundary |
| `providerEndpointInvocations` | 0 | No provider call |
| `publishingState` | `blocked_until_human_approval` | The queue draft remains unapproved |
| `recoveredScopeAdapterStarts` | 1 | See §5.2 — reported so the headline `1` is not mistaken for something broader |

`approvalIssuerAuthorityId` = `chanter.operator.resilience-evidence`,
`approvalIssuerKeyId` = `resilience-evidence-key-1`,
`approvalAuthenticityScheme` = `chanter.runtime.approval-authenticity.ed25519.v1`.

### 5.1 The one assertion that changed, and exactly why

The original asserted `statuses.join(",") === "duplicate,succeeded"` and
`new Set(queueIds).size === 1`.

Before signed authority the two callers used **separate in-memory stores**, so both reached the
downstream boundary and the loser was deduplicated *there*, returning the same queue id as
`duplicate`. They now share **one durable claim**, so the loser is refused *before the adapter*
and truthfully returns no queue id at all — status `unavailable`.

The assertion was therefore restated, not relaxed:

- **exactly one** caller may be `succeeded`;
- every other caller must be `duplicate` **or** `unavailable` (both mean "did not execute again");
- convergence means at least one caller produced a queue id and **every** caller that produced one
  produced the authoritative one.

This describes a strictly **stronger** outcome — the duplicate is now stopped a boundary earlier —
and it still fails if any caller diverges. Every other original assertion (exact journal binding,
one `result_persisted`, one `completed`, authoritative queue id, evidence chain, no split brain,
draft left unapproved, zero provider invocations) is unchanged and still enforced.

### 5.2 Honest note on adapter entries

`measuredAdapterStarts: 1` is the mission's **main** claim scope. Operator's `resumeSafely`
re-materializes the already-observed downstream result through a **no-side-effect** adapter in its
own recovery claim scope, which the tool now also measures and reports
(`recoveredScopeAdapterStarts: 1`). So: two adapter entries across two scopes, and **exactly one
downstream side effect** — `downstreamCreateAttempts: 1`. Reported explicitly so the headline
number is not read as a stronger claim than it is.

---

## 6. Unsigned replay proof — focused negative

The same replay path, with the persisted observation authored by a state-directory writer holding
no signing key. Deliberately minimal: the broad authenticity matrix already exists in the two
focused suites; this proves only that *this tool* consumes the real contract.

| Measurement | Value |
| --- | --- |
| `unsignedReplayRefusalCode` | **`RUNTIME_APPROVAL_AUTHENTICITY_MISSING`** |
| `unsignedReplayAdapterStarts` | **0** |
| `unsignedReplayDurableRefusalEvents` | 1 (durable run-ledger event carrying the typed code) |
| `unsignedReplayStayedUnsigned` | true — the refusal did not re-sign, repair, or replace the approval |
| downstream creates during the unsigned scenario | unchanged (asserted equal before and after) |

The observation it refuses is structurally perfect: correct `observationHash`, correct checkpoint
binding, correct repository and HEAD binding, `status: "approved"`. It lacks only a signature.

---

## 7. Restart and duplicate resume

- **Restart occurs after approval persistence and before execution.** The signed observation is
  published, then the SQLite handle is closed, then the children run in separate processes.
- **The post-restart processes consume the same immutable signed observation** — proven by
  `childrenObservedIdenticalSignature` (each child compared the signature it saw on entry and on
  exit) and `approvalSignatureUnchangedAcrossRestart` (parent compared against bytes captured
  before any child started).
- **Duplicate resume creates no second adapter start.** Three independent consumers touched the
  mission after approval — two children plus Operator's `resumeSafely` — and the main scope
  recorded `adapter_started` exactly once, with exactly one downstream create.

---

## 8. Evidence and run-ledger identities inspected

| Identity | Source |
| --- | --- |
| `approval_authority_accepted` count and `evidenceHash` | durable run ledger, main state dir |
| `adapter_started` count | durable run ledger, main and recovered scopes |
| refusal event with `detail.code` | durable run ledger, unsigned scenario state dir |
| `observationHash`, issuer id, key id, scheme | durable approval observation |
| signature digest | `sha256` of the signature bytes — the **digest** is published, never the signature itself |
| `evidenceChainId` | unchanged original chain over mission id, queue id, and journal transition ids |

---

## 9. Secret handling

- The Ed25519 private key exists only as a **mode-0600 file inside the run's temp root**, deleted
  with that root in the `finally` block.
- The trust file and the child-process configuration carry **public key material only**.
- The evidence output publishes the **sha256 of the signature**, never the signature bytes, and
  never any key.
- `git diff` of the change contains **zero** matches for `BEGIN … PRIVATE KEY` or PKCS#8 preamble.
- No key material is written to the observation, evidence, run ledger, logs, errors, or this
  artifact.

---

## 10. Validation

| Command | Exit | Result | Adapter entry measured directly? | External side effect |
| --- | --- | --- | --- | --- |
| `npm run test:resilience:cross-process` (before changes) | **1** | Crash in `createScheduleMission` (§2) | n/a | none |
| `npm run test:resilience:cross-process` — run 1 | 0 | verdict PASS; adapter starts 1; unsigned 0 | **yes** (durable run ledger) | none |
| run 2 | 0 | verdict PASS; adapter starts 1; unsigned 0 | yes | none |
| run 3 | 0 | verdict PASS; adapter starts 1; unsigned 0 | yes | none |
| `npx vitest run tests/approval-issuer-authenticity.test.ts` | 0 | 6 passed (6) | yes | none |
| `npx vitest run tests/approval-authority-repository-binding.test.ts` | 0 | 10 passed (10) | yes | none |
| `npm run typecheck --workspace @chanter/operator-backend` | 0 | PASS | n/a | none |
| `npm run build --workspace @chanter/operator-backend` | 0 | PASS | n/a | none |
| `npm test` | 0 | backend **903 passed (903)**, 35 files; frontend **133 passed (133)**, 7 files | yes | none |
| `git diff --check` | 0 | PASS | n/a | none |
| Diff inspection for private keys / generated artifacts | — | 0 key matches; 1 file changed, no artifacts | n/a | none |

Test counts are unchanged from the previous milestone (903 / 133): this task added no test file
and removed none. The three evidence runs all passed; none of the first two failed.

---

## 11. External side effects

**None.** The HTTP server binds `127.0.0.1:0` and is backed by the real AutoPoster application
service over an in-memory storage fake. No push, merge, deploy, publication, production key
generation or rotation, production mutation, or real provider call. `providerEndpointInvocations`
is asserted to be 0. All keys, repositories, state directories, and databases are disposable temp
roots removed in `finally`.

---

## 12. Remaining risks

1. **`tools/` is still outside typecheck coverage.** This exact class of silent rot can recur:
   the backend `tsconfig.json` includes only `src`. Bringing `tools/` under a checked project is
   worthwhile but is its own change, not this one.
2. **The clean-source harness rewrites the `node_modules/chanter-agent-runtime` symlink** during
   the run and restores it in `finally`. Pre-existing behaviour, unchanged here, but an
   interrupted run can leave the link pointing at a deleted temp directory; re-running restores it.
3. **The tool binds approval authority in direct mode** against a disposable clean checkout.
   Managed per-revision checkouts are proven separately; exercising them here would have expanded
   scope into checkout lifecycle.
4. **The recovered execution scope enters a no-side-effect adapter** (§5.2). That is existing
   recovery behaviour, now measured rather than invisible.
5. **Inherited and unchanged:** guarantee boundary is the pre-adapter decision point; a
   compromised Operator process holds the signing key by design; authority-checkout retention is
   unbounded.

---

## 13. Rollback

```bash
git -C apps/chanter-Operator reset --hard 82d98f8
```

Single-file, single-commit change in one repository. Rolling back restores the tool to its
**crashing** state (§2), not to a working one.

---

## 14. Does final canonical CHANTER OS E2E closure remain blocked?

**Yes, by less.** Evidence-tool migration — item 1 on the previous milestone's remaining list — is
closed. The canonical cross-process resilience evidence path now runs on real Ed25519-signed
persisted approval authority.

Still open:

1. **Reachability-aware authority-checkout garbage collection** — retention is deliberately
   unbounded at P0.
2. **Unresolved-claim reconciliation onto the Runtime reconciler** — currently
   Operator-evidence-bound.
3. **Key lifecycle automation** — rotation is manual and revocation requires a restart.
4. **`tools/` typecheck coverage** — newly identified here (§12.1); it is what allowed this tool
   to rot undetected.

---

## 15. Verdict

**PASS**, against every acceptance criterion:

1. Real Ed25519-signed persisted approval — yes, published through the canonical issuer boundary.
2. Explicit trust store, public material only — yes, built from a trust file and passed to each child.
3. Restart after approval persistence, before execution — yes.
4. Post-restart processes consume the same immutable signed observation — yes, byte-identical.
5. Valid replay reaches exactly one adapter start — yes, measured from the durable run ledger.
6. Duplicate resume creates no second adapter start — yes, across three independent consumers.
7. Unsigned replay reaches zero adapter starts with a typed authenticity refusal — yes,
   `RUNTIME_APPROVAL_AUTHENTICITY_MISSING`.
8. Accept and refuse decisions are durable and inspectable — yes, with evidence hashes.
9. No private key material leaks anywhere — yes.
10. Existing assertions remain enabled and pass — yes; one restated and documented (§5.1), none weakened.
11. Working tree clean — yes.
12. No external side effects — yes.
