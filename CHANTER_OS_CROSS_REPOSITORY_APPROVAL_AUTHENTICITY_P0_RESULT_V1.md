# CHANTER OS — Cross-Repository Approval Authenticity P0 — Result V1

**Verdict: PASS**

Date: 2026-08-02. Local only. Nothing pushed, merged, deployed, or published.

---

## 1. Summary

Persisted approval authority already proved an approval observation was immutable,
content-addressed, mission-bound, checkpoint-bound, repository-bound, and temporally live. It
could not prove **who wrote it**. Any process able to write the approval state directory could
author a structurally perfect observation and the Runtime would honour it.

That boundary is now closed with Ed25519 signatures. Operator issues; the Agent Runtime
verifies against an explicitly configured trust store and holds **public keys only** — it can
check a signature but cannot forge one.

The headline proof is direct: a process with full write access to the durable approval state
directory, holding no signing key, authors a correctly hashed and correctly bound approval and
reaches **zero adapter starts**.

Both repositories changed. Loop Governor and AutoPoster did not.

---

## 2. Repositories

| Repository | Branch | Start HEAD | End HEAD | Working tree at end |
| --- | --- | --- | --- | --- |
| `apps/chanter-agent-runtime` | `os/persisted-approval-checkpoint-authority-p0-0` | `61aaefa` | one commit whose parent is `61aaefa` | clean (4 pre-existing untracked result `.md` files) |
| `apps/chanter-Operator` | `os/persisted-approval-authority-consumer-migration-p0` | `066ecf6` | one commit whose parent is `066ecf6` | clean |
| `apps/chanter-loop.governor` | `governor/native-task-bound-validation-p0` | `cc115c2` | `cc115c2` | unchanged, clean |
| `apps/chanter-auto-poster` | `main` | `72614fb` | `72614fb` | unchanged (pre-existing untracked log) |

Each ending HEAD is the single commit this task added. Its own SHA is not quoted here because
this artifact is committed *inside* that commit; verify with `git log --oneline -1` in each
repository.

---

## 3. Trust-boundary inventory

### 3.1 Writers and readers of approval authority (before this task)

| Surface | Role |
| --- | --- |
| `createRuntimeApprovalObservation` (Runtime) | The only observation constructor |
| `persistApprovalObservation` (durable store) | The only persistence path; immutable hard-link publication |
| Operator `persistedApprovalAuthority.publishApproval` | The only production caller that publishes an approval |
| Runtime test fixtures + workers | Authored observations directly — **bypassing the issuer boundary** |
| `executeMission` pre-claim + pre-adapter guard | The only readers that authorize |
| Anything with filesystem write access to `stateDir` | **Could author authority. This was the defect.** |

### 3.2 What did not exist

There was **no** signing, MAC, key-ID, certificate, JWT, service-identity, or secret-rotation
primitive in either repository. `node:crypto` was used only for `createHash` and `randomUUID`.
Operator's capability tokens are shared bearer secrets guarding HTTP endpoints; they never reach
the Runtime and carry no issuer identity. So this task had to introduce the mechanism rather
than adopt one — reported as an inventory finding, not assumed.

### 3.3 Answers to the Phase-1 questions

| Question | Answer from repository truth |
| --- | --- |
| Canonical issuer? | **Operator** — it owns the human approval decision and is the only production publisher. |
| Canonical verifier? | **Agent Runtime** — it already owns the final pre-adapter authorization decision. |
| One Operator issuer or several? | The contract supports many issuers and many keys per issuer; a deployment may run one or several. |
| Authenticity scope? | `approvalPolicyId`, which the checkpoint and observation already bind. No new identity dimension was invented. |
| Can the Runtime consume a stable public identity? | Yes — `issuerAuthorityId` + `issuerKeyId`, configured explicitly. |
| Existing CHANTER signing primitive to reuse? | **None** (§3.2). |
| Must legacy unsigned observations stay readable? | Yes, and they do — parseable for diagnostics, never authorizing. |
| Rotation vs live approvals? | Explicit key ids; an old approval stays verifiable while its key is trusted, and is refused once removed. Never reinterpreted under a new key. |
| Revocation representation? | Removal of the key id from the issuer's trusted key list. |
| Fixtures bypassing the issuer boundary? | The Runtime harness, both cross-process workers, and four direct observation builders — **all migrated to sign for real**. |

---

## 4. Threat model

