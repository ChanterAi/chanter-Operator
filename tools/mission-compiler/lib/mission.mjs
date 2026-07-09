// CHANTER Operator Mission Compiler P1 — mission assembly + execution prompt compiler.
//
// Turns a classified founder intent + repo truth + root-doc context into a
// complete mission package, including the final copy-paste execution prompt
// for a supervised coding agent. Pure formatting/composition: this module
// never executes commands, never calls a network, never mutates state.

import { verdictSummary } from '../../release-operator/lib/report.mjs';
import { classifyIntent } from './intent.mjs';
import { resolveTargets, planConnections } from './plan.mjs';

const TYPE_TEXT = {
  company_upgrade: {
    title: 'Company-wide creative & product upgrade',
    interpretation:
      'The founder wants CHANTER upgraded as a company: visible product quality raised across the top products without breaking cohesion between apps, docs, and safety gates.',
    business:
      'Increase the real and perceived value of CHANTER’s public-facing products while keeping the whole workspace release-safe and evidence-backed.',
    product:
      'Ship visible, premium, user-facing improvements to the primary products. Internal tooling participates only as truth/evidence support — it is not the deliverable.',
  },
  creative_product_upgrade: {
    title: 'Creative product upgrade',
    interpretation:
      'The founder wants a visible creative/product-quality upgrade: design, polish, and user-facing value — not internal plumbing.',
    business: 'Raise product taste and perceived quality where users can actually see it.',
    product: 'Deliver user-visible creative improvements with premium execution and cohesive branding.',
  },
  app_specific_upgrade: {
    title: 'App-specific upgrade',
    interpretation:
      'The founder named specific app(s): upgrade exactly those, leave the rest of the workspace untouched.',
    business: 'Deepen the value of the named app(s) without destabilizing the rest of CHANTER.',
    product: 'Improve the named app(s) with the smallest strong change set; validate before claiming success.',
  },
  release_readiness: {
    title: 'Release readiness pass',
    interpretation:
      'The founder wants to know (and improve) how close CHANTER is to a safe release: repo truth, gates, and evidence.',
    business: 'De-risk shipping by making the release state provable rather than assumed.',
    product: 'Produce a verified release picture and close readiness gaps; no push/deploy without approval.',
  },
  safety_cleanup: {
    title: 'Safety & hygiene cleanup',
    interpretation:
      'The founder wants safety debt reduced: gates verified, hygiene issues surfaced, risky leftovers queued for approval — nothing destructive done unilaterally.',
    business: 'Lower operational risk so future product work can move faster.',
    product: 'Surface and document safety issues with evidence; destructive fixes go to the approval queue, not into effect.',
  },
  unknown: {
    title: 'Unclassified founder intent',
    interpretation:
      'The intent could not be confidently classified. Defaulting to the highest-leverage visible products; scope must be confirmed with the founder before large work.',
    business: 'Apply effort where CHANTER priority order says it counts most, pending founder confirmation.',
    product: 'Propose visible product improvements on the default priority targets; keep the change set reversible.',
  },
};

function stateBadge(classification) {
  const flags = classification.flags?.length ? ` (${classification.flags.join(', ')})` : '';
  return `${classification.state}${flags}`;
}

// Summarize Release Operator scan results; degrade gracefully when absent.
export function buildRepoTruth(scans) {
  if (!Array.isArray(scans) || scans.length === 0) {
    return {
      available: false,
      verdict:
        'Repo truth unavailable at compile time — run `npm run release:scan -- --strict` from apps/chanter-Operator before executing this mission.',
      rows: [],
      expectedLocalWork: [],
    };
  }
  const rows = scans.map((r) => ({
    name: r.name,
    branch: r.status ? r.status.branch : '—',
    commit: r.lastCommit ? r.lastCommit.hash : '—',
    state: stateBadge(r.classification),
  }));
  const expectedLocalWork = scans
    .filter((r) => r.classification.state === 'ahead')
    .map((r) => `${r.name} is ahead of origin (${r.lastCommit ? r.lastCommit.hash : 'unknown commit'}) — expected local work; do not push, do not overwrite.`);
  return { available: true, verdict: verdictSummary(scans), rows, expectedLocalWork };
}

