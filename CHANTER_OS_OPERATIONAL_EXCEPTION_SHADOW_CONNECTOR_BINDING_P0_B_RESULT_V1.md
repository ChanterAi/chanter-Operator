# CHANTER OS — Operational Exception Shadow Connector Binding P0-B — Result V1

## 1. Verdict

**PASS.** The proven operational-exception contract is bound to **one real
external system** in read-only shadow mode.

```
npm run os:shadow-connector
```

returned **PASS (16/16 steps)** on three consecutive runs, and the canonical gate
`validate:os` returned **PASS 15/15** with the new proof wired in as stage 14.

```text
real external writes = 0
mutation calls       = 0   (only `git ls-remote` was ever spawned)
```

## 2. Repository Truth

Preconditions verified from repository truth before any edit. Heads matched the
brief exactly, and all three worktrees were clean:

| Repository | Branch | Start HEAD | End HEAD | Worktree |
| --- | --- | --- | --- | --- |
| `apps/chanter-agent-runtime` | `runtime/billed-external-provider-cost-authority-p0` | `8511038` | `8511038` (**0 lines**) | clean |
| `apps/chanter-Operator` | `os/billed-external-provider-cost-authority-p0` | `4b9ccc6` | see §19 | clean |
| `apps/chanter-loop.governor` | `governor/agentic-plan-governance-p0` | `60cb42a` | `60cb42a` (**0 lines**) | clean |

`CHANTER OS OPERATIONAL EXCEPTION MISSION: PASS` is committed at `4b9ccc6`.
**Agent Runtime needed no change in this slice** — the shadow binding is entirely
plan-authority and connector work.

## 3. Real-System Selection

A read-only capability inventory was performed against §4's priority order.

| Priority | Candidate | Finding |
| --- | --- | --- |
| 1 — Solar PV / inverter | none | No integration exists. A codebase-wide search for solar/inverter/PV/Enphase/SolarEdge/Fronius/Modbus returned only Python-venv noise (numpy, pip, pygments). |
| 2 — HVAC / electrical | none | Same search, same result. No thermostat, BACnet, Tuya, or Shelly integration. |
| 3 — CHANTER-connected SaaS | **GitHub git remote — SELECTED** | Three real remotes, all readable, exit 0. |
| 3 — alternative | Cloudinary, Firebase/Firestore | Reachable but **deliberately not selected** — see below. |
| 3 — alternative | TikTok / YouTube | Only OAuth *client* credentials are present; user access tokens live encrypted in Firestore. No read is possible without them. |

**Selected:** `connector.git.remote-ref.v1` — the ref state of
`https://github.com/ChanterAi/chanter-Operator.git`, read through `git ls-remote`.

It satisfies every §4 requirement, and satisfies the hardest one unusually well:

- **real external state** — GitHub's authoritative ref database;
- **read-only API** — `ls-remote` is the smart-HTTP ref advertisement;
- **stable object identity** — `<remote-url>#<ref-path>`;
- **revision evidence** — the commit SHA is **content-addressed**. Most systems
  offer a counter or an `updated_at` that can repeat, drift, or lie; a git SHA
  cannot name two different states;
- **no write required**, **independent re-read possible**, and no user data.

The exception is real rather than invented: every CHANTER P0 ends with reviewed
work committed locally and **not** pushed, so "the remote does not carry the
reviewed HEAD" is this system's actual standing condition. The action that would
resolve it is a ref update — exactly the real external write P0-C must gate.

**Why not Cloudinary or Firebase.** Both are reachable, and both are AutoPoster's
**production** credentials for a live product holding real user data. The
billed-provider P0 established the precedent that a production credential
belonging to another product is the founder's to authorize, not mine to infer —
and reading real user records into a new durable store is exactly the kind of
thing that deserves that decision. GitHub avoids the question entirely, exposes
no user data, and has stronger revision semantics.

**No credential was fabricated.** Git's existing credential helper was used
read-only; nothing was created, rotated, or stored.

## 4. Connector Capability Manifest

```text
connector_id                 connector.git.remote-ref.v1
system_type                  git_remote
environment                  real_read_only
read_capabilities            ["ref.read"]
write_capabilities_declared  ["ref.update"]
write_capabilities_enabled   false
revision_semantics           content-addressed commit SHA; one SHA never names two states
freshness_semantics          re-read the ref advertisement; equal SHA proves the state holds
idempotency_semantics        compare-and-swap against an expected old SHA (not exercised)
reconciliation_semantics     read_ref_and_compare_sha
verification_semantics       independent_read_only_reread
capabilities                 []            <- performs none
writable_fields              ["commitSha"] <- what a ref update *would* change
real_external_writes         false
```