**Closed by this task.** A process that can read and write the approval state directory — a
compromised sidecar, a mis-scoped backup or sync agent, another tenant on the host, a careless
operator with a shell — cannot cause execution. It can write bytes; it cannot produce a
signature, so the Runtime refuses before `adapter_started`.

**Explicitly not closed, and stated plainly:**

- A compromised **Operator process** holds the signing key by design and can issue approvals.
  This contract does not defend against that; it moves the boundary from "can write a
  directory" to "holds the private key".
- Anyone who can read the private key file can issue. Its protection is filesystem permissions
  (`0o600`), which is why the key lives in a file rather than an environment variable.
- The Runtime's in-process trust configuration is supplied by its host. A compromised host can
  substitute it — the same boundary as above, not a new one.

The property being claimed is exactly: **possession of approval-state-directory write access is
insufficient to authorize execution.**

---

## 5. Alternatives evaluated

| Option | Verdict |
| --- | --- |
| **Ed25519 asymmetric signature** | **Chosen.** Operator can issue; the Runtime and every other verifier can check but cannot forge. Built into `node:crypto`, so no dependency. Deterministic, so concurrent signing needs no nonce and cannot leak a key through nonce reuse. |
| Keyed MAC (HMAC) with a shared secret | Rejected. Every verifier would hold forging capability — the Runtime could mint the approvals it is supposed to police, which defeats the purpose of an independent verifier. |
| Existing CHANTER service identity | Not available (§3.2). |
| Existing authenticated envelope (JWT etc.) | Not available, and would add a dependency plus a second canonical serialization for no gain over signing the existing hash. |
| Trust-on-first-use | Rejected outright. It is not a canonical CHANTER contract, and it would make "holds a key" equal "is trusted", which is the defect wearing a cryptographic costume. |

---

## 6. Canonical authenticated payload

The signature is taken over **`observationHash` plus issuer identity**, not a hand-listed field
set:

```
"chanter-runtime-approval-authenticity-ed25519-v1" \n
scheme \n
issuerAuthorityId \n
issuerKeyId \n
observationHash
```

**Transitive binding, stated exactly.** `observationHash` is
`sha256("chanter-runtime-approval-observation-v1\n" + canonicalJson(observation-without-hash))`,
whose material is every semantic field of the observation: `schemaVersion`,
`approvalRequestId`, `checkpointId`, `missionId`, `operationId`, `action`, `stepId`,
`repositoryId`, `expectedHead`, `approvalPolicyId`, `status`, `approverId`, `note`,
`evidenceReferences`, `checkpointManifestHash`, `observedAt`, and `approvalExpiresAt` when
present. Signing that hash therefore binds all of them, and — through
`checkpointManifestHash` — the entire immutable checkpoint manifest as well.

This is deliberate: a duplicated field list in the signer would silently drift out of sync with
the schema the first time a field is added. Every mutation proof in §11.2 confirms the binding
empirically rather than by assertion.

**Serialization and domain separation.** The signed string is newline-separated and every
component is a constrained token: `scheme` is a fixed literal, the two identities match
`^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$` (no newline possible), and `observationHash` is 64 hex
characters. No two distinct component tuples can produce the same string, so the encoding is
unambiguous. The leading domain constant prevents any cross-protocol reuse of a signature.

**Why the authenticity block is excluded from `observationHash`.** Including it would be
circular — the hash would have to contain the signature computed over the hash. Excluding it is
safe precisely *because* the signature binds the hash: an authenticity block lifted from another
observation verifies against the wrong hash and is refused.

---

## 7. Issuer, trust store, and rotation contracts

Accepted observations carry:

```
authenticity: { scheme, issuerAuthorityId, issuerKeyId, signature }
```

The Runtime's trust store is an explicit list of issuers, each with authorized approval policies
and one or more trusted key ids. Every ambiguity is a construction-time error rather than a
precedence rule: duplicate issuer ids, duplicate key ids, the same key id bound to different
material, non-Ed25519 keys, unparseable keys, and **private key material offered as a public
key** all fail closed before the Runtime can start using it.

**Rotation (proven, §11.5):** add key B alongside A → new approvals sign with B while live
A-signed approvals still verify under their own key id → remove A → A-signed approvals are
refused with `APPROVAL_AUTHENTICITY_KEY_UNKNOWN` and B-signed approvals still verify. An old
approval is never silently reinterpreted under a new key, because the key id is signed.

---