const FALLBACK_RISK_GATES = [
  'No `git push` / force push without approval',
  'No deploy without approval',
  'No TikTok/Instagram live publish without the exact approval phrase',
  'No migrations or production database writes',
  'No dependency installs',
  'No secret exposure; never print `.env` values',
  'No deletion/archive of tracked files without approval',
];

const APPROVAL_GATES = [
  'push (any repo)',
  'deploy (any target)',
  'live publish (TikTok/Instagram — requires the exact approval phrase)',
  'migrations (`migrate:firestore*` etc.)',
  'production database writes (Firestore/SQLite)',
  'destructive cleanup (delete/archive tracked files)',
  'MCP `insert-p3b` archive/delete',
  'SafeCommit stray file deletion',
  'CinemaForge future binary/LFS strategy',
  'CryptoRadar `src_old` removal',
];

function riskGatesFor(config, targets) {
  const gates = [...(config?.globalGates ?? FALLBACK_RISK_GATES)];
  const targetNames = new Set([...targets.primary, ...targets.support].map((t) => t.name));
  for (const repo of config?.repos ?? []) {
    if (!targetNames.has(repo.name)) continue;
    for (const blocked of repo.blockedCommands ?? []) {
      gates.push(`${repo.name}: BLOCKED — ${blocked}`);
    }
  }
  return gates;
}

function repoPath(config, name) {
  const entry = (config?.repos ?? []).find((r) => r.name === name);
  return entry?.path ?? `apps/${name}`;
}

function validationPlanFor(targets, repoTruth) {
  const plan = [];
  for (const t of targets.primary) {
    plan.push(
      `${t.label}: inspect its package.json and run the existing validation scripts (test / build / typecheck where present). Do not install dependencies.`
    );
  }
  plan.push(
    'Operator truth: from apps/chanter-Operator run `npm run release:scan -- --strict` before and after the work.'
  );
  if (repoTruth.expectedLocalWork.length > 0) {
    plan.push(
      `Strict scan is expected to flag known local work only: ${repoTruth.expectedLocalWork.length} repo(s) intentionally ahead of origin.`
    );
  }
  plan.push('Run `git diff --check` in every touched repo before committing.');
  plan.push('Capture command output verbatim as evidence — no success claims without it.');
  return plan;
}

// Assemble the full mission package. All inputs are data; nothing is executed.
export function compileMission({
  intentText,
  extraTargets = [],
  scans = null,
  rootDocs = null,
  fixQueue = null,
  config = null,
  generatedAt = null,
} = {}) {
  const classification = classifyIntent(intentText);
  if (extraTargets.length > 0) {
    const known = new Set(classification.namedApps.map((a) => a.name));
    for (const app of extraTargets) {
      if (!known.has(app.name)) classification.namedApps.push(app);
    }
    if (classification.type !== 'release_readiness' && classification.type !== 'safety_cleanup') {
      classification.type = 'app_specific_upgrade';
    }
  }

  const text = TYPE_TEXT[classification.type] ?? TYPE_TEXT.unknown;
  const targets = resolveTargets(classification);
  const repoTruth = buildRepoTruth(scans);
  const connections = planConnections({ config, repoTruth });
  const docsPresent = (rootDocs ?? []).filter((d) => d.exists).map((d) => d.name);
  const docsMissing = (rootDocs ?? []).filter((d) => !d.exists).map((d) => d.name);
  const requiresVisibleWork =
    ['company_upgrade', 'creative_product_upgrade'].includes(classification.type) ||
    classification.focus.creative;

  const mission = {
    title: `CHANTER Mission — ${text.title}`,
    generatedAt,
    intent: {
      raw: classification.raw,
      type: classification.type,
      namedApps: classification.namedApps.map((a) => a.label),
    },
    interpretation: text.interpretation,
    businessObjective: text.business,
    productObjective: text.product,
    targets,
    repoTruth,
    context: {
      docsPresent,
      docsMissing,
      fixQueueRemaining: fixQueue?.remaining ?? [],
      degraded:
        docsMissing.length > 0
          ? `Missing root docs (${docsMissing.length}) — compiled from available context; treat gaps as unknowns, not as permission.`
          : null,
    },
    connections,
    riskGates: riskGatesFor(config, targets),
    approvalGates: APPROVAL_GATES,
    validationPlan: validationPlanFor(targets, repoTruth),
    safeCommitPlan: [
      'SafeCommit acts as advisory reviewer only — it does not commit or push on its own.',
      'Before any commit: review the full diff, confirm tests/validation evidence, check for secrets, generated junk, and forbidden actions.',
      '"Commit ready" = tests pass + validation output captured + `git diff --check` clean + no gate violations.',
      'Local commits are allowed once commit-ready; push always remains a separate, explicitly approved human decision.',
    ],
    releaseScanPlan: [
      'Before work: `npm run release:scan -- --strict` from apps/chanter-Operator to record the starting truth.',
      'After work: re-run the strict scan and `npm run release:report` to regenerate evidence.',
      ...repoTruth.expectedLocalWork,
      'Any new dirty/diverged state must be explained in the final report — never hidden.',
    ],
    loopGovernorPlan: [
      'Respect CHANTER priority order: AutoPoster → Premium Site → Operator → Agent Runtime → Loop Governor → MCP Server → SafeCommit → Clean Engine → Memory Vault → CryptoRadar → CinemaForge.',
      'Risk category and forbidden actions come from the security gates; danger/full-access modes stay blocked.',
      'Recommended follow-up loops: validation re-run, docs reconciliation (root docs vs repo catalog), and approval-queue review.',
    ],
    agentRuntimePlan: [
      'This mission is a handoff package for a human-supervised coding agent — Agent Runtime does not execute it.',
      'Future runtime integration (lifecycle, routing, evidence, approval gates) requires its own reviewed design before any automation.',
    ],
    mcpBoundaryPlan: [
      'No MCP tool calls in this mission. Future tools must be registered, scoped, and approval-gated first.',
      'Never run `insert-p3b.js` / `insert-p3b.mjs` — one-time inserts already executed; re-running corrupts state.',
    ],
    requiresVisibleWork,
  };

  mission.executionPrompt = compileExecutionPrompt(mission, config);
  mission.operatorSummary = operatorSummary(mission);
  return mission;
}