`write_capabilities_declared` and `write_capabilities_enabled` are separate
fields because they are separate facts: "this system has no such operation" and
"this connector may not perform it" imply completely different designs, and
collapsing them would make a read-only binding look like a system nobody can
change.

## 5. Real ObservedState

Built only from real read-only data:

```text
connector_id         connector.git.remote-ref.v1
external_object_id   https://github.com/ChanterAi/chanter-Operator.git#refs/heads/master
source_revision      55c0f09025c560846ef5d28636dcc2e24e9e25b3
observation_hash     938f89c4a229c76d48448ba88cb424197c831e19428a0623d78ce8e0e2bf4d88
observed_fields      { refPath, commitSha }
```

**Same external revision → same normalized state hash**, measured (step 2)
rather than asserted: two independent reads of the unmoved ref produced identical
64-character digests.

**Mission identity does not contaminate the state hash.** `missionId` is excluded
from `createObservationHash` — a fix carried over from the predecessor slice,
where including it made the connector's own view of a record permanently
incomparable with the mission's. `missionId` still binds the surrounding
ObservedState record, so §6 is met by the record rather than by the digest.

## 6. Revision / Freshness Semantics

The contract this system actually offers, and how it is enforced:

- The commit SHA **is** the revision. There is no separate version counter that
  could drift from the content.
- Before compiling the action, node X1 **re-reads** the remote and compares
  against the intake observation.
- A changed SHA invalidates the delta and the contract: no action compiles, no
  approval is offered, no write is reachable (step 13, measured against an
  injected concurrent push).

## 7. DesiredState and StateDelta

One bounded, hypothetical-but-typed desired state, as §8 permits:

```text
desired    commitSha = 4b9ccc6266af5e85b14c5fe2abda265d5d7808ab   (the reviewed local HEAD)
observed   commitSha = 55c0f09025c560846ef5d28636dcc2e24e9e25b3
delta      exactly 1 change, on exactly 1 field: commitSha
```

Machine-verifiable (one `equals` constraint), human-understandable (a commit a
person can inspect), and non-destructive (nothing is proposed to be deleted). No
model claim participates: this plan routes nothing to a model, measured at
`providerCalls: 0`.

## 8. Shadow ActionContract

```text
action_contract_hash   55ee01bb206821a9453527cb511221d57c6d96b449311458c6c41893d8461cc9
idempotency_key        shadow-1:84fe3e62f553693d8c22c11971347719:a7eb58068c3533fca79b65aaca31c98b
capability             ref.update
external_object_id     …/chanter-Operator.git#refs/heads/master
expected_pre_state     55c0f09025c560846ef5d28636dcc2e24e9e25b3
```

The contract exists in full and its execution capability does not. Recorded by
node X4:

```text
would_execute            ref.update
would_target             …/chanter-Operator.git#refs/heads/master
would_use                idempotency key above
would_expect_pre_state   55c0f09025c560846ef5d28636dcc2e24e9e25b3
real_external_writes     0
```

Nothing was sent to the real system, and no write response was faked.

## 9. Human Authority

The normal exact-approval binding was exercised, unchanged, against the shadow
contract: **one** approval, bound to the exact candidate bytes, on the same
authority the artifact and live-exception lanes use.

An approval bound to a different action is refused
(`AGENTIC_AUTHORITY_CANDIDATE_MISMATCH`, step 6). A changed target, delta,
revision, or payload all change `actionContractHash`, which is the candidate —
so each is refused by the same single mechanism rather than by four checks.

The approval prompt names what it is: *"one bounded connector action that will be
recorded and deliberately not performed."*

## 10. Write-Safety Proof

The core gate, proven **structurally and observationally** (step 9).

Four independent facts, none of them a runtime check on the write itself:

1. **The connector exposes no `apply` method.** `"apply" in connector === false`,
   asserted. There is nothing to call — not a guard that declines.
2. **The shadow plan compiles no node with a side effect.** Read from the
   committed plan: `X4:shadow_authorize`, never `connector_apply`.
3. **The shadow worker set contains no applying worker.** A shadow mission is
   built without one.
4. **The allowed capability set omits the write.**
   `AGENTIC_SHADOW_EXCEPTION_MISSION_CAPABILITIES` does not contain
   `connector.state.apply`.

Transport telemetry, captured across every connector instance in the run:

```text
git subcommands ever spawned   ["ls-remote"]
transport calls                20 (run 1)
mutating invocations           0   (no push / send-pack / receive-pack / update-ref / fetch / commit / tag)
```