## 8. Configuration surface

**Operator (issuer + trust file):**

```bash
OPERATOR_APPROVAL_AUTHORITY_ISSUER_ID=chanter.operator.production
OPERATOR_APPROVAL_AUTHORITY_SIGNING_KEY_ID=operator-2026-08
OPERATOR_APPROVAL_AUTHORITY_SIGNING_KEY_FILE=/etc/chanter/approval-issuer.key.pem
OPERATOR_APPROVAL_AUTHORITY_TRUSTED_ISSUERS_FILE=/etc/chanter/trusted-approval-issuers.json
```

All four are required together. The signing key is a **file path**, not an inline value, so the
secret stays in permissioned storage and never appears in an environment dump, config snapshot,
or crash report.

**Trust file:**

```json
{ "issuers": [ { "authorityId": "...", "authorizedPolicyIds": ["..."], "keys": [ { "keyId": "...", "publicKey": "-----BEGIN PUBLIC KEY-----\n..." } ] } ] }
```

Trust is a **separate explicit statement** from key possession. It is deliberately not derived
from the signing key.

---

## 9. Files

**chanter-agent-runtime**

| File | Change |
| --- | --- |
| `src/approvalIssuerAuthenticity.ts` | **Added** — scheme, signing material, trust store, verification, refusal taxonomy |
| `src/approvalCheckpointAuthority.ts` | Optional `authenticity` on the observation (excluded from the hash by construction), `attachRuntimeApprovalAuthenticity`, authenticity refusal codes |
| `src/missions.ts` | `approvalTrustStore` option; required for approval-required execution; verification at the pre-claim resume and the authoritative pre-adapter guard |
| `src/index.ts` | Exports |
| `tests/approvalIssuerAuthenticity.test.ts` | **Added** — 13 focused proofs |
| `tests/fixtures/approvalIssuerFixture.ts` | **Added** — disposable per-process Ed25519 issuer |
| `tests/fixtures/approvalAuthorityHarness.ts`, `approvalAuthorityWorker.ts`, `durableMissionProofWorker.ts` | Now sign and verify for real |
| 6 existing test files | Supply the trust store; four hand-built observations now signed |

**chanter-Operator**

| File | Change |
| --- | --- |
| `apps/backend/src/runtimeMissions/approvalIssuer.ts` | **Added** — signing identity and trust-file loading |
| `apps/backend/src/runtimeMissions/persistedApprovalAuthority.ts` | Signs at the single publication point; fails closed on issuer/trust misconfiguration |
| `apps/backend/src/runtimeMissions/autoPosterRuntime.ts`, `src/missions/loopGovernorRuntime.ts` | Pass the trust store to `executeMission` |
| `apps/backend/src/config.ts` | Issuer configuration surface |
| `apps/backend/tests/approval-issuer-authenticity.test.ts` | **Added** — 6 focused proofs |
| `apps/backend/tests/helpers/approvalAuthorityFixture.ts` | Real disposable signing identity + trust file |
| `apps/backend/tests/approval-authority-repository-binding.test.ts`, `tools/.../consumer-migration.integration.test.mts` | Carry a real issuer |

No file was deleted. No existing test was removed, skipped, or weakened.

---

## 10. Typed refusal taxonomy

| Code | Meaning |
| --- | --- |
| `RUNTIME_APPROVAL_AUTHENTICITY_MISSING` | No authenticity block — the state-directory forgery case |
| `RUNTIME_APPROVAL_AUTHENTICITY_MALFORMED` | Block present but structurally invalid |
| `RUNTIME_APPROVAL_AUTHENTICITY_SCHEME_UNSUPPORTED` | Unknown authenticity scheme |
| `RUNTIME_APPROVAL_AUTHENTICITY_ISSUER_UNKNOWN` | Issuer not in the trust store |
| `RUNTIME_APPROVAL_AUTHENTICITY_KEY_UNKNOWN` | Key id unknown or revoked |
| `RUNTIME_APPROVAL_AUTHENTICITY_ISSUER_SCOPE_MISMATCH` | Issuer not authorized for this approval policy |
| `RUNTIME_APPROVAL_AUTHENTICITY_VERIFICATION_FAILED` | Signature did not verify |
| `RUNTIME_APPROVAL_AUTHENTICITY_CONFIGURATION_UNAVAILABLE` | No trust store configured |
| `APPROVAL_AUTHENTICITY_CONFIGURATION_INVALID` | Trust store rejected at construction |
| `OPERATOR_APPROVAL_ISSUER_NOT_CONFIGURED` / `_KEY_UNREADABLE` / `_KEY_INVALID` / `_CONFIGURATION_INVALID` | Operator-side issuer problems |

