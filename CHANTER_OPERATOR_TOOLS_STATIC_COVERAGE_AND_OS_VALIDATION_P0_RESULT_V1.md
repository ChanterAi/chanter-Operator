# CHANTER Operator — Tools Static Coverage and Canonical OS Validation P0 — Result V1

**Verdict: PASS**

---

## 1. Repository state

| | Branch | HEAD |
| --- | --- | --- |
| Starting | `os/persisted-approval-authority-consumer-migration-p0` | `1f6fdff57c0b21507e856b57bae6286fb4e3f1bf` |
| Ending | `os/persisted-approval-authority-consumer-migration-p0` | this commit |

Preflight matched the brief exactly: expected branch, expected HEAD
`1f6fdff…`, clean working tree. Node `v22.22.0`, npm `10.9.4`, TypeScript
`5.9.3`. Single repository; Agent Runtime and Loop Governor were not touched.

---

## 2. Root cause

`apps/backend/tsconfig.json` declares `"include": ["src"]` with
`"rootDir": "src"` and `"outDir": "dist"` — it is a *build* program, so it
deliberately compiles only production source. Everything under `tools/` (and, as
a side observation, `apps/backend/tests/`) therefore belongs to **no TypeScript
program at all**. `npm run typecheck` could not have caught an error in a tool
file, because the compiler never read one.

Combined with the fact that each `tools/` proof has its own opt-in script and
none of them appear in an aggregate command, a proof harness could break and
stay broken while every routine check stayed green. That is exactly what
happened to the Phase 2C harness, which sat at `0/3` until the previous P0.

Two distinct gaps, both closed here:

1. **No static visibility** — no compiler program included the tool surfaces.
2. **No aggregate gate** — nothing ran the OS proofs together, so bypassing them
   required no decision, only forgetting.

---

## 3. TypeScript coverage design

A dedicated root `tsconfig.tools.json`, chosen over the alternatives:

- *Extending `apps/backend/tsconfig.json`* was rejected: that program emits to
  `dist/` with `rootDir: "src"`. Adding `tools/` would either break `rootDir` or
  ship tool code into the published build output.
- *Broadly including all of `tools/`* was rejected per the brief's scope rule;
  the remaining tool directories are unrelated `.mjs` surfaces that would import
  uncontrolled scope into this P0.

The config mirrors the backend's compiler options **exactly** — same `target`
(`ES2023`), `module`/`moduleResolution` (`NodeNext`, preserving `.mts` ESM
semantics), `strict: true`, `esModuleInterop`, `forceConsistentCasingInFileNames`,
`skipLibCheck`, `types: ["node"]` — and adds only `noEmit: true`. No strictness
is weakened and no production contract is copied or forked; the tools are held
to the same standard as the code they drive.

No dependency or lockfile change was required: `typescript@5.9.3`, `tsx@4.22.5`,
and `@types/node@24.13.2` are already hoisted to the root `node_modules`, and
npm puts `node_modules/.bin` on `PATH` for scripts, so `tsc -p tsconfig.tools.json`
resolves the existing toolchain.

---

## 4. Static coverage proof

Proven by the compiler's own file list, not by executing the scripts:

```bash
npx tsc -p tsconfig.tools.json --listFilesOnly
```

Tool files in the program:

```text
tools/phase2c/mission-loop.integration.test.mts
tools/os-assembly/run-end-to-end-assembly.mts
tools/validation/osValidation.mts
tools/validation/osValidation.test.mts
tools/validation/run-os-validation.mts
```

The coverage is **non-vacuous**: the same program pulls in **48**
`apps/backend/src/**` sources and the `chanter-agent-runtime` declaration files,
so the tools' imports are typechecked against real contracts rather than
degrading to `any`. Total program size: 264 files.

`npm run typecheck:tools` exits `0` with **zero** pre-existing errors — no
stop-condition was triggered and no suppression was needed.

**The check actually bites.** A deliberate type error was injected into an
untracked, not-yet-committed file authored in this task, observed, and reverted:

```text
tools/validation/osValidation.mts(109,7): error TS2322: Type 'string' is not assignable to type 'number'.
npm exit: 2
```

No tracked source was modified; `grep` confirmed 0 remaining occurrences and
`typecheck:tools` returned to exit `0`.

