# CHANTER OS — Deployable Approval Authority Repository Binding P0 — Result V1

**Verdict: PASS**

Date: 2026-08-02. Local only. Nothing pushed, merged, deployed, or published.

---

## 1. Summary

`CHANTER_OS_PERSISTED_APPROVAL_AUTHORITY_CONSUMER_MIGRATION_P0_RESULT_V1.md` closed the consumer
migration but left one deployment blocker: the Runtime's canonical clean-state policy
(`tracked_and_untracked`, evaluated with `--ignored=matching`) refuses any checkout containing
`node_modules/`, `dist/`, `.env`, or logs. Binding approval authority directly to a live product
repository therefore left approval-required execution **permanently fail-closed**, and the only
workaround was a manually maintained pristine checkout.

Operator now derives an **isolated per-revision authority checkout** from the configured live
product repository. The Runtime contract is untouched: it still independently decides repository
identity, exact committed HEAD, and clean state, and it is still the only thing that can permit
`adapter_started`.

Proven against a real Git product repository carrying real dirt:

```
live product repository (dirty: node_modules/, dist/, .env, logs, untracked, uncommitted edit)
→ isolated clone at the exact committed HEAD (nothing but tracked content)
→ Runtime repository identity + HEAD + clean state, decided by the Runtime
→ approval checkpoint → persisted observation → pre-adapter guard
→ adapter_started == 1
```

**Agent Runtime, Loop Governor, and AutoPoster required no change.**

---

## 2. Repositories inspected

| Repository | Branch | Start HEAD | End HEAD | Working tree at end |
| --- | --- | --- | --- | --- |
| `apps/chanter-Operator` | `os/persisted-approval-authority-consumer-migration-p0` | `183dbaa` | one commit whose parent is `183dbaa` | clean |
| `apps/chanter-agent-runtime` | `os/persisted-approval-checkpoint-authority-p0-0` | `61aaefa` | `61aaefa` | unchanged (4 pre-existing untracked result `.md` files) |
| `apps/chanter-loop.governor` | `governor/native-task-bound-validation-p0` | `cc115c2` | `cc115c2` | unchanged, clean |
| `apps/chanter-auto-poster` | `main` | `72614fb` | `72614fb` | unchanged (pre-existing untracked `firestore-debug.log`) |

The ending Operator HEAD is the single commit added by this task, parented on `183dbaa`. Its
own SHA is deliberately not quoted here: this artifact is committed *inside* that commit, so no
hash it contains could survive being written. Verify with `git -C apps/chanter-Operator log --oneline -1`.

Neither Operator nor the Runtime had any pre-existing linked worktrees (`git worktree list`
showed only the main checkout in both).

---

## 3. Read-only inventory findings

### 3.1 What the Runtime actually binds

`inspectRuntimeApprovalRepository` (`src/approvalCheckpointAuthority.ts:1665`) derives
`repositoryId` as a domain hash over the canonical repository root, the Git directory, the Git
common directory, the object format, **and the device + inode of all three**. Clean state is
`git status --porcelain=v1 --untracked-files=all --ignored=matching` evaluated against a fresh
HEAD-only index built outside the repository.

Two consequences drove the whole design, both measured rather than assumed:

| Measured fact | Consequence |
| --- | --- |
| A live dirty product repository inspects as `trackedDirty: true, untrackedDirty: true` | The blocker is real and is a policy outcome, not a bug |
| Rebuilding a checkout **at the same path with identical content yields a different `repositoryId`** (`identity stable across rebuild at same path: false`) | A published checkout must be **durable and immutable**; silently rebuilding it revokes every approval bound to it |

### 3.2 Existing CHANTER Git isolation

`apps/chanter-evolution-worker/src/worktree/worktree.js` is the only isolated-Git mechanism in
the workspace. It is **not reusable here**, on three independent grounds:

