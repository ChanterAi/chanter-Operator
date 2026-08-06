# CHANTER Operator — Critical Test and Authority Tool Static Coverage P0 — Result V1

**Verdict: PARTIAL PASS — 3 of 5 target surfaces covered; 2 surfaces BLOCKED on
documented stop conditions.**

Delivered in full: static coverage for the authority/resilience tool surfaces
that could be covered without a forbidden change, the seven real type errors
they exposed, and canonical gate integration.

Blocked with evidence, not attempted: `apps/backend/tests/` and
`tools/safecommit-closeout/`. Both hit stop conditions the brief defines
explicitly. Neither was worked around with `any`, suppression, exclusion-to-hide,
or a dependency change.

---

## 1. Repository state

| | Branch | HEAD |
| --- | --- | --- |
| Starting | `os/persisted-approval-authority-consumer-migration-p0` | `a9dc684b73dd32e0d212f03415bb0f0b13e3cc72` |
| Ending | `os/persisted-approval-authority-consumer-migration-p0` | this commit |

Preflight matched the brief exactly: expected branch, expected HEAD, clean tree.
Node `v22.22.0`, npm `10.9.4`, TypeScript `5.9.3`. All preflight commands passed
before any modification — `typecheck` PASS, `typecheck:tools` PASS,
`test:os-validation` 6/6, `validate:os` **PASS (6/6 stages, exit 0)**.

---

## 2. Target surfaces — discovered vs included

`.ts`/`.mts` files, counted on disk and in the compiler program
(`npx tsc -p tsconfig.tools.json --listFilesOnly`):

| Target surface | On disk | In program | Missing |
| --- | ---: | ---: | ---: |
| `tools/persisted-approval-authority/` | 1 | 1 | 0 |
| `tools/platform-canonical/` | 1 | 1 | 0 |
| `tools/resilience-evidence/` | 0 | 0 | 0 |
| `tools/safecommit-closeout/` | 1 | **0** | **1 — BLOCKED, justified below** |
| `apps/backend/tests/` | 37 | **0** | **37 — BLOCKED, justified below** |

Previously covered surfaces, re-verified unchanged: `tools/phase2c` 1/1,
`tools/os-assembly` 1/1, `tools/validation` 3/3.

**`tools/resilience-evidence/` contains zero TypeScript.** It holds exactly two
files, `clean-source-validation.mjs` and `cross-process-replay.mjs`, both plain
JavaScript. The scope pattern `**/*.{ts,mts}` matches nothing there today. The
directory is included in the config anyway, so any future `.ts`/`.mts` file added
to it is covered automatically rather than silently escaping.

---

## 3. Compiler configuration decision

Extended the existing `tsconfig.tools.json` rather than adding a second tools
program: the covered directories are all tools, so the existing
`typecheck:tools` stage name stays semantically accurate and no stage had to be
renamed or split.

Options are unchanged from the previous P0 and still mirror
`apps/backend/tsconfig.json` exactly, minus emit:

```json
"target": "ES2023", "module": "NodeNext", "moduleResolution": "NodeNext",
"strict": true, "esModuleInterop": true, "forceConsistentCasingInFileNames": true,
"skipLibCheck": true, "types": ["node"], "noEmit": true
```

Nothing was weakened, no compiler option was added to accommodate a failing file,
no contract type was duplicated or forked, and the production build program was
not touched.

A `tsconfig.tests.json` for `apps/backend/tests` was drafted, measured, and then
**deleted** rather than shipped — see §5. Shipping a config that fails, or one
wired to nothing, would have been repo debt.

---

## 4. Type errors found and fixed (covered surfaces)

Adding the three tool directories surfaced **7** errors, all inside the target
surfaces. All 7 fixed; final count **0**.

| # | File / line | Code | Classification | Fix |
| --- | --- | --- | --- | --- |
| 1 | `persisted-approval-authority` 309 | TS2322 | Incorrect test typing | `workspaceId: params.workspaceId` is `string \| undefined`, contract requires `string`. Applied the sibling method's existing idiom, `?? "workspace-proof-0001"`. |
| 2 | `persisted-approval-authority` 318 | TS2322 | **Stale test fixture** | The `getPostStatus` stub was missing **16** properties of `AutoPosterPostStatusView` (`provider`, `connectedAccountId`, `workspaceId`, `approvalState`, `providerStatus`, `providerVerification`, `providerOperation`, `lockedAt`, `publishAttemptBudget`, `attemptBudgetExhausted`, `runtimeMissionId`, `runtimeIdempotencyKey`, `runtimeAction`, `runtimePayloadHash`, `lastResult`, `history`) and typed `updatedAt` as `null` where the contract requires `string`. Completed against the current contract. |
| 3–6 | `persisted-approval-authority` 419/470/519/592 | TS2345 | Incorrect test typing | `loopEnvelope()` declared `Record<string, unknown>`; the consumer takes `ChanterMissionEnvelopeV1`. Declared the real return type and imported it. |
| 7 | `platform-canonical` 426 | TS2322 | Incorrect test typing | Unannotated `loopPort()` widened `ok: true` to `boolean` and `outcome` to `string`. Annotated the return as `LoopGovernorMissionPort` via a **type-only** import, which is erased at runtime and leaves the file's deliberate dynamic-import ordering untouched. |