---

## 5. Canonical validation command

```bash
npm run validate:os
```

Ordered stages, stopping at the first failure:

| # | Stage | Script |
| --- | --- | --- |
| 1 | Repository typecheck (backend + frontend) | `typecheck` |
| 2 | Tools static typecheck | `typecheck:tools` |
| 3 | Production build | `build` |
| 4 | Phase 2C generic mission proof | `test:phase2c:mission` |
| 5 | Signed approval migration E2E | `test:approval-migration:e2e` |
| 6 | OS end-to-end operational assembly | `os:assembly` |

Cheapest and most diagnostic first: static correctness before build, build
before any proof, so an expensive proof never masks a trivial failure.

**Why a small orchestrator rather than `&&` composition.** Package-script
composition cannot print stage boundaries or name the failing stage, which §1.6
requires. It also offers no seam for the negative validation in §9. The
orchestrator is ~120 lines, composes only existing npm scripts, and reimplements
nothing.

**No shell is involved.** Spawning `npm.cmd` with `shell: false` was verified
empirically to throw `EINVAL` on Windows/Node 22, and `shell: true` would route
a command line through `cmd.exe`. The orchestrator instead invokes npm's own JS
entry with the current Node binary (`process.execPath` + `npm_execpath`),
verified to exit `0`. A documented fallback covers direct `node` invocation,
where npm exports no entry path.

---

## 6. Files changed

```text
 README.md                    | 31 +++++++++++++++++++++++++++++++   (runbook: canonical validation gate)
 package.json                 |  3 +++                               (typecheck:tools, validate:os, test:os-validation)
 tsconfig.tools.json          | new                                  (tools static coverage program)
 tools/validation/osValidation.mts        | new                      (stage list + orchestration contract)
 tools/validation/run-os-validation.mts   | new                      (entry point, shell-free npm spawn)
 tools/validation/osValidation.test.mts   | new                      (ordering + failure-propagation tests)
 CHANTER_OPERATOR_TOOLS_STATIC_COVERAGE_AND_OS_VALIDATION_P0_RESULT_V1.md | new (this file)
```

No production runtime behavior changed. No approval, trust, idempotency, replay,
or recovery semantics were touched. No dependency, lockfile, or formatting change.

---

## 7. Validation results

Focused checks, run individually:

| Command | Result |
| --- | --- |
| `npm run typecheck` | PASS |
| `npm run build` | PASS |
| `npm run typecheck:tools` | PASS (exit 0, 0 errors) |
| `npm run test:phase2c:mission` | **3 / 3 pass** |
| `npm run test:approval-migration:e2e` | **7 / 7 pass** |
| `npm run os:assembly` | **PASS** |
| `npm run test:os-validation` | **6 / 6 pass** |

### Both aggregate runs

Both from a clean repository state; both exited `0`.

```text
RUN 1                                    RUN 2
PASS  Repository typecheck               PASS  Repository typecheck
PASS  Tools static typecheck             PASS  Tools static typecheck
PASS  Production build                   PASS  Production build
PASS  Phase 2C generic mission proof     PASS  Phase 2C generic mission proof
PASS  Signed approval migration E2E      PASS  Signed approval migration E2E
PASS  OS end-to-end operational assembly PASS  OS end-to-end operational assembly
Verdict: PASS  (exit 0)                  Verdict: PASS  (exit 0)
```

Assembly identities prove each run is isolated and carries no dependence on
previous temporary state — every identifier differs, including the disposable
approval repository HEAD and both Operator PIDs:

| | Run 1 | Run 2 |
| --- | --- | --- |
| missionId | `chanter-os-assembly-msh4kkl0` | `chanter-os-assembly-msh4mcaj` |
| taskId | `task-602ba7f3` | `task-78419c44` |
| loopId | `38fa3f52` | `145344a8` |
| approval repo HEAD | `bfaff0a5…` | `2d15bea5…` |
| Operator PIDs | 1512 → 28396 | 5816 → 19176 |

Within **each** run, no duplicate durable downstream identity: Governor task
count `1` and loop count `1` at execution, again after restart + replay (same
task/loop returned, `replayed: true`), and again after the rejected payload.
The changed payload stayed a typed refusal — `409 OPERATOR_MISSION_PAYLOAD_MISMATCH`
— in both runs.

