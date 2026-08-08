# CHANTER OS — Operational Exception Mission P0 — Result V1

## 1. Verdict

**PASS.** One operational exception was governed from observed state to
independently verified resolution, entirely against local/simulated systems.

```
npm run os:operational-exception
```

returned **PASS (18/18 steps)** on three consecutive runs, and the canonical gate
`validate:os` returned **PASS 14/14** with the new proof wired in as stage 13.

**Real external writes: 0** — structurally, not merely observationally.

## 2. Repository Truth

Predecessor precondition (§2) was verified from repository truth before any work:
`GOVERNED PROVIDER-BACKED MODEL-WORKER ADMISSION: PASS` is committed at Operator
`b940238` with its full evidence table (2 billed calls, 305 micros, both
confirmed against the provider's own record at delta 0).

| Repository | Branch | Start HEAD | End HEAD | Worktree |
| --- | --- | --- | --- | --- |
| `apps/chanter-agent-runtime` | `runtime/billed-external-provider-cost-authority-p0` | `650cdce` | see §19 | clean |
| `apps/chanter-Operator` | `os/billed-external-provider-cost-authority-p0` | `b940238` | see §19 | clean |
| `apps/chanter-loop.governor` | `governor/agentic-plan-governance-p0` | `60cb42a` | `60cb42a` | clean, **0 lines** |

## 3. Canonical Mission Ownership

Ownership landed exactly where §3 places it, and the strongest evidence is how
little moved:

- **Operator** owns mission identity, ObservedState, DesiredState, StateDelta,
  plan authority, human approval, TerminalOutcome, evidence, ValueObservation.
- **Agent Runtime** owns worker execution, connector invocation through the
  bounded tool surface, structured-result enforcement, and outcome durability.
  Its only change in this slice was one line of closed-world vocabulary (§16).
- **Loop Governor** owns admission only, and **changed by zero lines**.
- **The connector** owns its own simulated external state, in its own store, which
  no mission code writes to directly.

**No connector became mission authority.** The connector answers three questions
— what does the record hold, was this action applied, apply this action — and has
no path to a mission, a plan, or a verdict.

**No model claim became terminal truth.** This plan routes nothing to a model at
all: every one of its five nodes is a `deterministic_tool`, measured at
`providerCalls: 0`.

## 4. Fixture and Initial State

One deterministic architecture fixture: **invoice discrepancy → reconciled
payment-ready state**. Local temporary storage only; no real API exists in the
tool surface to call.

```text
INV-1001 @ r1
  invoiceAmount     4820.5
  reconciledAmount  4795        <- disagrees with the expected payment
  status            "discrepancy"
```

Desired terminal condition: `reconciledAmount = 4820.5`, `status =
"payment_ready"`, both bound as machine-checkable acceptance constraints.

## 5. ObservedState

Typed, content-addressed, timestamped, source-identified, and reproducible from
fixture state.

```text
sourceSystemId    connector.simulated.ledger.v1
targetId          INV-1001
sourceRevision    r1
observationHash   20c40d88d5885d3bbfdd14d2dcb5bea54bbb0c995847d5b7e4894cb72b523607
```

Two exclusions from the hash, each load-bearing:

- **`observationTime`**, so two reads of an unchanged record digest identically —
  otherwise "has the world moved?" could never be answered by comparison.
- **`missionId`**, because this is the identity of *a record*, not of one
  mission's opinion about it. The connector derives the same hash over its own
  state to enforce the pre-state check, and it has no mission to include.
  `missionId` still binds the surrounding ObservedState, so §6 is met by the
  record rather than by the digest. **This was a real defect found by the proof**
  — with `missionId` in the hash, the pre-state check could never match, and the
  first end-to-end run failed with `CONNECTOR_PRE_STATE_MISMATCH`.

## 6. DesiredState

Derived purely from what the human asked for, **before** the source is read, so
it cannot be shaped by what happens to be there.

```text
desiredStateHash  b51af2e489e05987e94d79fa5435d15e8f59295eeba97c87de33c05eef6a5dac
constraints       c-amount  reconciledAmount = 4820.5
                  c-status  status = "payment_ready"
```

The intent compiler refuses a constraint judging a field the desired state does
not set (`AGENTIC_INTENT_EXCEPTION_CONTRACT_AMBIGUOUS`, step 5) — such a mission
would be unverifiable by construction.

## 7. StateDelta

Deterministic, content-addressed, human-reviewable, bounded to exact fields.

```text
deltaHash  840f7527584c3ef3b37d0a19047c394f7e136bc0fdb8499b2737b3a0f472e57b
changes    reconciledAmount  4795          -> 4820.5
           status            "discrepancy" -> "payment_ready"
```

The hash chain is one mechanism rather than four separate checks:

```
observationHash ─┐
                 ├─> deltaHash ─> actionContractHash ─> approval
desiredStateHash ┘
```

A changed observation changes the delta, which changes the action contract, which
invalidates the approval. A mission whose delta is empty is refused outright
(`AGENTIC_EXCEPTION_NO_DELTA`, step 3): an exception with nothing to change is not
an exception.

## 8. Connector Capability Manifest

```text
connectorId              connector.simulated.ledger.v1
capabilities             ["record.reconcile"]                   (exactly one)
readOperations           record.read, action.read_by_idempotency_key
writeOperations          record.reconcile
idempotencySemantics     idempotency_key_replay_returns_original_outcome
reconciliationSupport    read_by_idempotency_key
verificationSupport      independent_read_after_write
compensationSupport      none                                   (stated, not omitted)
writableFields           ["reconciledAmount", "status"]
realExternalWrites       false
```

`compensationSupport: "none"` is explicit rather than absent, because "cannot
undo" and "nobody wrote down whether it can" imply completely different recovery
designs. There is no generic dispatcher: `apply` takes exactly the fields an
ActionContract binds, and unknown capabilities and unwritable fields are refused
at the boundary (step 16).

## 9. Action Contract and Approval Binding

```text
actionContractHash  5e8ffc3a6f3c69656f1b7937723308fbc00baa70c610d2a823124e608d9af321
idempotencyKey      exception-1:840f7527584c3ef3b37d0a19047c394f:3e091a0db0cda0177c0bf5befae3e2d8
capability          record.reconcile
```

The contract binds mission, connector, capability, target, expected pre-state
hash, delta hash, write payload hash, idempotency key, and deadline.

**The ActionContract *is* the candidate.** Its canonical bytes are what the human
approves, so §10 and §11 are satisfied by the fabric's existing approval authority
— candidate-hash binding, mismatch refusal, TTL, authority-revision pinning — with
**zero new approval code**. §11's "do not create a parallel approval system" is
met by not creating one.

The idempotency key is **derived, never generated**: a restarted process
recompiling the same contract produces the same key, and a changed delta produces
a *different* action rather than a retry of the old one.

Measured refusals: an approval bound to a different action is refused
(`AGENTIC_AUTHORITY_CANDIDATE_MISMATCH`, step 7) with connector writes still at 0.

## 10. Execution

After approval, exactly one simulated connector write.

```text
performedWrite   true
writeCount       1
INV-1001         r1 -> r2
reconciledAmount 4795 -> 4820.5
status           "discrepancy" -> "payment_ready"
```

The apply node carries an attempt limit of **1** by construction, and three checks
stand between arriving and changing anything: the contract is recompiled and
re-hashed, that hash is checked against the approved candidate, and the connector
is asked whether the idempotency key already landed. The pre-state check
deliberately belongs to the *connector* — only it knows its own state at the
instant of the write.

**Worker success alone did not mean mission success**: the plan cannot reach
`completed` without the oracle (§12).

## 11. Unknown-Outcome Reconciliation

A one-shot interrupt fires **after the connector durably applied the action and
before the outcome was committed upstream** — the genuinely ambiguous window.

```text
connector applied           yes (INV-1002 r1 -> r2)
apply node state            failed_recoverable, outcome not established
blind resume                REFUSED  AGENTIC_NODE_RECONCILIATION_REQUIRED
reconciliation outcome      worker_result_found  (from the connector's own books)
connector revision          r2 -> r2      (recovery applied nothing)
performedWrite on resume    false
duplicateActions            0
terminal state              completed_verified
```

Two real defects were found and fixed here, and both predate this P0:

1. **`resumeNode` let a failed side-effecting node through.** It refused a node
   left `running` or explicitly `reconciliation_required`, but a node that
   *threw* landed in `failed_recoverable` with no reconciliation outcome and
   could be resumed — a blind retry of a possible write. "The worker threw" is
   not the same fact as "nothing happened": the throw may come from the transport
   after the external system already acted. Now any side-effecting node with no
   established outcome must be reconciled first. Pure nodes stay exempt.
2. **Recovery cannot be re-execution.** The Runtime correctly replays a *recorded
   outcome* for the same execution identity rather than running a node twice — so
   a node interrupted inside its tool call would replay its own failure forever.
   The resume now commits what the **connector** durably holds, mirroring the
   existing worker-record branch but sourcing truth from the only system that can
   know whether the action landed.

## 12. Independent Verification

The oracle re-reads the connector and evaluates the approved acceptance
constraints. It reads no worker report, no contract expectation, and no model
opinion.

```text
recordExists              true
unsatisfiedConstraintIds  []
connectorWriteCount       1        (counted from the connector's own books)
outcomeVerified           true
```

Its independence is proven by making it fail: with a concurrent writer racing in
between the action and the oracle's read (riding the connector's own post-apply
hook, so the race is deterministic rather than hoped for), the write still
succeeded and the oracle still reported `outcomeVerified: false` and a terminal
state that is **not** `completed_verified` (step 17).