1. It lives in a different repository (CommonJS JavaScript) and Operator is TypeScript ESM;
2. it is built for a *mutable* worktree — it creates a branch, stages, and commits;
3. it deliberately junctions the target's `node_modules` into the worktree, which under the
   Runtime's `--ignored=matching` policy makes the checkout **dirty by construction**.

Reported as an inventory finding rather than reused.

### 3.3 Answers to the Phase-1 questions

| Question | Answer from repository truth |
| --- | --- |
| Who owns checkout lifecycle? | **Operator**. The Runtime is a validator with no lifecycle surface; Loop Governor and AutoPoster have no approval-contract call sites at all. |
| Must the checkout survive restarts? | **Yes** — `repositoryId` embeds inode, so a rebuilt checkout is a different repository to the Runtime. |
| Reuse an existing Git utility? | No (§3.2). |
| Checkout identity key? | `sha256(domain + normalized source path)` / `<exact committed HEAD>`. The commit id is content-addressed, so one key can only ever name one tree. |
| Source HEAD changes? | A new revision directory is published; the old one is untouched. |
| Approval bound to an older HEAD? | Stays valid against its own checkout. A new HEAD requires a new checkpoint and observation. |
| Concurrency races? | Removed rather than managed — see §5.3. |
| What is written, where? | Only under the configured checkout root: one directory per revision, plus transient `.building-<uuid>` scratch. Never inside the source repository. |
| Other repositories needing change? | **None.** |

---

## 4. Alternatives evaluated

All four viable strategies were probed against the **real** `inspectRuntimeApprovalRepository`,
not reasoned about on paper.

| Strategy | Passes the Runtime guard? | Why it did or did not win |
| --- | --- | --- |
| **Local clone + detached checkout** | **Yes** (`trackedDirty: false, untrackedDirty: false`) | **Chosen.** The source repository is only ever read. Self-contained: deletion is one `rm -rf`, with no registration to prune and no cross-repository coupling. |
| Detached linked worktree | Yes (identical clean result) | Rejected. `git worktree add` **writes into the product repository's `.git/worktrees/`**, so approval authority depends on state inside the live product repo that an unrelated `git worktree prune` can revoke. Its `gitCommonDirectory` is the source `.git`, so authority identity is also coupled to the source repo's inode — moving or re-cloning the product repo would revoke every existing approval. |
| Bare repository + separate worktree | Yes | Rejected: strictly more moving parts than a clone for the same guarantees. |
| Content-addressed checkout cache | — | **Adopted as the layout**, not as a separate mechanism: the chosen clone is published into a content-addressed `<sourceKey>/<head>` path. |
| Existing CHANTER worktree utility | No | Rejected on three grounds (§3.2), including that it makes the checkout dirty by design. |

Worktree and clone were empirically indistinguishable to the Runtime guard. The decision was made
on **blast radius**: a clone cannot damage, or be damaged by, the live product repository.

---

## 5. Design

### 5.1 Files

**Added**

| File | Purpose |
| --- | --- |
| `apps/backend/src/runtimeMissions/approvalAuthorityCheckout.ts` | Resolves and publishes the isolated per-revision authority checkout |
| `apps/backend/tests/approval-authority-repository-binding.test.ts` | 10 acceptance-matrix proofs |

**Modified**

| File | Change |
| --- | --- |
| `apps/backend/src/runtimeMissions/persistedApprovalAuthority.ts` | Two mutually exclusive binding modes; managed resolution at checkpoint publication only |
| `apps/backend/src/config.ts` | Managed/direct binding configuration with an exactly-one-mode rule |
| `tools/persisted-approval-authority/consumer-migration.integration.test.mts` | Added the production-shaped managed-binding scenario |

No file was deleted. No existing test was removed, skipped, or weakened.

### 5.2 Lifecycle

