# CHANTER OS — Bounded Human-Approved Firestore Sandbox Write P0-C — Result V1

## 1. Verdict

**PASS.** CHANTER OS performed its first real external mutation, under full
governance, and put it back.

```text
real external writes ......... 1
compensation writes .......... 1
duplicate primary writes ..... 0
duplicate compensation writes  0
blind retries ................ 0
production writes ............ 0
production systems contacted . 0
residual sandbox objects ..... 0
exact human approvals ........ 1
```

Terminal state: `completed_verified_compensated`.

## 2. Repository Truth

| Repository | Branch | Start HEAD | Worktree at proof time |
| --- | --- | --- | --- |
| `apps/chanter-Operator` | `os/billed-external-provider-cost-authority-p0` | `8b766df` | 9 modified, 3 new |
| `apps/chanter-agent-runtime` | `runtime/billed-external-provider-cost-authority-p0` | `8511038` | 2 modified |
| `apps/chanter-loop.governor` | `governor/agentic-plan-governance-p0` | `60cb42a` | **clean, 0 lines** |

The predecessor verdict `READY_FOR_ONE_REAL_WRITE` was committed at `8b766df`
before this slice began.

**Scope deviation, authorized:** §13 designates `chanter-agent-runtime`
read-only. The slice could not complete without it — see §16 — and the founder
authorized a one-line change plus its guard test. The change is additive and
`irreversible` remains refused.

## 3. Sandbox Target and Credential Boundary

```text
project     chanter-os-sandbox (351074813259)
database    (default)
collection  chanter_os_real_write_p0
document    0c8550b5e775e7c682e22d0a5cdce131
```

The document id is `deriveDeterministicObjectId({ missionId, actionId })` —
sha256 over `missionId\0actionId`, truncated to 32 hex. Deterministic from
mission identity and collision-safe: a replay of the same action addresses the
same document, and the NUL separator means `ab`+`c` cannot collide with `a`+`bc`.

Credential: `chanter-os-p0c@chanter-os-sandbox.iam.gserviceaccount.com`, holding
exactly one binding anywhere — `roles/datastore.user` on the sandbox project. It
grants **sandbox-only data access and has no authority to chanter-site.** Loaded
from the execution environment; never committed, printed, persisted, or copied
into any artifact. The transport asserts no `Bearer` string appears in recorded
evidence.

Three bounds are structural rather than procedural:

- **project/database/collection pinning** checked before a URL is built, so a
  mission cannot steer the connector at production by supplying a path;
- **three constructable request shapes** — GET, PATCH with
  `currentDocument.exists=false`, DELETE with `currentDocument.updateTime`. An
  unconditional delete and an overwriting patch have no code path;
- **no collection-level operation** — no list, no query, no batch, so "delete by
  query" has nothing to be expressed in.

## 4. Pre-State Authority

Proven absent twice: once at intake, once by X1 immediately before execution.

```text
observed sourceRevision  chanter.absent.v1
observationHash          866e1a0ad9166e1446061bd96073cf54ff7807198892d897b96dbf2bf40f1803
```

Absence is a typed pre-state, not a missing observation. `firestoreAbsentStateHash`
derives it with the same `createObservationHash` the mission side uses, so "the
state the connector sees" and "the state the mission observed" are comparable by
value. No fake revision value was substituted anywhere.

If the document had existed, intake refuses with
`AGENTIC_EXCEPTION_TARGET_ALREADY_EXISTS` — before a plan is compiled and before
a human is asked to approve a create that could only fail or overwrite.

## 5. StateDelta

Four field changes, each from `null` — the honest reading of a create.

```text
deltaHash  109ecbb624cb5c22753fac88101414e2e893efb824a55d09740bdc1b5841602d
fields     missionId, actionId, createdAt, probeId
```

Typed, content-addressed, human-reviewable, bounded, non-production, non-secret.
No credential, token, user data, or production identifier appears in the payload.

