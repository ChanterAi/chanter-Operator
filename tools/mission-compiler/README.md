# CHANTER Operator Mission Compiler P1

Turns one high-level founder message into a complete, safe, copy-paste
execution mission for a supervised coding agent. This is the first layer of
the CHANTER Command Brain: **planning and handoff, not execution**.

Lives next to the Release Operator (`tools/release-operator/`) and follows the
same rules: plain Node built-ins, ESM, no dependencies, tested with
`node --test`, read-only by construction.

## What it is

Given an intent like:

```text
Upgrade CHANTER creatively and product-wise without breaking cohesion
```

it compiles a mission package containing: intent classification, business and
product objectives, target apps (by CHANTER priority order), explicit
non-targets, live repo truth (via the Release Operator scanner), risk gates,
approval gates, a validation plan, per-system connection plans (SafeCommit,
Loop Governor, Agent Runtime, MCP Server, Memory Vault), and a final
execution prompt another agent can run.

## What it is not

- It does **not** call LLM APIs, use the network, or install anything.
- It does **not** execute the mission: no push, deploy, publish, migration,
  or state mutation — those stay human-approval decisions.
- It does **not** replace the root CHANTER docs; they remain the
  authoritative truth model, mirrored through
  `tools/release-operator/chanter.repos.json`.

## Usage (PowerShell, from `apps/chanter-Operator`)

```powershell
npm run mission:compile -- --intent "Upgrade CHANTER creatively and product-wise without breaking cohesion"

# explicit target, JSON output, artifact file, offline mode:
npm run mission:compile -- --intent "Polish the intake flow" --target operator
npm run mission:compile -- --intent "..." --format json
npm run mission:compile -- --intent "..." --out            # writes to tools/mission-compiler/reports/ (gitignored)
npm run mission:compile -- --intent "..." --no-scan        # skip live git scan (deterministic/offline)

npm run mission:test    # run this tool's test suite
```

## Sample use cases

| Founder intent | Classified as | Primary targets |
| --- | --- | --- |
| "Upgrade CHANTER creatively and product-wise" | `company_upgrade` | AutoPoster + Premium Site (Operator as support) |
| "Upgrade the Operator CLI ergonomics" | `app_specific_upgrade` | Operator only |
| "Get CHANTER to release readiness" | `release_readiness` | Operator (release scan) |
| "Security and hygiene cleanup" | `safety_cleanup` | Operator + SafeCommit (advisory) |

CinemaForge is excluded by default unless explicitly named (and even then any
work on it is flagged as approval-required). CryptoRadar stays paper-trading
only; Memory Vault data is never mutated.

## Integration map

| System | Role in a compiled mission |
| --- | --- |
| Release Operator | Read-only workspace truth (dirty/ahead/clean-synced/no-remote) before and after; evidence reports |
| SafeCommit | Advisory diff/evidence review; defines "commit ready"; never auto-push |
| Loop Governor | Priority order, risk category, forbidden actions, next-loop recommendations |
| Agent Runtime | Handoff plan only in P1 — future execution envelope, no jobs run |
| MCP Server | Boundary statement only — tools must be registered/scoped/approval-gated; `insert-p3b` never runs |
| Memory Vault | Optional future intake for mission artifacts; no data mutation |

## Safety model

- Repo truth comes exclusively through the Release Operator's allowlisted
  read-only git commands (`status`, `log`, `rev-parse`, `remote`).
- Root docs are read, never written. Missing docs degrade gracefully.
- Every compiled prompt injects the security gates from
  `chanter.repos.json` (mirroring `CHANTER_SECURITY_GATES.md`) plus the
  standing approval gates (push, deploy, live publish, migrations, …).
- Creative/product missions carry a hard rule: internal tooling work may not
  be substituted for the requested visible product work.
- Artifacts go to `tools/mission-compiler/reports/` (gitignored) or an
  explicit `--out` path; default output is stdout.

## Example output excerpt

```text
CHANTER Mission — Company-wide creative & product upgrade. Intent type:
company_upgrade. Primary targets: AutoPoster + Premium Site. Support:
Operator. Repo truth: NEEDS ATTENTION — 2 of 12 repos require operator
review: … All push/deploy/live-publish/migration/destructive actions remain
approval-gated; the compiled prompt hands off to a supervised agent and
executes nothing itself.
```

## Module map

```text
mission-compiler.mjs      CLI: flags, config load, live scan, rendering, artifact write
lib/intent.mjs            mission intake: intent classification + named-app extraction
lib/plan.mjs              priority resolver + non-targets + system connection planner
lib/mission.mjs           mission assembly + execution prompt compiler + renderers
```