No production source was changed. **No genuine production contract defect was
found** — every error was in test/tool code that had drifted behind a contract
that was itself correct. Errors 1 and 2 are the substantive finding: a stale
fixture 16 fields behind the real `AutoPosterPostStatusView`, invisible for as
long as nothing typechecked it.

Zero suppression directives were added. No `any`, `@ts-ignore`,
`@ts-expect-error`, or silencing casts. Verified: `git diff` contains no such
token.

---

## 5. BLOCKED surface — `apps/backend/tests/`

Measured, not estimated:

```bash
npx tsc -p tsconfig.tests.json --noEmit   # (draft config, since removed)
# 225 errors across 18 of 37 test files
```

| Error code | Count |
| --- | ---: |
| TS2339 property does not exist | 88 |
| TS2345 argument not assignable | 80 |
| TS2322 type not assignable | 40 |
| TS2790 / TS7006 / TS2416 / others | 17 |

Worst files: `generic-mission-spine.test.ts` (72), `runtime-missions.test.ts`
(53), `runtime-mission-recovery.test.ts` (22), `mission-graph.test.ts` (18).

**Two independent stop conditions are triggered:**

1. **">20 independent compiler errors" — 225 observed**, an order of magnitude
   over the threshold.
2. **"dependency or module-resolution architecture must change."**
   **146 of the 225 errors (65%)** are one cluster:
   `Argument of type 'Test' is not assignable to parameter of type 'TestAgent<Test>'`
   and `Property 'send' does not exist on type 'TestAgent<Test>'`.
   Root cause: `@types/supertest@6.0.3` installed against `supertest@7.2.2`.
   `supertest@7` declares no `types` field, so the standalone `@types` package is
   authoritative, and it models the API differently than these tests assume.
   Resolving it requires changing or removing `@types/supertest` — a dependency
   and lockfile change, explicitly forbidden by §6.

**These are static-typing errors only.** The same suite passes at runtime:
`npm run test:backend` → **35 files, 903/903 tests passing**, before and after
this change. Nothing here indicates a real defect in the tests or in production.

Per §5.2 this is reported rather than worked around. Covering only the 19
error-free files was rejected as "test exclusion used to hide failures" (§6).

---

## 6. BLOCKED surface — `tools/safecommit-closeout/`

`safecommit-closeout.integration.test.mts` produced **22** of the initial 29 tool
errors. Root cause, confirmed by git itself:

```text
$ git ls-files --error-unmatch ../../tools/safecommit/lib/closeout-engine.mjs
fatal: '../../tools/safecommit/lib/closeout-engine.mjs' is outside repository
       at 'C:/Users/IT/OneDrive/Desktop/CHANTER/apps/chanter-Operator'
```

The test imports five untyped `.mjs` modules from the SafeCommit product, which
lives outside this repository:

```text
../../../../tools/safecommit/lib/closeout-engine.mjs
../../../../tools/safecommit/lib/operator-client.mjs
../../../../tools/safecommit/lib/process-runner.mjs
../../../../tools/safecommit/lib/state-store.mjs
../../../../tools/safecommit/tests/helpers/fixtures.mjs
```

Error shape: 5 × TS7016 (no declaration file, implicitly `any`), cascading into
6 × TS2339 and 3 × TS7006, plus 7 × TS5097 (`.ts` extension imports) and 1 ×
TS4112.

Covering it would require one of: authoring declarations for another
repository's JavaScript (**cross-repository change**, §6 and a stop condition);
`allowJs`/`checkJs` over a foreign product (**module-resolution architecture
change**, a stop condition); or `any`/suppression (**forbidden**). All were
rejected.

The exclusion is recorded inline in `tsconfig.tools.json` under an
`"//exclusion"` key, so the next reader sees the reason at the config rather
than discovering an unexplained gap.

---

## 7. Files changed

```text
 README.md                                                        | 21 ++++--
 tools/persisted-approval-authority/consumer-migration.integration.test.mts | 32 +++++++---
 tools/platform-canonical/platform-canonical.integration.test.mts | 5 ++-
 tsconfig.tools.json                                              | 8 ++--
 CHANTER_OPERATOR_..._P0_RESULT_V1.md                             | new (this file)
```

No production runtime change. No dependency or lockfile change. No file moves.
No formatting churn.

---

## 8. Canonical gate integration

No new stage was needed: the expanded coverage rides the existing stage 2,
`typecheck:tools`, whose label remains accurate. `npm run validate:os` therefore
now fails if any newly covered tool contains a TypeScript error, with the
existing fail-fast, real-exit-code, and skip-later-stages properties intact.

`npm run typecheck:tools` is documented in the README as the fast standalone
static check.

---

## 9. Validation results