`git` is invoked with an explicit argv and `shell: false`, and a **pre-spawn
allowlist** permits exactly `ls-remote`. That is stronger than inspecting HTTP
verbs after the fact: a mutating call is not merely unobserved, it is
unconstructable.

And the gate that stops a credential from implying authority: a **live** mission
against this connector is refused at intake with
`AGENTIC_CONNECTOR_WRITE_DISABLED` (step 10), before a plan exists to approve.

This does **not** rest on "the source looked unchanged afterward."

## 11. Independent Read-Only Verification

Node X5 re-reads the real source after shadow authorization and judges the shadow
contract — deliberately *not* whether the desired state now holds, which in
shadow mode is always no.

```text
source_readable              true
identity_stable              true
revision_unchanged           true
no_chanter_induced_mutation  true
real_external_writes         0
shadow_verified              true
```

A verifier that only ever read a state nothing could touch would prove little, so
the fail-closed case is exercised too: with an injected concurrent push, the
oracle reports the source moved and readiness is refused (step 13).

## 12. Restart and Replay

- **A. Restart after real observation** (step 11) — new service and connector
  over the same durable file: approval preserved unchanged, revision revalidated
  at the same SHA, **0 duplicate authority**, **0 writes**.
- **B. Restart after shadow approval** (step 11, same restart) — terminal state
  re-reported as `shadow_verified_ready`, source freshness reconciled, **0
  connector writes**.
- **C. Replay of the completed shadow mission** (step 12) — identical submission
  replays; **1** approval event total, **0** additional source reads (intake
  short-circuits on the durable mission), **0** writes.

## 13. Shadow TerminalOutcome

```text
shadow_verified_ready | shadow_stale_reobserve | shadow_blocked | shadow_unknown_requires_human
```

Observed: **`shadow_verified_ready`**, `verified: true`.

Distinct names rather than a flag beside the live terminals, because
`shadow_verified_ready` must never be readable as "the exception was resolved".
Its own reason string says so:

> *"…The external exception is NOT resolved."*

and the proof asserts that sentence is present.

## 14. ValueObservation

```text
executionMode                shadow
real source reads            2      (intake + observe node)
source revisions observed    1
stale observations           0
human approvals              1
shadow actions compiled      1
real external writes         0
verification reads           1
provider calls               0
provider cost                0 micros
time to shadow-ready         6527 ms
state-changing actions       0
duplicate actions            0
```

`realExternalWrites` is typed as the literal `0`, so a non-zero value is a
compile error rather than a number someone has to notice. No savings or ROI is
invented.

## 15. Failure Proofs

| Required failure | Step | Result |
| --- | --- | --- |
| stale / expired source revision | 13 | detected, action never compiled |
| source changed between observation and compilation | 13 | `matchesIntakeObservation: false`, no candidate offered |
| connector reports no revision semantics | 4, 15 | malformed identity and malformed advertisement both refuse |
| credential lacks read authority | 14 | `CONNECTOR_READ_UNAVAILABLE` |
| credential appears write-capable but policy disables writes | 10 | `AGENTIC_CONNECTOR_WRITE_DISABLED` at intake |
| malformed external state | 15 | `CONNECTOR_STATE_MALFORMED` |
| verification re-read unavailable | 14 | read outage fails closed |
| approval mismatch | 6 | `AGENTIC_AUTHORITY_CANDIDATE_MISMATCH` |
| stale concurrent writer | 13 | same path as stale revision |
| transport outside the read allowlist | 16 | refused at the boundary |

Every one leaves `real writes = 0`.

## 16. Files Changed

**Agent Runtime:** none.

**Operator — new:** `agenticGitRefConnector.ts` (the real read-only connector),
`tools/os-shadow-connector/` (the proof), this artifact.

**Operator — modified:** exception contract (execution modes, four shadow
terminals, six shadow measures on the value observation), mission contract
(`executionMode` on the exception intent, `shadow_authorize` node type),
capability registry (`exception.shadow.authorize`, `exception.shadow.verify`,
shadow capability set, manifest fields), plan compiler (shadow blueprint,
mode-aware accessors), intent compiler (mode parsing, mode-aware required
capabilities), workers (two shadow workers, manifest-source fix), mission service
(mode-aware inputs/workers/terminals, two intake gates, terminal-verdict fix),
tool surface (optional write port), simulated connector (manifest extension,
`OperationalConnector`), `schema.ts`, validation stage list, `tsconfig.tools.json`,
`package.json`, and two test files.

## 17. Baseline and Final Validation

Baseline, before any edit: heads as §2, worktrees clean, predecessor artifact
committed.