## 6. ActionContract

```text
actionContractHash  (bound into the candidate below)
candidateHash       b82cd025b34b95af36032656d897e229dd4c231112fa49a68bda381f27604546
idempotencyKey      p0c-firestore-1:109ecbb624cb5c22753fac88101414e2:8d0316d7ca50f858a1ac671088312c6a
```

Binds mission id, connector id, sandbox project identity, database, document
path, `exists(false)` pre-state, payload hash, deterministic document id,
compensation plan, verification oracle, and a blast radius of one disposable
document.

## 7. Human Approval

One exact human approval, bound to candidate hash
`b82cd025b34b95af36032656d897e229dd4c231112fa49a68bda381f27604546`, issued
through the existing Operator approval authority. No parallel approval system was
introduced.

The apply worker recompiles the contract and re-hashes it before writing, so an
approval cannot be carried onto different bytes. Changing the document id,
payload, project, pre-state, compensation plan, or verification oracle changes
the hash and invalidates the approval.

## 8. Primary Real Create

```text
performedWrite  true
writeCount      1
request         PATCH ?currentDocument.exists=false
```

`writeCount` is bounded `1..1` by the capability's output schema, so a second
primary write is a contract violation rather than a thing the worker must
remember not to do.

The create's own reported revision was recorded and **deliberately not used** as
the compensation precondition.

## 9. Unknown-Outcome Reconciliation

Exercised deterministically (not against the live system) in
`agentic-firestore-sandbox-write.test.ts`: an interrupt fires after the create is
durable and before the outcome returns — the external system has acted and the
caller does not know it.

```text
absent                        -> not observed to land; retry only under policy
present, provenance matches   -> treat as applied; no second create
present, different provenance -> conflict; escalate to a human, never overwrite
read unavailable              -> still unknown; no blind retry
```

Reconciliation reads the exact document and compares the provenance the create
wrote into it, because Firestore offers no index from an idempotency key to a
document. Measured on the live run: `reconciliationReads = 2`, `blindRetries = 0`,
`duplicateActions = 0`.

## 10. Independent Verification

X5 re-read the document through a separate call and confirmed identity, payload,
and revision.

```text
outcomeVerified   true
verifiedRevision  2026-08-08T11:26:04.203660Z
```

## 11. Compensation Contract

Delete the exact created document, conditional on the exact post-create revision
obtained from the independent re-read. No force delete, no collection-wide
delete, no delete by query, no unrelated document.

**X6 depends on X5, not X4.** The revision the delete binds to comes from the
verification read, never from the create's own response — the write's account of
itself is not evidence about the write.

## 12. Compensation Execution

```text
compensated              true
performedWrite           true
expectedRevision         2026-08-08T11:26:04.203660Z  (== X5's verifiedRevision)
connectorCompensationCount  1
request                  DELETE ?currentDocument.updateTime=<verified>
```

A revision mismatch is a refusal (`CONNECTOR_COMPENSATION_PRECONDITION_FAILED`),
terminal and requiring a human. Forcing past it would delete whatever another
writer had put there.

## 13. Compensation Verification

X7 independently re-read the document and observed 404.

```text
recordAbsent          true
absenceVerified       true
residualObjectCount   0
```

**Out-of-band confirmation:** the sandbox collection was queried afterwards with
the *founder* credential — a different identity from the service account the
connector used — and returned **0 documents**.

## 14. Terminal Outcome

`completed_verified_compensated`, `verified: true`.

Unreachable except through all three: the primary create verified present, the
exact compensation executed, and absence independently verified. §16's "worker
success alone is insufficient" is enforced — the terminal projection re-reads
X5's verdict as well as X7's, so a mission that never wrote anything cannot reach
this state by observing an emptiness it never disturbed.

## 15. ValueObservation