Each authenticity refusal is also a content-addressed `authority_refused` evidence record with
the same code, so the guard decision is durable and inspectable.

**One honest ordering note:** every *trust-store* misconfiguration surfaces as the Runtime's
`RUNTIME_APPROVAL_AUTHENTICITY_CONFIGURATION_UNAVAILABLE`, because the Runtime checks its own
prerequisite before Operator publishes anything. Operator's `OPERATOR_APPROVAL_TRUST_STORE_*`
codes are therefore defence-in-depth for direct seam callers rather than the path a deployment
will see. The tests assert the observed behaviour, not the behaviour I first assumed.

---

## 11. Proofs

Adapter entries are counted at the adapter and, in the integration proof, from the durable run
ledger — measured, not inferred.

### 11.1 Core acceptance

| Scenario | adapter starts | Result |
| --- | --- | --- |
| Valid authentic approval, known issuer + key | **1** | PASS — signature, issuer id, key id, and scheme persisted with the observation; the accepting guard decision is content-addressed evidence bound to the same `observationHash` |
| Missing authenticity | 0 | PASS — `APPROVAL_AUTHENTICITY_MISSING` |
| Unknown issuer (correctly formed signature) | 0 | PASS — `APPROVAL_AUTHENTICITY_ISSUER_UNKNOWN` |
| Unknown / revoked key id | 0 | PASS — `APPROVAL_AUTHENTICITY_KEY_UNKNOWN` |
| One-byte signature mutation | 0 | PASS — `APPROVAL_AUTHENTICITY_VERIFICATION_FAILED` |
| Unsupported scheme | 0 | PASS — `APPROVAL_AUTHENTICITY_SCHEME_UNSUPPORTED` |
| Issuer outside its authorized policy | 0 | PASS — `APPROVAL_AUTHENTICITY_ISSUER_SCOPE_MISMATCH` |
| No trust store configured | 0 | PASS — `RUNTIME_APPROVAL_AUTHENTICITY_CONFIGURATION_UNAVAILABLE` |

### 11.2 State-directory forgery — the defect that motivated this task

A second durable store instance on the **same state directory**, with no signing key, reads the
published checkpoint and authors a structurally perfect, correctly hashed, correctly
checkpoint-bound `approved` observation, then publishes it immutably.

Result: **`APPROVAL_AUTHENTICITY_MISSING`, adapter starts = 0.** Proven at the Runtime level and
again through the real Operator service path. Write access to durable approval state is no
longer authority.

### 11.3 Tamper matrix — every case zero adapter starts

Each mutation changes a semantic field, which changes `observationHash`, which the signature
covers; re-signing is impossible without the key, so carrying the original signature over is the
strongest available attack.

approval decision · `approvedBy` · observation time · expiry · mission id · checkpoint id ·
manifest hash · repository binding · expected HEAD · policy id — all
`APPROVAL_AUTHENTICITY_VERIFICATION_FAILED`. Issuer id and key id are signed alongside the hash,
so relabelling them is refused as an unknown issuer or unknown key rather than accepted.
Signature bytes: refused. Malformed blocks (extra field, missing field, short signature,
non-canonical base64, null, array) are rejected before attachment.

### 11.4 Cross-binding replay

A genuinely signed observation from mission A cannot authorize mission B: the durable store
refuses to publish it against B's checkpoint, and the guard refuses it. Adapter starts stayed at
**1** — the one legitimate execution of mission A. Checkpoint, repository, HEAD, and policy
binding remain the existing Runtime contracts and were not duplicated.

### 11.5 Rotation

Key A trusted → A-signed approval verifies. Add key B → both verify, each under its own key id.
Remove A → A-signed refused with `APPROVAL_AUTHENTICITY_KEY_UNKNOWN`, B-signed still verifies.
No live approval was reinterpreted under a different key.

### 11.6 Restart, expiry, duplicate resume

Restart between an authentic approval and execution: resumes and executes **exactly once**, with
the **byte-identical signature** — nothing is re-signed or re-authored. Duplicate resume stays at
one adapter start. An authentic but expired approval is refused with `RUNTIME_APPROVAL_EXPIRED`
and zero adapter starts, while the observation itself still verifies — authenticity never
overrides temporal refusal.