| Stage | Behaviour |
| --- | --- |
| **Creation** | Read the source's committed HEAD, `git clone --local --no-checkout`, `git checkout --detach <head>`, verify the built HEAD, then publish. `--no-checkout` means the default branch is never materialized — only the exact requested revision is. |
| **Validation** | **None by Operator.** The Runtime inspects the checkout at checkpoint publication and again at the authoritative pre-adapter guard. Operator adds no second opinion. |
| **Reuse** | An existing published directory is adopted exactly as-is (`created: false`). |
| **Refresh** | Never. A published checkout is immutable. A new HEAD gets a new directory. |
| **Recovery** | Builds happen in `.building-<uuid>` and are only renamed into place when complete, so a crash can only leave inert scratch — never a partially populated checkout that could be adopted as authority. |
| **Locking** | **None, by design** — see §5.3. |
| **Retention** | Conservative: nothing is ever garbage-collected. A live checkpoint, observation, replay binding, unresolved mission, or recoverable mission may still reference an older revision, and deleting its checkout would revoke that authority. Bounded growth is one tracked-content checkout per approved revision. |

### 5.3 Concurrency without a lock

Each caller builds into its own temporary directory and publishes with a single `rename`. The
first writer wins; every loser observes the existing directory and adopts it. There is therefore
**no lock file, no stale-lock recovery, and no lock timeout** — the failure mode the brief asks to
bound does not exist in this design. What is proven instead is the property the lock would have
protected: four concurrent resolutions of the same revision yield exactly one published checkout,
byte-clean, with zero adoptable scratch directories left behind.

### 5.4 Deliberate non-repair

A damaged published checkout is **never repaired**. Repair would mint a new `repositoryId`, which
would either revoke live approvals or mask tampering. The damaged checkout is left exactly as it
is and the Runtime guard refuses it with a typed reason. This is the single most important safety
decision in the design.

---

## 6. Configuration contract

**Managed binding (deployable):**

```bash
OPERATOR_APPROVAL_AUTHORITY_STATE_DIR=/var/lib/chanter/approval-state
OPERATOR_APPROVAL_AUTHORITY_SOURCE_REPOSITORY=/srv/chanter/chanter-operator
OPERATOR_APPROVAL_AUTHORITY_CHECKOUT_ROOT=/var/lib/chanter/approval-checkouts
OPERATOR_APPROVAL_AUTHORITY_POLICY_ID=chanter.operator.human-approval.v1   # optional
```

The source repository may be an ordinary working checkout with `node_modules/`, `dist/`, `.env`,
and logs. **No manually maintained clean checkout is required anywhere.**

**Direct binding (retained, explicit):** `OPERATOR_APPROVAL_AUTHORITY_REPOSITORY_ROOT` binds one
path that is already clean under the canonical policy. It is kept for controlled fixtures and is
what the existing test suite uses. Pointing it at a live product checkout keeps approvals
permanently fail-closed — that is the blocker, unchanged and still proven fail-closed (§8).

**Exactly one mode.** Configuring both, or an incomplete managed pair, is a configuration error,
not a precedence rule: two answers to "which repository does this approval bind to" is the
ambiguity this contract must not have. Any invalid combination leaves approval-required execution
fail-closed with `OPERATOR_APPROVAL_BINDING_NOT_CONFIGURED`.

No environment variable was renamed or reinterpreted, so there is no migration step for an
existing deployment; adding the two managed variables (and removing `_REPOSITORY_ROOT`) switches
modes.

---

## 7. Validation

All commands from `apps/chanter-Operator` unless noted.

| Command | Exit | Result |
| --- | --- | --- |
| `npm run typecheck --workspace @chanter/operator-backend` | 0 | PASS |
| `npm run build --workspace @chanter/operator-backend` | 0 | PASS |
| **`npm test`** | **0** | backend **897 passed (897)**, 34 files; frontend **133 passed (133)**, 7 files; 0 errors |
| `git diff --check` | 0 | PASS |
| Agent Runtime `npm test` (repository unchanged) | 0 | **540 tests, 123 suites, 540 passed, 0 failed, 0 skipped, 0 todo** |