## 13. Terminal Outcome

`completed_verified | blocked | failed | unknown_requires_human`, **projected**
from durable plan truth rather than stored.

A projection on purpose: the fabric owns one reviewed lifecycle with one set of
legal transitions, and writing these four states into their own column would
create a second authority over the same fact — one that could disagree with the
plan it claims to summarize. `completed_verified` is unreachable except through a
passing oracle, structurally: the plan cannot reach `completed` without one.

Observed on the happy path: **`completed_verified`**, `verified: true`.

## 14. Value Observation

Every field counted from a durable row. No commercial ROI is invented.

```text
exceptionDetected            1
stateChangingActions         1
duplicateActions             0
humanApprovals               1
reconciliationCount          0     (happy path; 1 in the ambiguous-window mission)
verificationCount            1
timeToVerifiedResolutionMs   201
providerCostMicros           0
providerCalls                0
```

`providerCalls: 0` is measured, not assumed — a non-zero value would mean
something unexpected ran inference.

## 15. Failure and Recovery Proofs

All 18 steps, three consecutive runs. §17 coverage:

| Required failure | Proven by | Result |
| --- | --- | --- |
| stale ObservedState | step 14 | `matchesIntakeObservation: false`, action never compiled |
| changed DesiredState | §7 hash chain + step 7 | approval invalidated by construction |
| changed StateDelta | §7 hash chain | delta feeds the contract hash |
| approval bound to different action | step 7 | `AGENTIC_AUTHORITY_CANDIDATE_MISMATCH` |
| connector capability mismatch | step 16 | `CONNECTOR_CAPABILITY_UNKNOWN` |
| pre-state mismatch | step 15 | `CONNECTOR_PRE_STATE_MISMATCH` |
| duplicate execution attempt | steps 11, 13 | replay and resume both wrote nothing |
| unknown connector outcome | steps 12–13 | reconcile-before-retry, 0 duplicates |
| verifier disagreement | step 17 | `outcomeVerified: false`, not completed |
| budget exhaustion | intent compiler | `AGENTIC_INTENT_BUDGET_BELOW_MINIMUM` |
| deadline expiration | plan compiler | per-node deadline offsets, attempt limit 1 |
| stale concurrent writer | steps 14, 17 | detected before the write and at verification |