### 11.7 Concurrency

Ed25519 is deterministic: two concurrent issuers signing identical material produce identical
signatures. There is no nonce to reuse, no ambiguous issuer state, and no way for two signers to
disagree. Proven by asserting signature equality across repeated signings.

### 11.8 Configuration failure matrix — all fail closed

Runtime trust store: no issuers · issuer without an authority id · issuer without policies ·
issuer without keys · duplicate issuer ids · duplicate key ids with different material ·
malformed public key · **private key supplied as public** · non-Ed25519 key · non-canonical key
id · non-canonical policy id.

Operator issuer: no signing identity · no trusted issuers · unreadable key file · relative key
path · non-canonical issuer id · malformed trust file · trust file without issuers · trust file
containing a private key · trust file with duplicate key ids.

Every case asserts the error message does **not** match `/PRIVATE KEY|BEGIN [A-Z ]*KEY/`.

### 11.9 Secrets handling

No private key appears in source, committed fixtures, artifacts, logs, hashes, or error
messages. Test keys are generated per process into temp files at mode `0o600` and deleted.
Private material is never written into an observation, evidence record, or the approval state
directory — asserted directly (`expect(JSON.stringify(observation)).not.toMatch(/PRIVATE KEY/)`),
and the trust store refuses private material outright.

---

## 12. Validation

| Command | Exit | Result |
| --- | --- | --- |
| Runtime `npm run typecheck` | 0 | PASS |
| Runtime `npm run build` | 0 | PASS |
| Runtime `npm test` | 0 | **553 tests, 124 suites, 553 passed, 0 failed, 0 skipped, 0 todo** |
| Runtime `git diff --check` | 0 | PASS |
| Operator `npm run typecheck --workspace @chanter/operator-backend` | 0 | PASS |
| Operator `npm run build --workspace @chanter/operator-backend` | 0 | PASS |
| Operator `npm test` | 0 | backend **903 passed (903)**, 35 files; frontend **133 passed (133)**, 7 files |
| Operator `git diff --check` | 0 | PASS |

Lower bounds met and exceeded: Runtime 540 → **553** (+13, exactly the new suite); Operator
backend 897 → **903** (+6, exactly the new suite); frontend 133 → **133**. Nothing disappeared,
became skipped, or weakened.

**Runtime focused authenticity ×3:** exit 0, 0, 0 (13/13 each).
**Operator focused authenticity ×3:** exit 0, 0, 0 (6/6 each).
**Cross-repository integration proof ×3:** exit 0, 0, 0 (7/7 each).
**Repository-binding suite re-run ×3 (required after the prior unexplained red run):** exit 0,
0, 0 (10/10 each). No red run occurred; the §11.9 anomaly of the previous task did not recur.

### 12.1 An honest note on the existing Runtime suite

Introducing the requirement broke **83 of 540** Runtime tests, because the fixtures and both
cross-process workers had been authoring observations directly — exactly the bypass this task
closes. They were migrated to hold a real per-process Ed25519 key and sign the way Operator
does. Every pre-existing approval proof now runs **through** the issuer boundary rather than
around it, which strengthens the existing suite rather than merely restoring it.

---

## 13. Evidence and observability

| Question | Answered by |
| --- | --- |
| Who issued this approval? | `observation.authenticity.issuerAuthorityId`, persisted immutably |
| Which key verified it? | `observation.authenticity.issuerKeyId` |
| Which scheme/version? | `observation.authenticity.scheme` |
| Which payload hash was authenticated? | `observation.observationHash`, also carried in the authority evidence and the run ledger |
| Which guard decision accepted or refused it? | The content-addressed `authority_accepted` / `authority_refused` evidence record, whose `evidenceHash` is in the run ledger |
| When was it verified? | The `approval_authority_accepted` run-ledger event |

No schema expansion was needed: because the authenticity block is part of the immutably
persisted observation and the observation hash is already bound into the evidence and replay
binding, the existing evidence chain answers every question. Private material is never persisted.

---

## 14. External side effects

**None.** No push, merge, deploy, publication, production key generation or rotation, production
mutation, credential exposure, or real AutoPoster network call. All keys, trust files, state
directories, repositories, and adapters were disposable local fixtures.

---

## 15. Breaking changes