Required lower bounds met and exceeded: backend 887 → **897** (+10, exactly the new focused
suite), frontend 133 → **133**, Runtime 540 → **540**. No prior test disappeared, became skipped,
or weakened an assertion.

**Focused suite, three consecutive runs** — `npx vitest run tests/approval-authority-repository-binding.test.ts`

| Run | Exit | Result |
| --- | --- | --- |
| 1 | 0 | 10 passed (10) |
| 2 | 0 | 10 passed (10) |
| 3 | 0 | 10 passed (10) |

**Production-shaped cross-repository proof, three consecutive runs** — `npm run test:approval-migration:e2e`

| Run | Exit | Result |
| --- | --- | --- |
| 1 | 0 | 7 tests, 7 pass, 0 fail |
| 2 | 0 | 7 tests, 7 pass, 0 fail |
| 3 | 0 | 7 tests, 7 pass, 0 fail |

Every run exited `0`; no run reported passing assertions behind a non-zero process exit.

The focused suite was subsequently run a further **14 consecutive times, all green**, while
investigating the single anomalous run described in §11.9.

---

## 8. Acceptance matrices

`adapter_started` is **counted from the durable run ledger** (`listRunsByMission` → events), and
downstream entries are counted at the port.

### 8.1 Core acceptance

| Scenario | adapter starts | Result |
| --- | --- | --- |
| Live product repository with `node_modules/`, `dist/`, `.env`, logs, untracked files, uncommitted tracked edit | **1** | PASS — manifest `expectedHead` equals the source's committed HEAD; `repositoryRoot` is the isolated checkout, never the product root |
| Isolated checkout contents | — | PASS — `status --untracked-files=all --ignored=matching` is empty; directory holds exactly `.git`, `.gitignore`, `product.txt`; none of the five contaminants present |
| Source repository never written | — | PASS — source status, `git worktree list`, and HEAD all byte-identical before and after |
| Dirty source, valid committed HEAD | 1 | PASS — authority binds the committed revision; the uncommitted edit never enters the checkout |
| Existing checkout adopted, not rebuilt | — | PASS — first resolve `created: true`, second `created: false`, same path |

### 8.2 HEAD change

| Step | Result |
| --- | --- |
| Approve mission 1 at HEAD A | PASS — 1 adapter start, manifest bound to A |
| Source advances to HEAD B (and is re-contaminated) | — |
| Approve mission 2 | PASS — 1 adapter start, manifest bound to B |
| Mission 1's approval | PASS — still bound to A, undisturbed; B never silently authorized by A |

### 8.3 Tampering — every case zero adapter starts

Authority is published against the pristine checkout **first**, then the checkout is tampered
with, so the tampering lands between a valid approval and the authoritative guard.

| Tampering | Typed refusal from the Runtime guard | adapter starts |
| --- | --- | --- |
| Tracked file modified | `RUNTIME_REPOSITORY_TRACKED_DIRTY` | 0 |
| Untracked file added | `RUNTIME_REPOSITORY_UNTRACKED_DIRTY` | 0 |
| Ignored file added | `RUNTIME_REPOSITORY_UNTRACKED_DIRTY` | 0 |
| Git HEAD advanced by a new commit | `RUNTIME_REPOSITORY_HEAD_MISMATCH` | 0 |

### 8.4 Restart

| Scenario | Result |
| --- | --- |
| Restart with intact checkout | PASS — durable replay, adapter starts stay at **1** |
| Duplicate resume after restart | PASS — no second execution |
| Checkout deleted, then a **new** mission approved | PASS — reconstruction mints a **different** `repositoryId`; nothing older can match it |
| Partial/interrupted build | PASS — scratch is never adoptable; zero `.building-*` siblings remain, and the revision directory holds only the published checkout |