| Scope | Final |
| --- | --- |
| Agent Runtime `npm test` | **684 / 684** |
| Operator `test:backend` | **1004 / 1004** |
| Operator `test:os-validation` | **20 / 20** |
| Operator `validate:os` | **PASS 15 / 15** |
| `os:shadow-connector` | **PASS 16 / 16**, three runs |
| `os:operational-exception` (predecessor) | **PASS 18 / 18**, preserved |
| Loop Governor | not run — **zero lines changed** |

**No prior test was weakened.** One behavioural change is worth naming: the
exception `executionMode` **defaults to `shadow`**, so a mission that changes a
real system has to ask for it in writing. That made the predecessor proof's
submissions compile a shadow plan, and the honest fix was to have that proof
declare `executionMode: "live"` explicitly — which it now does, and it passes
18/18 unchanged otherwise.

## 18. Measured Evidence

```text
real external sources .............. 1
real external object identities .... 1
real ObservedStates ................ 1
real revision/freshness contracts .. 1
DesiredStates ...................... 1
StateDeltas ........................ 1
exact shadow ActionContracts ....... 1
exact human approvals .............. 1
independent read-only verifications  1
shadow terminal outcomes ........... 1
ValueObservations .................. 1

real external writes ............... 0
mutation HTTP calls ................ 0
duplicate approvals ................ 0
second mission stores .............. 0
second authority systems ........... 0
model self-verification ............ 0

source read count .................. 2   (mission) / 20 transport calls (whole run)
verification read count ............ 1
revision checks .................... 2   (intake + pre-compile re-read)
stale detections ................... 1   (the injected concurrent push)
provider calls ..................... 0
provider cost ...................... 0 micros
restart count ...................... 5
replay count ....................... 1
```

## 19. Git / Worktree Truth

Commits are recorded in the commit messages; this artifact ships inside the
Operator commit and cannot contain its own SHA. Agent Runtime and Loop Governor
are byte-identical to their starting state. All three worktrees are clean.

## 20. Push Status

**Nothing was pushed.** Neither branch exists on its remote — which is, fittingly,
the very exception this proof observed and declined to resolve.

## 21. Remaining Limitations

1. **One source, one shape.** A git remote's revision contract is the strongest
   available; a system with `updated_at` semantics, weak ETags, or eventual
   consistency will stress the freshness contract in ways this does not.
2. **The observed field is metadata, not operational payload.** A commit SHA is
   an unusually clean bounded field. A real invoice or setpoint carries types,
   units, and nulls this fixture never exercises.
3. **`git ls-remote` hides the HTTP layer.** The write-safety proof is at the
   argv boundary, which is why it is an allowlist rather than an observation —
   but no HTTP verb was directly inspected.
4. **Read outage, malformed state, and the moved source are injected** through
   `execImpl`, not produced by the real remote. The connector's *behaviour* under
   them is real; the conditions are simulated, because a real outage is not
   summonable on demand.
5. **`shadow_stale_reobserve` is reachable but was not observed terminally** —
   the stale scenario fails before the oracle runs, so it terminates
   `shadow_blocked`.
6. **Still in-process.** The HTTP route surface is typechecked but not exercised
   by this proof, and "restart" remains a new service instance over the same
   durable files rather than an OS process kill.

## 22. Recommended Next Slice

**CHANTER OS — Bounded Human-Approved Real External Write P0-C**, separately
authorized, performing at most one narrowly scoped real external write with
rollback/compensation/reconciliation defined in advance.

This binding makes the shape of that slice concrete: the compiled contract
already names `ref.update`, the target, the expected pre-state SHA, and a
compare-and-swap idempotency declaration. What P0-C must add is the write path,
the authority to enable it, and — the genuinely hard part, because this connector
declares `compensationSupport: "none"` — a rollback story for an action that has
none. A forced-push is not a compensation.

Worth folding in first: exercise the HTTP surface (limitation 6), and drive one
scenario to a terminal `shadow_stale_reobserve` (limitation 5).

## 23. Final Status Line

```text
CHANTER OS OPERATIONAL EXCEPTION SHADOW CONNECTOR BINDING: PASS — 16/16 steps x3 against a real
GitHub remote; 1 real ObservedState at SHA 55c0f09 with a stable normalized hash, 1 StateDelta on
1 bounded field, 1 exact ref.update ActionContract compiled and never sent, 1 human approval,
1 independent read-only re-read -> shadow_verified_ready; real external writes 0, mutation calls 0,
git subcommands ever spawned ["ls-remote"]; validate:os 15/15, backend 1004/1004, runtime 684/684,
Runtime and Governor 0 lines.
```