1. **`executeMission` now requires `approvalTrustStore` for every approval-required action.**
   Without it: `RUNTIME_APPROVAL_AUTHENTICITY_CONFIGURATION_UNAVAILABLE`. This is a breaking
   change for any caller of the Runtime library.
2. **An unsigned approval observation can no longer authorize execution.** Legacy unsigned
   observations remain parseable for diagnostics and migration; they never authorize. There is
   no fallback, development mode, environment flag, or unsigned recovery path.
3. **Operator requires the four issuer environment variables** for approval-required execution.

---

## 16. Remaining risks

1. **A compromised Operator process can issue approvals.** By design (§4). Defences are
   filesystem permissions on the key and, if wanted later, an HSM or external signer.
2. **The trust store is supplied in-process by the Runtime's host.** A compromised host can
   substitute it. Same boundary as risk 1, not a new one.
3. **No revocation list or key expiry beyond removal from the trust file.** Revocation is
   editing that file plus a restart; there is no live revocation feed. Sufficient for P0,
   explicitly bounded here.
4. **Rotation is operator-driven**, with no automated key lifecycle.
5. **`tools/resilience-evidence/cross-process-replay.mjs` remains unmigrated** and fails closed.
   Migrating it was not the smallest required proof of this contract — the two focused suites and
   the cross-repository proof already exercise the real issuer boundary end to end. What that
   dedicated task still needs: replace its transient approval with a persisted, signed
   observation from a disposable issuer, supply a trust store, and re-verify its cross-process
   replay assertions.
6. **Inherited and unchanged:** the guarantee boundary is the pre-adapter decision point, not the
   whole adapter interval; submodules and replacement refs remain unsupported; authority-checkout
   retention is deliberately unbounded.

---

## 17. Rollback

```bash
git -C apps/chanter-agent-runtime reset --hard 61aaefa
git -C apps/chanter-Operator reset --hard 066ecf6
```

Roll back **both** or neither: an Operator that signs against a Runtime that ignores signatures
is merely redundant, but a Runtime that requires signatures with an Operator that does not sign
leaves every approval fail-closed. After rollback, remove the four Operator issuer environment
variables. Signed observations already published remain readable; their `authenticity` block is
simply ignored by the older Runtime.

---

## 18. Review and merge readiness

| Repository | Safe to review | Notes |
| --- | --- | --- |
| chanter-agent-runtime | **Yes** | One bounded commit on `61aaefa`; 553/553; typecheck, build, diff-check clean |
| chanter-Operator | **Yes** | One bounded commit on `066ecf6`; 903/903 + 133/133; typecheck, build, diff-check clean |
| chanter-loop.governor | **Yes (no change)** | Untouched |
| chanter-auto-poster | **Yes (no change)** | Untouched |

**Safe to merge: yes, as a pair.** Reviewers should confirm three things: the two commits ship
together (§17); the deployment provisions an Ed25519 key file and a trust file before enabling
approval-required execution; and the threat model in §4 matches what the deployment expects,
since this closes the state-directory boundary, not a compromised-Operator boundary.

---

## 19. Does final canonical CHANTER OS E2E closure remain blocked?

**Yes, by less.** Cross-repository approval authenticity — the item the previous two artifacts
both listed first — is closed.

Still open:

1. **Evidence-tool migration** — `tools/resilience-evidence/cross-process-replay.mjs` (§16.5).
2. **Reachability-aware authority-checkout garbage collection** — retention is unbounded at P0.
3. **Unresolved-claim reconciliation onto the Runtime reconciler** — currently
   Operator-evidence-bound.
4. **Key lifecycle operations** — rotation is manual and revocation requires a restart (§16.3–4).

---

## 20. Verdict

**PASS.**

- Possession of approval-state-directory write access is now demonstrably insufficient to
  authorize execution: the forgery proof reaches zero adapter starts.
- The Runtime verifies independently, holding public keys only, and cannot forge what it checks.
- The signed payload binds every authority-relevant field transitively through `observationHash`,
  with a deterministic, domain-separated, unambiguous encoding.
- Forged, unsigned, tampered, replayed, unknown, revoked, expired, out-of-scope, and
  ambiguously configured authority all produce `adapter_started == 0` with typed durable
  evidence and no downgrade path.
- Runtime 553/553; Operator 903/903 + 133/133; focused suites 13/13 and 6/6 three times each;
  cross-repository proof 7/7 three times; repository-binding suite 10/10 three times. Every run
  exited 0.