### 8.5 Configuration failure — every case zero adapter starts

| Case | Typed code |
| --- | --- |
| Missing source repository | `OPERATOR_APPROVAL_CHECKOUT_SOURCE_UNAVAILABLE` |
| Non-Git source directory (Git command failure) | `OPERATOR_APPROVAL_CHECKOUT_SOURCE_HEAD_UNAVAILABLE` |
| Source repository with no committed HEAD | `OPERATOR_APPROVAL_CHECKOUT_SOURCE_HEAD_UNAVAILABLE` |
| Relative source path | `OPERATOR_APPROVAL_CHECKOUT_SOURCE_INVALID` |
| Relative checkout root | `OPERATOR_APPROVAL_CHECKOUT_ROOT_INVALID` |
| Uncreatable / unwritable checkout root | `OPERATOR_APPROVAL_CHECKOUT_ROOT_UNWRITABLE` |
| No binding configured | `OPERATOR_APPROVAL_BINDING_NOT_CONFIGURED` |
| Both bindings configured | `OPERATOR_APPROVAL_BINDING_NOT_CONFIGURED` |
| Live product repository bound **directly** | `RUNTIME_REPOSITORY_TRACKED_DIRTY` — the blocker itself, still fail-closed |
| Checkout identity mismatch | §8.3, §8.4 |
| Lock timeout | **Not applicable** — the design has no lock (§5.3) |
| Policy mismatch | Covered by the existing migration suite (`APPROVAL_POLICY_MISMATCH`) |

### 8.6 Concurrency

Four simultaneous resolutions of the same revision: **one** published checkout, byte-clean under
the canonical policy, exactly one directory in the revision root, zero `.building-*` residue.

### 8.7 Cross-repository production-shaped proof

Real Operator services, real Runtime guard, real `python -m governor.mission_intake` child
process, real Git product repository with real dirt, managed binding, no-side-effect AutoPoster
adapter. Both consumers reached `adapter_started == 1`; the product repository stayed dirty and at
its original HEAD throughout.

---

## 9. External side effects performed

**None.** No push, merge, deploy, publication, credential rotation, production mutation, or real
AutoPoster network call. No dependency was installed into any authority checkout. Every
repository, state directory, checkout cache, and adapter effect was a disposable local fixture.
The Loop Governor child process wrote only into a disposable data directory.

---

## 10. Breaking changes

**None for existing configurations.** `OPERATOR_APPROVAL_AUTHORITY_REPOSITORY_ROOT` behaves
exactly as before. The only new refusal is for a configuration that was previously impossible to
express: setting both binding modes at once.

The two behaviour changes from the preceding migration (canonical `approvedBy`; unresolved-claim
retirement on reconciliation evidence) are unchanged and still in force.

---

## 11. Remaining risks

1. **Submodules and replacement refs are unsupported.** `assertSupportedRepositoryShape` refuses
   both. A product repository using submodules cannot be bound in either mode. Inherited Runtime
   limitation, unchanged by this task.
2. **Disk growth is unbounded over time** — one tracked-content checkout per approved revision,
   never collected. Deliberate: conservative retention beats unsafe collection at P0. A safe
   collector needs a reachability check across checkpoints, observations, replay bindings, and
   recoverable missions; that is its own slice.
3. **Deleting a published checkout revokes the approvals bound to it.** This is correct and
   proven, but it is an operational footgun: the checkout root must be treated as durable state,
   not a cache that can be cleared.
4. **`git clone --local` hardlinks only within one filesystem.** Across volumes it falls back to
   copying — correct, but slower and larger.
5. **Cost.** Each *first* approval at a new revision performs one clone; every later approval at
   that revision performs none. The two Runtime inspections per approval-required mission remain.
6. **Approval authenticity is still unproven cross-repository.** The Runtime binds an immutable
   observation but cannot prove Operator issued it. Inherited; unchanged.