---

## 8. Negative failure-propagation proof

Two independent proofs, neither corrupting tracked source.

**A — the real gate.** With the injected type error from §4 still present,
`npm run validate:os` was run end to end:

```text
--- PASS [1/6] Repository typecheck (backend + frontend)
=== [2/6] Tools static typecheck — npm run typecheck:tools
tools/validation/osValidation.mts(109,7): error TS2322: Type 'string' is not assignable to type 'number'.
--- FAIL [2/6] Tools static typecheck (exit 2)

=== CHANTER OS validation summary
  PASS  Repository typecheck (backend + frontend)
  FAIL  Tools static typecheck (exit 2)
  SKIP  Production build (not run)
  SKIP  Phase 2C generic mission proof (not run)
  SKIP  Signed approval migration E2E (not run)
  SKIP  OS end-to-end operational assembly (not run)

Verdict: FAIL (exit 2)
AGGREGATE EXIT: 2
```

One stage failed → the four later stages did not run → the aggregate exited
non-zero, carrying `tsc`'s **real** exit code `2` rather than collapsing to `1`.

**B — the orchestration contract**, via `npm run test:os-validation` (6/6), using
a controlled stub runner that records which stages start:

- all stages pass → exit `0`, every stage started in declared order;
- middle stage exits `7` → aggregate exit `7`, the third stage **never started**;
- first stage exits `2` → aggregate exit `2`, nothing reported as completed;
- a stage that cannot start at all (throws) → exit `1`, later stages skipped,
  reported as a named failing stage rather than an unhandled rejection;
- the summary names the failing and skipped stages;
- the canonical six-script order is asserted, so silently dropping a stage from
  the gate fails the test.

---

## 9. Final git status

Before commit:

```text
 M README.md
 M package.json
?? tools/validation/
?? tsconfig.tools.json
(+ this result document)
```

`git diff --check` exits `0` (only Windows CRLF advisories, no whitespace
errors). No lockfile drift. No generated proof state staged — assembly output
lands in `var/os-assembly/`, already covered by the `var/` ignore rule.

---

## 10. Residual risks

1. **Coverage is scoped to three tool directories.** `tools/phase2c`,
   `tools/os-assembly`, and `tools/validation` are covered; the remaining
   `tools/` surfaces (phase2b1/2b2/2d/2e/2f, platform-canonical,
   safecommit-closeout, persisted-approval-authority, local-mission,
   resilience-evidence, release-operator, mission-compiler) are still outside any
   TypeScript program. This was the brief's explicit scope decision, not an
   oversight — but the rot risk persists for those files.
2. **`apps/backend/tests/` is also outside every program.** Discovered while
   mapping the configs. Vitest runs those tests, so breakage surfaces, but type
   errors in them do not fail `npm run typecheck`.
3. **`test:approval-migration:e2e` is in the gate; several other proofs are
   not** (`test:phase2d:graph`, `test:platform-canonical`,
   `test:safecommit-closeout:e2e`, `test:phase2e*`, `test:phase2f*`). The gate
   covers the CHANTER OS path specified by the brief, not the whole repository.
4. **`npm run test:os-validation` is itself not in the gate**, deliberately: a
   gate that runs its own contract test is circular, and adding it would make
   stage 1 depend on stage ordering. It is documented in the runbook instead.
5. **The gate takes roughly three to four minutes**, dominated by stages 5 and 6,
   which makes it unattractive to run on every edit. Stages 1–3 are the fast
   subset if a quicker inner loop is wanted.
6. **`npm_execpath` dependence.** The shell-free spawn path relies on npm
   exporting its entry path, which it does for `npm run`. Direct `node`
   invocation takes a documented fallback that uses a shell on Windows.

---

## 11. Verdict

**PASS.** The two proven CHANTER OS tool surfaces plus the new validation tooling
are inside an explicit, strict TypeScript program — verified by the compiler's
file list and by an injected error that the gate caught with a non-zero exit. One
canonical command, `npm run validate:os`, runs the full ordered path, passed
twice from a clean state, and was demonstrated to stop at the first failure while
preserving the real child exit code. Every result recorded here was directly
observed.