```text
humanApprovals ................ 1
realExternalWrites ............ 1
compensationWrites ............ 1
duplicateActions .............. 0
blindRetries .................. 0
connectorReads ................ 5
reconciliationReads ........... 2
verificationReads ............. 1
firestoreRequests ............. 11  (5 GET, 1 PATCH, 1 DELETE, 4 GET)
createRequests ................ 1
deleteRequests ................ 1
providerCalls ................. 0
providerCostMicros ............ 0
```

No commercial or ROI claim is made.

## 16. Failure Proofs

`agentic-firestore-sandbox-write.test.ts` — 19 proofs × 3 runs = **57 passed**,
all against a deterministic in-memory Firestore that enforces the same two
preconditions the real service does. **No test in that file performs a real
call.**

| §18 requirement | Proof |
| --- | --- |
| document unexpectedly exists | refused, `writes = 0` |
| document appears before execution | create refused ALREADY_EXISTS |
| approval payload mismatch | pre-state hash mismatch refused |
| wrong sandbox project | refused before a request is built; `transportCalls = 0` |
| credential mismatch | refused before the key signs anything |
| create response lost | typed unknown, never "failed" |
| document present with unexpected payload | conflict, never overwrite |
| revision changed before compensation | delete refused, document left alone |
| compensation precondition failure | terminal, requires human |
| verification read unavailable | 503 ≠ 404; outage never reads as absence |
| stale concurrent writer | refused via revision precondition |

Also proven: unbounded field writes refused, unknown capabilities refused,
compensation without a revision refused, terminal replay performs no second
delete, and every constructed request is one of three bounded shapes.

**Six structural guards were opened deliberately**, each with its reasoning
recorded in the code. Five were in Operator (manifest `realExternalWrites`,
`ExceptionValueObservation.realExternalWrites`, capability-registry risk-class
denylist, external side-effect refusal, intent-compiler risk class). The sixth
was `EXECUTABLE_RISK_CLASSES` in `chanter-agent-runtime`, which refused
`external_write` on the stated grounds that "there is nothing in this fabric that
could make one safe" — true when written, and no longer true once a compensable
sandbox target existed. In every case the bound moved rather than vanished, and
`irreversible` remains refused everywhere.

## 17. Files Changed

**chanter-Operator** — 9 modified, 3 new:

```text
src/agentic/agenticFirestoreDocumentConnector.ts   NEW  real write-capable connector
src/agentic/agenticSimulatedConnector.ts                port: compensate(), widened manifest
src/agentic/agenticExceptionContract.ts                 absent pre-state, compensated terminal, counters
src/agentic/agenticCapabilityRegistry.ts                3 capabilities, 1 tool, guard invariants
src/agentic/agenticPlanCompiler.ts                      compensated 7-node blueprint
src/agentic/agenticWorkers.ts                           X6/X7 workers, absence-tolerant X1
src/agentic/agenticMissionService.ts                    intake gates, X6/X7 inputs, terminal projection
src/agentic/agenticToolSurface.ts                       connector.state.compensate seam
src/agentic/agenticIntentCompiler.ts                    external_write risk, compensated capability set
tests/agentic-fabric-contract.test.ts                   guard tests updated to the narrower invariants
tests/agentic-firestore-sandbox-write.test.ts      NEW  57 fail-closed proofs
tools/os-firestore-sandbox-write/run-...mts        NEW  the live proof harness
```

**chanter-agent-runtime** — 2 modified:

```text
src/agenticNode.ts          EXECUTABLE_RISK_CLASSES += 'external_write'
tests/agenticNode.test.ts   guard test now asserts irreversible is refused
```

## 18. Baseline and Final Validation

| Suite | Baseline | Final |
| --- | --- | --- |
| Operator backend | 41 files, 1047 tests | **42 files, 1108 passed** |
| Runtime | 148 suites, 684 tests | **685 passed, 0 failed** |
| Operator `tsc --noEmit` | 0 errors | **0 errors** |
| Runtime `tsc --noEmit` | 0 errors | **0 errors** |