7. **The guarantee boundary is still the pre-adapter decision point**, not the whole adapter
   interval. Inherited; unchanged.
8. **`tools/resilience-evidence/cross-process-replay.mjs` is still unmigrated** and fails closed.
   Evidence script, not a production path.
9. **One unexplained focused-suite failure was observed and could not be reproduced.** During a
   post-commit sanity run the focused suite reported `1 failed | 9 passed (10)`. It has passed
   **14 consecutive times since**, including six runs with full failure capture armed and a
   deliberate replay of the exact command that produced it. The cause is **not established** and is
   recorded here rather than dismissed. Two things bound the risk: the suite builds roughly thirty
   real Git repositories and clones per run, so transient Windows filesystem contention is the
   leading hypothesis; and every assertion in it checks either a typed refusal or an exact
   adapter-start count, so a spurious environmental error makes a test **fail**, never falsely
   pass. Treat a single red run of this suite as "re-run and investigate", not as a contract
   regression — but do investigate it.

---

## 12. Rollback

```bash
git -C apps/chanter-Operator reset --hard 183dbaa
```

Then, if the branch is being abandoned entirely, delete it. Nothing else changed anywhere, so no
other repository needs to move. Rolling back restores the previous state, in which managed binding
does not exist and deployment still requires a manually maintained clean checkout.

Published authority checkouts under `OPERATOR_APPROVAL_AUTHORITY_CHECKOUT_ROOT` are inert after
rollback but must **not** be deleted while any approval still references them (§11.3).

---

## 13. Review and merge readiness

| Repository | Safe to review | Notes |
| --- | --- | --- |
| chanter-Operator | **Yes** | One bounded commit on top of `183dbaa`; 2 files added, 3 modified; all suites green; typecheck and build clean |
| chanter-agent-runtime | **Yes (no change)** | Untouched; 540/540 re-verified |
| chanter-loop.governor | **Yes (no change)** | Untouched |
| chanter-auto-poster | **Yes (no change)** | Untouched |

**Safe to merge: yes.** The Runtime authority contract was neither modified nor bypassed; no
`allowDirty`, `skipRepositoryCheck`, environment exception, ignored-file carve-out, or
Operator-side reimplementation of a Runtime check exists anywhere in the diff. Reviewers should
confirm two operational points: the checkout root is durable storage (§11.3), and retention is
deliberately unbounded at P0 (§11.2).

---

## 14. Does final CHANTER OS canonical E2E closure remain blocked?

**Yes — but no longer by this.** The deployability blocker is closed: a production-shaped Operator
configuration now derives and manages its own canonical isolated authority checkout, with no
manual clean-checkout maintenance anywhere.

Still open before canonical E2E closure:

1. **Approval authenticity across repositories** — the Runtime cannot prove Operator issued an
   observation; any writer to the state directory can author one.
2. **Authority-checkout retention and safe collection** — reachability-aware garbage collection
   (§11.2).
3. **Evidence-tool migration** — `tools/resilience-evidence/cross-process-replay.mjs`.
4. **Unresolved-claim reconciliation onto the Runtime reconciler** — currently Operator-evidence-bound.

---

## 15. Verdict

**PASS.**

- A live product repository full of ordinary operational files now reaches
  `adapter_started == 1` with no manual checkout maintenance.
- The Runtime remains the sole authority on repository identity, committed HEAD, and clean state;
  nothing was relaxed, bypassed, duplicated, or conditionally disabled.
- Every invalid, unavailable, stale, dirty, mismatched, tampered, partial, or ambiguous state
  produces `adapter_started == 0` with a typed refusal and no downgrade to transient authority.
- Concurrency, restart, HEAD-change, tampering, and configuration-failure matrices all pass.
- Operator 897/897 + 133/133 with exit code 0; Agent Runtime 540/540; focused proofs 10/10 ×3 and
  integration proofs 7/7 ×3, every run exiting 0.