§18 recovery: **A** restart before write (step 8) — approval subject preserved, 0
side effects. **B** restart after connector applied, before commit (steps 12–13) —
reconcile, detect, **0 duplicate writes**. **C** restart after verified completion
(step 11) — re-report only, 0 worker reruns, 0 connector writes, 0 provider spend.

Also refused: a mission with no delta, a mission naming an unregistered connector,
and an acceptance constraint over an unstated field.

## 16. Files Changed

**Agent Runtime (1 file):** `agenticNode.ts` — `AgenticSideEffectClass` gains
`simulated_external`. `external` remains refused at registry load, so a real
external side effect stays structurally impossible; classifying a simulated
connector write as `local_artifact` would have been the dishonest alternative.

**Operator — new:** `agenticExceptionContract.ts` (the typed contract set),
`agenticSimulatedConnector.ts` (connector + manifest),
`tools/os-operational-exception/` (the proof), this artifact.

**Operator — modified:** capability registry (4 capabilities, 4 tools, 2 new
invariants), tool surface (connector seam), mission contract (mission kind, node
types, nullable output contract), intent compiler, plan compiler (second
blueprint + `terminalVerificationNodeId`/`authorityCheckpointNodeId`), context
compiler, mission service, plan journal, `schema.ts` (one nullable column, node
types), OS control service, routes, `tsconfig.tools.json`, `package.json`,
validation stage list, and three test files.

## 17. Baseline and Final Validation

Baseline, taken **before any edit**: `validate:os` **PASS 13/13** at Runtime
`650cdce` / Operator `b940238`, both worktrees clean.

