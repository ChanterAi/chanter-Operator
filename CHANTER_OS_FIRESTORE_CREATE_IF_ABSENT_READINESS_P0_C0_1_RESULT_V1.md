# CHANTER OS — Firestore Create-if-Absent Precondition and Readiness Eligibility P0-C0.1 — Result V1

## 1. Verdict

**CHANTER OS REAL-WRITE READINESS: READY_FOR_ONE_REAL_WRITE**

```text
real external writes ..... 0
mutation calls ........... 0
candidates evaluated ..... 5
eligible candidates ...... 1 (sandbox Firestore document)
production candidates .... 4, all still rejected
write execution .......... disabled everywhere
```

The gate was not weakened to get here. Two rules that previously rejected the
Firestore candidate — `weak_revision_semantics` and `no_write_authority` — are
now satisfied by facts about the world rather than by changes to the rules:
a dedicated sandbox project exists, and a create's exact pre-state became
expressible.

## 2. The Model Gap, and Why It Was Not Closed With a String

P0-C0 asked every candidate for a revision value. That quietly assumed every
write mutates something that already exists. A `document.create` has no prior
`updateTime`, so the record could only say `null`, and the gate read that —
correctly — as having no exact pre-state.

Two shortcuts were available and both were refused:

| Shortcut | Why refused |
| --- | --- |
| Invent a revision string for the create | The record would state something untrue about the world. |
| Let `null` mean "absent" | Absence would be inferred, not declared — invisible to a human reviewing an approval. |

The correct pre-state for a create is that the object is **absent**, and Firestore
binds that exactly, server-side, with `currentDocument.exists=false`. So the
model gained a typed union:

```ts
PreStateCondition =
  | { kind: "revision"; revisionType: PreconditionRevisionType; revisionValue: string }
  | { kind: "exists";   expected: false; enforcedBy: string }
```

`expected` is the literal `false`, not `boolean`. A "must already exist"
precondition is a revision condition wearing an existence check's clothes — it
would let a caller bind an approval to *something* being there without saying
which version. The literal makes that unrepresentable.

`enforcedBy` is required and must be non-empty. Absence checked by the client
before calling is not a precondition; it is a race, and the window between the
read and the write is exactly where a duplicate gets in.

## 3. Schema Version

Bumped `chanter.real-write-readiness.v1` → **`v2`**, along with all three hash
domains. Every hash in the module changed shape, and an approval compiled against
v1 must not appear to survive the migration.

## 4. Candidate Inventory — 5 Records, 1 Eligible

| Candidate | Env | Pre-state | Verdict |
| --- | --- | --- | --- |
| `connector.git.remote-ref.v1` `ref.update` | production | `revision(content_hash)` | rejected: `no_compensation`, `blast_radius_unbounded`, `no_write_authority` |
| `connector.git.remote-ref.v1` `ref.create` | production | `exists(false)` | rejected: `no_write_authority` |
| `connector.firestore.document.v1` `document.create` | production | `exists(false)` | rejected: `no_write_authority` |
| **`connector.firestore.document.v1` `document.create`** | **sandbox** | **`exists(false)`** | **ELIGIBLE** |
| `connector.cloudinary.asset.v1` `asset.upload` | production | `exists(false)` | rejected: `blast_radius_unbounded`, `no_write_authority` |

Eligible record's hash: `38f30a183750be5b79816af5cc69f8c660cf17b85c894292416315538dfda3f4`

The production Firestore document was **kept, not deleted**. It is mechanically
identical to the eligible record and still refused, which is the point: it proves
eligibility followed the environment and the authority rather than being quietly
granted to production along the way. An inventory that lists only what it
approves of cannot demonstrate that it refuses anything.

## 5. The Provisioned Target

```text
project ......... chanter-os-sandbox (number 351074813259)
database ........ (default), FIRESTORE_NATIVE, STANDARD, nam5
namespace ....... chanter_os_real_write_p0
object id ....... deriveDeterministicObjectId({ missionId, actionId })
credential ...... chanter-os-p0c@chanter-os-sandbox.iam.gserviceaccount.com
role ............ roles/datastore.user on this project — its only binding anywhere
```

Shares no credential, collection, or blast radius with `chanter-site`,
AutoPoster, Cloudinary, or production git. The credential can perform document
CRUD in one project and nothing else anywhere — no database, index, or rules
administration.

## 6. Idempotency — Stated at Its Real Level

`deterministic_identity`, explicitly **not** `native_key`.

Firestore accepts no caller-supplied idempotency key. What it offers is
object-identity plus precondition idempotency: the document id is derived from
mission and action identity, so a replay addresses the same document, and
`currentDocument.exists=false` means the second attempt is refused with
`ALREADY_EXISTS` rather than silently absorbed as a duplicate-free no-op.

Claiming request-level idempotency would overstate the guarantee by exactly the
amount that matters during a retry storm.

The id derivation uses a NUL domain separator, so mission `ab` + action `c`
cannot collide with mission `a` + action `bc`.

## 7. Compensation Contract

The plan hash now binds all eight facts §7 requires: connector, system,
container, object path, create payload hash, revision-acquisition rule,
conditional-delete semantics, and verification oracle. Seven separate mutations
of those fields were each proven to change the hash.

The rule that carries the weight:

```text
the delete's revision comes from an independent re-read
NOT from the create call's own reported updateTime
```

That is the "a write's own report is not evidence" rule applied to the rollback.

## 8. Unknown-Outcome Reconciliation

A lost create response is not a failure. Represented as a typed policy with a
new rejection reason, `unknown_outcome_not_reconcilable`, which fires unless the
resolution is `independent_read_of_exact_object` **and** all four branches are
answered:

| Read result | Consequence |
| --- | --- |
| absent | not observed to land; retry only under explicit policy |
| present, payload matches | already applied; do not repeat |
| present, payload differs | conflict; escalate to a human, never overwrite |
| read unavailable | still unknown; no blind retry |

"Read it back" is not a policy until the read failing also has an answer.

## 9. Proofs

```text
readiness gate ......... 43/43 passed (was 21/21)
Operator backend suite .. 41 files, 1047/1047 passed (baseline 1025, +22 added)
src typecheck ........... 0 errors
build ................... clean; dist rebuilt so it agrees with src
sandbox namespace ....... 0 documents
```

Every §10 proof is covered, including: create-if-absent accepted as an exact
pre-state; absence never represented as revision data; a changed pre-state
invalidating both eligibility and approval; the sandbox candidate losing
eligibility the moment either environmental fact is withdrawn; production
remaining rejected; one logical create effect for a replayed action; the
compensation requiring an exact post-create revision; unknown outcomes
reconciling by read; and write execution remaining disabled.

One test deserves singling out: swapping a real server-side precondition for a
client-side check — prose that reads almost identically — changes the approval
candidate hash. The binding is to the mechanism, not the description.

## 10. Safety

```text
real external writes by this task .... 0
repositories pushed ................. 0
production systems contacted ........ 0
credentials committed or logged ..... 0
write execution path ................ still disabled
```

The gate remains structurally incapable of writing: its export surface is
evaluation, compilation, and hashing, and no export names an action. The
now-eligible sandbox record is still `writeEnabled: false` with
`humanApprovalRequired: true` — becoming eligible is a statement about safety,
not a grant of permission.

## 11. Next Slice

```text
CHANTER OS — Bounded Human-Approved Firestore Sandbox Write P0-C
```

At most one bounded logical mutation against the disposable sandbox object, with
explicit compensation and independent verification.