function targetLines(mission, config) {
  const lines = [];
  for (const t of mission.targets.primary) {
    lines.push(`- PRIMARY: ${t.label} (\`${repoPath(config, t.name)}\`)`);
  }
  for (const t of mission.targets.support) {
    lines.push(`- SUPPORT: ${t.label} (\`${repoPath(config, t.name)}\`) — truth/evidence only, not the deliverable`);
  }
  return lines;
}

// Compile the final copy-paste execution prompt for a supervised coding agent.
export function compileExecutionPrompt(mission, config = null) {
  const out = [];
  out.push(`# ${mission.title} — Execution Prompt`);
  out.push('');
  out.push('## Mode stack');
  out.push('');
  out.push('- **AIM** — strategic, high-leverage, non-naive execution. Not unsafe, not deceptive, not destructive.');
  out.push('- **MatrixMode** — repository truth first, no fake proof, smallest correct diff, validation before success claims, hard gates for dangerous actions.');
  out.push('- **Team model** — think like a full product team (product, architecture, engineering, release, security), but act with one coherent hand.');
  out.push('');
  out.push('## Current verified state (Release Operator scan)');
  out.push('');
  out.push(mission.repoTruth.verdict);
  if (mission.repoTruth.rows.length > 0) {
    out.push('');
    for (const r of mission.repoTruth.rows) {
      out.push(`- ${r.name} — branch \`${r.branch}\`, commit \`${r.commit}\`, state: ${r.state}`);
    }
  }
  for (const note of mission.repoTruth.expectedLocalWork) {
    out.push(`- EXPECTED: ${note}`);
  }
  out.push('');
  out.push('## Mission objective');
  out.push('');
  out.push(`Founder intent: "${mission.intent.raw}"`);
  out.push('');
  out.push(`- Business objective: ${mission.businessObjective}`);
  out.push(`- Product objective: ${mission.productObjective}`);
  out.push('');
  out.push('## Target apps');
  out.push('');
  out.push(...targetLines(mission, config));
  out.push('');
  out.push('## Explicit non-targets (do not modify)');
  out.push('');
  for (const nt of mission.targets.nonTargets) {
    out.push(`- ${nt.label} — ${nt.reason}`);
  }
  out.push('');
  if (mission.requiresVisibleWork) {
    out.push('## HARD RULE — visible product work');
    out.push('');
    out.push('This mission requests a creative/product upgrade. **Do not substitute internal tooling, refactors, or infrastructure work for visible product work.** The deliverable must be something a user can see and feel. Internal changes are only acceptable as the minimum needed to ship the visible improvement.');
    out.push('');
  }
  out.push('## Product taste bar');
  out.push('');
  out.push('- Premium, cohesive, intentional — no generic filler UI or copy.');
  out.push('- Improvements must fit the existing brand and interaction patterns of each app.');
  out.push('- If a change cannot be made excellent within scope, propose it instead of half-shipping it.');
  out.push('');
  out.push('## Engineering gates');
  out.push('');
  out.push('- Smallest correct diff; reuse existing modules and style; no rewrites of working systems.');
  out.push('- No new dependencies, no installs, no lockfile churn.');
  out.push('- Meaningful tests for new behavior; run the existing suites.');
  out.push('- No hidden assumptions: verify paths, scripts, and APIs against the repo before using them.');
  out.push('');
  out.push('## Security gates (hard blocks)');
  out.push('');
  for (const gate of mission.riskGates) out.push(`- ${gate}`);
  out.push('');
  out.push('## Approval gates (require explicit user approval — assume NOT granted)');
  out.push('');
  for (const gate of mission.approvalGates) out.push(`- ${gate}`);
  out.push('');
  out.push('## Validation plan (run before claiming success)');
  out.push('');
  mission.validationPlan.forEach((step, i) => out.push(`${i + 1}. ${step}`));
  out.push('');
  out.push('## Commit rules');
  out.push('');
  out.push('- Commit locally only when commit-ready per SafeCommit advisory: tests pass, validation evidence captured, `git diff --check` clean, no gate violations, no secrets.');
  out.push('- Conventional commit message scoped to the app. **Do not push.**');
  out.push('');
  out.push('## Final report format');
  out.push('');
  out.push('Return: `COMPLETE / PARTIAL / BLOCKED`, executive outcome, files changed, validation results (verbatim), commit hash(es), final `git status -sb` per touched repo, forbidden actions avoided, and a next-loop recommendation.');
  out.push('');
  out.push('## Completion criteria');
  out.push('');
  out.push('- The stated product objective is visibly achieved in the primary target apps.');
  out.push('- All validation commands pass (or failures are reported honestly as PARTIAL/BLOCKED).');
  out.push('- Local commits exist; nothing was pushed, deployed, published, or migrated.');
  out.push('- The final report includes real evidence, not claims.');
  return out.join('\n');
}