Baselines were measured **before** any edit, so the deltas are exactly the tests
this slice added. Every predecessor proof is preserved: Operational Exception P0,
Shadow Connector P0-B, Real-Write Readiness P0-C0, Firestore Create-if-Absent
Readiness P0-C0.1, and the provider-backed model-worker admission proofs.

The live proof executed **once**. A dry-run mode
(`CHANTER_OS_P0C_DRY_RUN=1`) drives the identical governed path against an
in-memory Firestore, and was used to find every wiring defect before the one real
execution — including two the type checker could not: a plan with two
`outcome_verify` nodes breaking `soleNodeOfType`, and intake gates that matched
only `"live"` and would have let the compensated mode past the write checks.

## 19. Measured Real-Write Evidence

```text
real sandbox source ........... 1
exact human approvals ......... 1
primary real writes ........... 1
compensation real writes ...... 1
duplicate primary writes ...... 0
duplicate compensation writes . 0
blind retries ................. 0
production writes ............. 0
production systems contacted .. 0
residual sandbox objects ...... 0
reads ......................... 5
revision checks ............... 2 (create precondition, delete precondition)
unknown-outcome reconciliations 2
stale conflicts ............... 0
approval refusals ............. 0
provider calls ................ 0
provider cost ................. 0 micros
```

Durable evidence: `var/os-firestore-sandbox-write/evidence.json`.

## 20. Git / Worktree Truth

| Repository | Branch | Start HEAD | End HEAD | Worktree |
| --- | --- | --- | --- | --- |
| `apps/chanter-Operator` | `os/billed-external-provider-cost-authority-p0` | `8b766df` | the commit carrying this file | clean |
| `apps/chanter-agent-runtime` | `runtime/billed-external-provider-cost-authority-p0` | `8511038` | `921eb93` | clean |
| `apps/chanter-loop.governor` | `governor/agentic-plan-governance-p0` | `60cb42a` | `60cb42a` (**0 lines**) | clean |

One commit per repository. The Operator end HEAD is named by description rather
than by hash on purpose: a commit cannot contain its own hash, and writing one in
would either be stale the moment it was recorded or force an amend loop chasing
it. `git log -1` is the authority for that value; this document is the authority
for everything else.

Operator's commit requires Runtime `921eb93`, and the dependency is stated in its
commit message so the two cannot be read apart.

No credential material is present in either commit; `var/` — which holds the live
evidence JSON — is gitignored and was not staged.

## 21. Push Status

**Nothing pushed.** No remote was contacted by any repository in this slice.

## 22. Remaining Limitations

- The compensated plan is **linear and single-object**. A mission needing two
  bounded writes has no shape in this fabric yet, and should not be given one by
  loosening the `1..1` write count.
- `readAction` now takes an optional `targetId`. Connectors that genuinely index
  their own actions ignore it; ones that cannot need it. A connector addressing a
  system with neither an action index nor addressable identity still has no
  honest reconciliation story.
- The compensation is `idempotent_create_delete` only. `native_rollback` and
  `compensating_action` remain declared-but-unexercised.
- The sandbox credential is a long-lived service-account key on disk. Adequate
  for a sandbox holding nothing; not a pattern to carry to production.
- **This proves nothing about production.** The target was chosen precisely
  because losing it costs nothing, and every guard opened here was opened on that
  basis.

## 23. Recommended Next Slice

```text
CHANTER OS — Real Operational Connector Candidate Selection P1
```

Do not jump from this sandbox proof to a production write.

## 24. Final Status Line

```text
CHANTER OS BOUNDED FIRESTORE SANDBOX REAL WRITE: PASS — 12/12 live steps; 1 real create + 1 conditional compensation delete against chanter-os-sandbox, both independently verified; 0 duplicates, 0 blind retries, 0 production contact, 0 residual objects; terminal completed_verified_compensated; 57 fail-closed proofs (19 x3); Operator 1108/1108, Runtime 685/685; nothing pushed.
```
