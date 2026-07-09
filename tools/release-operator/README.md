# CHANTER Release Operator P0

Read-only release command center for the CHANTER workspace. Scans every
cataloged CHANTER repo, classifies its release state, and generates a
markdown release evidence report — without ever pushing, deploying,
publishing, migrating, installing, or mutating anything.

Lives in `chanter-Operator` because the Operator is CHANTER's founder
cockpit / control layer. Plain Node (built-ins only, ESM) — no new
dependencies, outside the TypeScript workspaces, tested with `node --test`.

## Usage (PowerShell, from `apps/chanter-Operator`)

```powershell
npm run release:scan        # table of repo states
npm run release:gates       # blocked + approval-pending actions
npm run release:report      # write evidence report to tools/release-operator/reports/ (gitignored)
npm run release:test        # run the tool's own test suite

# direct invocation with flags:
node tools/release-operator/release-operator.mjs scan --json
node tools/release-operator/release-operator.mjs scan --strict     # exit 1 unless all clean
node tools/release-operator/release-operator.mjs report --stdout
node tools/release-operator/release-operator.mjs report --out "..\..\CHANTER_RELEASE_EVIDENCE.md"
```

## What it reports

- **Verdict:** a one-line `ALL CLEAR` / `NEEDS ATTENTION` summary at the
  top of the report (and after the scan table), naming any repo that
  requires operator review.
- **Per repo:** branch, latest commit, remote URL, ahead/behind counts,
  dirty files, and a classification:
  `clean-synced | ahead | behind | diverged | dirty | no-remote |
  no-upstream | not-a-git-repo | non-git-expected | missing`
- **Next actions:** a numbered list of suggested read-only follow-up
  commands per anomalous repo (e.g. `git -C "<path>" status` for a dirty
  tree). Suggestions only — the tool never executes them, and every
  mutating follow-up stays approval-gated.
- **Warnings:** unexpected branch, remote mismatch, nested-repo toplevel
  mismatch (wrapper folders never inherit a parent repo's state).
- **Gates:** global blocked actions, per-repo blocked commands, and
  approval-pending items (mirrored from the root docs).
- **Root docs:** presence check for the seven CHANTER operating docs.
- **Fix queue:** the remaining user-decision shortlist parsed from
  `CHANTER_FIX_QUEUE.md`.

## Truth model

This tool does **not** invent its own truth. The CHANTER root docs are
authoritative; `chanter.repos.json` mirrors them:

- `CHANTER_PRODUCT_REGISTRY.md` — repo catalog (paths, branches, remotes)
- `CHANTER_SECURITY_GATES.md` — global + per-repo gates
- `CHANTER_RELEASE_CHECKLIST.md` — the release gate sequence
- `CHANTER_FIX_QUEUE.md` — pending decisions (parsed live at report time)

When the root docs change (new repo, new gate, resolved approval), update
`chanter.repos.json` to match — never the other way around.

## Hard safety gates (P0 scope: read-only by construction)

- Git access is limited to an **allowlist**: `status`, `log`, `rev-parse`,
  `remote`. Anything else (`push`, `commit`, `fetch`, `reset`, …) throws.
  This is test-locked in `tests/git-scan.test.mjs`.
- The tool never runs deploys, live publishes, migrations, installs,
  `insert-p3b` scripts, or any external write API.
- Push / deploy / live publish / migration remain **human-approval
  decisions**. A controlled live publish additionally requires the exact
  phrase recorded in `chanter.repos.json` (`livePublishPhrase`) — the tool
  only *reports* that gate; it cannot invoke anything behind it.
- Reports are written to `tools/release-operator/reports/` (gitignored) or
  an explicit `--out` path. No secrets are read; `.env` files are never
  touched.

## Future (P1+, all approval-gated before build)

- Checklist-driven interactive release walkthrough (still no execution).
- Operator backend/frontend surface for the scan results.
- Evidence bundle attachment to the MCP server catalog.