function operatorSummary(mission) {
  const primary = mission.targets.primary.map((t) => t.label).join(' + ') || 'none';
  const support = mission.targets.support.map((t) => t.label).join(' + ') || 'none';
  return [
    `${mission.title}.`,
    `Intent type: ${mission.intent.type}. Primary targets: ${primary}. Support: ${support}.`,
    `Repo truth: ${mission.repoTruth.verdict}`,
    'All push/deploy/live-publish/migration/destructive actions remain approval-gated; the compiled prompt hands off to a supervised agent and executes nothing itself.',
  ].join(' ');
}

// Render the full mission package as a markdown artifact.
export function renderMarkdown(mission) {
  const out = [];
  out.push(`# ${mission.title}`);
  out.push('');
  if (mission.generatedAt) out.push(`Generated: ${mission.generatedAt} · Tool: Operator Mission Compiler P1 (local, non-executing)`);
  out.push('');
  out.push('> NON-EXECUTION GUARANTEE: this mission package was compiled locally from repo truth,');
  out.push('> root docs, and templates. No LLM/API calls, no network, no state mutation. It plans;');
  out.push('> a supervised agent (and human approvals) execute.');
  out.push('');
  out.push(`## 1. Founder intent`);
  out.push('');
  out.push(`- Raw: "${mission.intent.raw}"`);
  out.push(`- Classified type: \`${mission.intent.type}\``);
  out.push(`- Named apps: ${mission.intent.namedApps.length ? mission.intent.namedApps.join(', ') : 'none'}`);
  out.push(`- Interpretation: ${mission.interpretation}`);
  out.push('');
  out.push('## 2. Objectives');
  out.push('');
  out.push(`- Business: ${mission.businessObjective}`);
  out.push(`- Product: ${mission.productObjective}`);
  out.push('');
  out.push('## 3. Targets');
  out.push('');
  for (const t of mission.targets.primary) out.push(`- PRIMARY: **${t.label}** (\`${t.name}\`)`);
  for (const t of mission.targets.support) out.push(`- SUPPORT: **${t.label}** (\`${t.name}\`)`);
  for (const note of mission.targets.notes) out.push(`- NOTE: ${note}`);
  out.push('');
  out.push('## 4. Explicit non-targets');
  out.push('');
  for (const nt of mission.targets.nonTargets) out.push(`- ${nt.label} — ${nt.reason}`);
  out.push('');
  out.push('## 5. Repo truth (Release Operator)');
  out.push('');
  out.push(mission.repoTruth.verdict);
  out.push('');
  if (mission.repoTruth.rows.length > 0) {
    out.push('| Repo | Branch | Commit | State |');
    out.push('|---|---|---|---|');
    for (const r of mission.repoTruth.rows) out.push(`| ${r.name} | ${r.branch} | \`${r.commit}\` | ${r.state} |`);
    out.push('');
  }
  out.push('## 6. Context docs');
  out.push('');
  out.push(`- Present: ${mission.context.docsPresent.length ? mission.context.docsPresent.join(', ') : 'none checked'}`);
  out.push(`- Missing: ${mission.context.docsMissing.length ? mission.context.docsMissing.join(', ') : 'none'}`);
  if (mission.context.degraded) out.push(`- DEGRADED: ${mission.context.degraded}`);
  if (mission.context.fixQueueRemaining.length > 0) {
    out.push('- Fix queue remaining decisions:');
    mission.context.fixQueueRemaining.forEach((item, i) => out.push(`  ${i + 1}. ${item}`));
  }
  out.push('');
  out.push('## 7. System connections');
  out.push('');
  for (const c of mission.connections) {
    out.push(`### ${c.system} — ${c.mode}`);
    out.push('');
    for (const p of c.plan) out.push(`- ${p}`);
    for (const b of c.boundaries) out.push(`- BOUNDARY: ${b}`);
    if (c.approvalQueue?.length) {
      out.push('- Approval queue:');
      for (const q of c.approvalQueue) out.push(`  - ${q}`);
    }
    out.push('');
  }
  out.push('## 8. Risk gates');
  out.push('');
  for (const g of mission.riskGates) out.push(`- ${g}`);
  out.push('');
  out.push('## 9. Approval gates');
  out.push('');
  for (const g of mission.approvalGates) out.push(`- ${g}`);
  out.push('');
  out.push('## 10. Validation plan');
  out.push('');
  mission.validationPlan.forEach((s, i) => out.push(`${i + 1}. ${s}`));
  out.push('');
  out.push('## 11. SafeCommit review plan');
  out.push('');
  for (const s of mission.safeCommitPlan) out.push(`- ${s}`);
  out.push('');
  out.push('## 12. Release Operator scan plan');
  out.push('');
  for (const s of mission.releaseScanPlan) out.push(`- ${s}`);
  out.push('');
  out.push('## 13. Loop Governor policy plan');
  out.push('');
  for (const s of mission.loopGovernorPlan) out.push(`- ${s}`);
  out.push('');
  out.push('## 14. Agent Runtime handoff plan');
  out.push('');
  for (const s of mission.agentRuntimePlan) out.push(`- ${s}`);
  out.push('');
  out.push('## 15. MCP / tooling boundary plan');
  out.push('');
  for (const s of mission.mcpBoundaryPlan) out.push(`- ${s}`);
  out.push('');
  out.push('## 16. Final execution prompt (copy-paste)');
  out.push('');
  out.push('````markdown');
  out.push(mission.executionPrompt);
  out.push('````');
  out.push('');
  out.push('## 17. Operator summary');
  out.push('');
  out.push(mission.operatorSummary);
  out.push('');
  return out.join('\n');
}

// Compact console rendering: summary, targets, then the copy-paste prompt.
export function renderText(mission) {
  const out = [];
  out.push(mission.operatorSummary);
  out.push('');
  out.push('--- EXECUTION PROMPT (copy-paste below this line) ---');
  out.push('');
  out.push(mission.executionPrompt);
  return out.join('\n');
}