| Command | Result |
| --- | --- |
| `npm run typecheck` | PASS |
| `npm run typecheck:tools` | PASS — **0 errors** |
| `npm run build` | PASS |
| `npm run test:backend` | **903 / 903 pass** (35 files) |
| `npm run test:phase2c:mission` | **3 / 3 pass** |
| `npm run test:approval-migration:e2e` (edited file) | **7 / 7 pass** |
| `npm run test:os-validation` | **6 / 6 pass** |
| `npm run os:assembly` | **PASS** |
| `npm run validate:os` ×2 | **PASS, exit 0 both** |
| `git diff --check` | exit 0 (CRLF advisories only) |

### Both aggregate runs

Independent isolated identities prove neither run depends on prior temporary
state; within each run the downstream identity is never duplicated:

| | Run 1 | Run 2 |
| --- | --- | --- |
| missionId | `chanter-os-assembly-msh5pl8l` | `chanter-os-assembly-msh5qpbb` |
| taskId | `task-551a3f49` | `task-2a208e43` |
| loopId | `26202e5f` | `0ec683c6` |
| approval repo HEAD | `d835408e…` | `0497c8bf…` |
| Operator PIDs | 23752 → 12980 | 11876 → 18564 |
| Governor task / loop count | 1 / 1 at execution, replay, and refusal | 1 / 1 at execution, replay, and refusal |

### Separate finding — a pre-existing failing proof

`npm run test:platform-canonical:e2e` **fails**: 1 test, 0 pass, 1 fail,
`AssertionError: expected 200, actual 409`.

This is **pre-existing and not caused by this change**, proven by stashing only
the edit to that file and re-running against unmodified HEAD, which produced the
identical failure. The change to that file is type-only (a `import type` and a
return annotation), both erased at runtime.

It is out of scope here — the proof is not part of `validate:os` and not in the
brief's required validation list — but it is the same rot pattern this P0 line
exists to eliminate: a proof outside the gate drifted and nobody noticed. It is
the recommended next P0.

---

## 10. Negative failure-propagation proof

Method per §8: one temporary **untracked** `.ts` fixture placed inside a newly
covered directory. Verified first that it could not disturb test discovery — the
package script targets `tools/platform-canonical/platform-canonical.integration.test.mts`
explicitly, not a glob, so an extra `.ts` file in that directory is inside the
TypeScript include but outside test-runner matching. No tracked source was
altered.

`tools/platform-canonical/__coverage-probe.ts`:

```ts
export const probe: number = "not a number";
```

Direct static command:

```text
tools/platform-canonical/__coverage-probe.ts(2,14): error TS2322: Type 'string' is not assignable to type 'number'.
typecheck:tools exit: 2
```

Through the aggregate gate:

```text
  PASS  Repository typecheck (backend + frontend)
  FAIL  Tools static typecheck (exit 2)
  SKIP  Production build (not run)
  SKIP  Phase 2C generic mission proof (not run)
  SKIP  Signed approval migration E2E (not run)
  SKIP  OS end-to-end operational assembly (not run)
Verdict: FAIL (exit 2)
AGGREGATE EXIT: 2
```

One newly covered surface failed → the four later stages did not run → the
aggregate exited with the compiler's **real** code `2`, not a collapsed `1`.

Fixture deleted; `typecheck:tools` returned to exit `0` and `git status` shows no
residue.

---

## 11. Final git status

Before commit:

```text
 M README.md
 M tools/persisted-approval-authority/consumer-migration.integration.test.mts
 M tools/platform-canonical/platform-canonical.integration.test.mts
 M tsconfig.tools.json
(+ this result document)
```

No generated runtime evidence staged (`var/` remains ignored). No lockfile drift.
No unrelated files.

---

## 12. Residual risks

1. **`apps/backend/tests/` remains entirely uncovered** — 37 files guarding
   approval, trust, idempotency, replay, and recovery, none statically checked.
   This is the largest remaining instance of the debt this P0 line targets.
2. **`tools/safecommit-closeout/` remains uncovered** and cannot be covered
   without a cross-repository change.
3. **`@types/supertest@6.0.3` vs `supertest@7.2.2` is a live mismatch.** It
   currently costs nothing at runtime, but it blocks backend test coverage and
   will keep doing so until the dependency question is decided.
4. **`test:platform-canonical:e2e` is failing** (pre-existing, §9) and is in no
   gate.
5. **Several proofs are still outside `validate:os`** — `test:phase2d:graph`,
   `test:platform-canonical:e2e`, `test:safecommit-closeout:e2e`, the phase2e/2f
   suites. Each can drift exactly as Phase 2C and platform-canonical did.
6. **The stale-fixture class is not eliminated, only found once.** The
   `AutoPosterPostStatusView` stub was 16 fields behind; equivalent stubs exist
   in the 18 uncovered backend test files and are still unchecked.

---

## 13. Verdict

**PARTIAL PASS.** Three target surfaces are now inside an explicit strict
TypeScript program with zero errors, proven by the compiler's own file list and
by an injected error the gate caught with a real non-zero exit. Seven genuine
type defects were found and fixed, including a fixture 16 fields behind its
contract. Two surfaces are BLOCKED on stop conditions the brief defines, with
measured evidence rather than estimates, and were not worked around. Every claim
above comes from directly observed command output.