| Scope | Final |
| --- | --- |
| Agent Runtime `npm test` | **684 / 684** |
| Operator `test:backend` | **1003 / 1003** (green twice) |
| Operator `test:os-validation` | **20 / 20** |
| Operator `validate:os` | **PASS 14 / 14** |
| `os:operational-exception` | **PASS 18 / 18**, three runs |
| Loop Governor | not run — **zero lines changed** |

**One existing test was changed for a real reason, and it is not a weakening.**
`operator-p1 > handles timeout for a blocked command` gave a *real* `git status`
subprocess a **100 ms** budget. Measured on this machine unloaded: 36–51 ms — about
2× headroom — and it failed consistently once this slice's files were added and the
full suite ran in parallel. I verified the causation honestly by stashing all work
and running the suite at pristine HEAD, where it passed. The test's stated intent
is "the runner honours a timeout parameter and a quick command completes"; the
100 ms literal was an unstated assertion about machine speed. The budget is now
15 s and the test asserts the same property.

## 18. Measured Evidence

```text
canonical missions ................. 1  (plus 3 scenario missions)
ObservedState ...................... 1
DesiredState ....................... 1
StateDelta ......................... 1
exact approvals .................... 1
simulated connector side effects ... 1
independent verifications .......... 1
verified terminal outcomes ......... 1
ValueObservations .................. 1

real external writes ............... 0
duplicate simulated writes ......... 0
blind retries ...................... 0
second mission stores .............. 0
second authority systems ........... 0
model self-verification ............ 0

provider calls ..................... 0
provider cost ...................... 0 micros
connector writes ................... 1 (happy path), 1 (ambiguous window)
reconciliation calls ............... 1
verification calls ................. 1
restarts ........................... 4
stale conflicts detected ........... 2
approval refusals .................. 1
```

`real external writes = 0` is structural: the fabric's entire tool surface is a
closed set of 11 named local operations, asserted in step 18 to contain no
network, shell, or process tool. There is no mechanism to reach a real system.

## 19. Git / Worktree Truth

Commits are recorded in the commit messages themselves; this artifact ships inside
the Operator commit and therefore cannot contain its own SHA. Runtime commit is
cited in §2 of that commit's message. All three worktrees are clean at completion,
and the Loop Governor is byte-identical at `60cb42a`.

## 20. Push Status

**Nothing was pushed.** Neither branch exists on its remote.

## 21. Remaining Limitations

1. **"Restart" is a new service instance over the same durable files**, not an OS
   process kill. A fresh SQLite handle and a fresh connector handle hold nothing
   in memory from before, which is what durable-state recovery is measured
   against — but the CSI proof's real `kill`/respawn is stronger evidence, and
   this proof does not claim it.
2. **The proof runs in-process**, so it does not exercise the HTTP surface. The
   read route `GET /api/os/missions/:id/exception` is implemented and typechecked
   but is proven only by unit-level coverage, not by the focused proof.
3. **The connector is simulated**, and its idempotency and pre-state semantics are
   the ones *it* declares. A real system's guarantees will differ, which is
   precisely what P0-B must establish before trusting them.
4. **`unknown_requires_human` is projected but never observed terminally** in this
   proof; the ambiguous mission recovers to `completed_verified`.
5. **The intent hash changed** for every mission kind, because `missionKind` and
   `exceptionContract` now bind the intent. Nothing is deployed and no branch is
   pushed, so there is no migration concern — but historical plan ids in earlier
   result artifacts will not reproduce against this code.

## 22. Recommended Next Slice

**CHANTER OS — Operational Exception Shadow Connector Binding P0-B**, as the brief
recommends: bind a real read-only/shadow operational source, still performing zero
real external writes. Limitation 3 above is the reason it is the right next step —
the contract is proven; what is unproven is whether a real system's idempotency
and revision semantics can satisfy it.

Before that, two smaller items worth folding in: exercise the HTTP surface in the
focused proof (limitation 2), and drive one scenario to a terminal
`unknown_requires_human` (limitation 4).

## 23. Final Status Line

```text
CHANTER OS OPERATIONAL EXCEPTION MISSION: PASS — 18/18 steps x3 runs; 1 canonical mission
observed -> desired -> delta -> approved -> 1 simulated connector write -> independently
verified -> completed_verified; real external writes 0, duplicate writes 0, blind retries 0,
provider calls 0; validate:os 14/14, backend 1003/1003, runtime 684/684, Governor 0 lines.
```
