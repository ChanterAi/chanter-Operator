// CHANTER Operator Mission Compiler P1 — priority resolver + system connection planner.
//
// Decides which CHANTER apps a mission targets (and which are explicitly out of
// scope) and plans how the CHANTER control systems connect around the mission.
// Pure functions, no I/O. The repo catalog (chanter.repos.json) mirrors the
// authoritative root docs; this module never overrides those gates.

import { APP_CATALOG } from './intent.mjs';

// Default CHANTER priority order (product registry order of leverage).
export const PRIORITY_ORDER = [
  'chanter-auto-poster',
  'chanter-premium-site',
  'chanter-Operator',
  'chanter-agent-runtime',
  'chanter-loop.governor',
  'chanter-mcp-server',
  'chanter-SafeCommit',
  'chanter-clean.engine',
  'chanter-memory-vault',
  'chanter-crypto-radar',
  'CinemaForge',
];

// Reasons an app is out of scope even when nothing else excludes it.
const STANDING_EXCLUSIONS = {
  CinemaForge: 'parked desktop tool — out of scope by default unless explicitly named',
  'chanter-crypto-radar': 'parked experiment — PAPER TRADING ONLY; live/trading actions blocked',
  'chanter-memory-vault': 'memory data mutation is blocked; durable-memory intake is a future phase',
};

function byPriority(names) {
  return [...names].sort((a, b) => PRIORITY_ORDER.indexOf(a) - PRIORITY_ORDER.indexOf(b));
}

function labelOf(name) {
  const entry = APP_CATALOG.find((a) => a.name === name);
  return entry ? entry.label : name;
}

// Resolve primary targets, support systems, and explicit non-targets for a
// classified intent. Named apps always win; otherwise defaults follow the
// mission type and the CHANTER priority order.
export function resolveTargets(classification) {
  const named = classification.namedApps.map((a) => a.name);
  let primary;
  let support;
  const notes = [];

  if (named.length > 0) {
    primary = byPriority(named);
    support = primary.includes('chanter-Operator') ? [] : ['chanter-Operator'];
    if (primary.includes('CinemaForge')) {
      notes.push(
        'CinemaForge was explicitly named: it is normally parked/out of scope. Any CinemaForge work (especially binary/LFS strategy) requires explicit user approval before touching the repo.'
      );
    }
  } else {
    switch (classification.type) {
      case 'release_readiness':
        primary = ['chanter-Operator'];
        support = [];
        break;
      case 'safety_cleanup':
        primary = ['chanter-Operator'];
        support = ['chanter-SafeCommit'];
        break;
      case 'company_upgrade':
      case 'creative_product_upgrade':
      case 'unknown':
      default:
        // Visible products first: AutoPoster + Premium Site carry the upgrade;
        // Operator participates only as truth/evidence support.
        primary = ['chanter-auto-poster', 'chanter-premium-site'];
        support = ['chanter-Operator'];
        if (classification.type === 'unknown') {
          notes.push(
            'Intent type could not be classified — defaulted to the top visible products (AutoPoster, Premium Site). Confirm scope with the founder before large work.'
          );
        }
        break;
    }
  }

  const inScope = new Set([...primary, ...support]);
  const nonTargets = PRIORITY_ORDER.filter((name) => !inScope.has(name)).map((name) => ({
    name,
    label: labelOf(name),
    reason: STANDING_EXCLUSIONS[name] ?? 'not required by this mission — do not modify',
  }));

  return {
    primary: primary.map((name) => ({ name, label: labelOf(name) })),
    support: support.map((name) => ({ name, label: labelOf(name) })),
    nonTargets,
    notes,
  };
}

function approvalQueue(config) {
  if (!config || !Array.isArray(config.repos)) return [];
  return config.repos.flatMap((repo) =>
    (repo.approvalPending ?? []).map((item) => `${repo.name}: ${item}`)
  );
}

// Plan how each CHANTER control system connects around this mission.
// P1 is a planning/handoff layer only: nothing here executes anything.
export function planConnections({ config, repoTruth } = {}) {
  return [
    {
      system: 'Release Operator',
      mode: 'active (read-only truth source)',
      plan: [
        'Provides workspace truth before and after the mission: dirty / ahead / clean-synced / no-remote per repo.',
        repoTruth && repoTruth.available
          ? `Current verdict: ${repoTruth.verdict}`
          : 'Run `npm run release:scan -- --strict` from apps/chanter-Operator to establish current truth.',
        'Re-scan after implementation; regenerate evidence with `npm run release:report`.',
      ],
      boundaries: ['Read-only git allowlist (status/log/rev-parse/remote). It can never push, deploy, publish, or migrate.'],
      approvalQueue: approvalQueue(config),
    },
    {
      system: 'SafeCommit',
      mode: 'advisory / review only',
      plan: [
        'Reviews proposed diffs, evidence, tests, and risk flags before any commit is called "ready".',
        '"Commit ready" means: tests pass, validation output captured, no forbidden actions in the diff, no secrets, no generated junk.',
        'Local commits are allowed when the workflow already supports them; push always remains a separate approval-gated human decision.',
      ],
      boundaries: ['SafeCommit must not auto-push and must not auto-commit outside the existing safe local workflow. Stray-file deletion stays approval-gated.'],
    },
    {
      system: 'Loop Governor',
      mode: 'policy input',
      plan: [
        'Supplies product priority order, risk category, and forbidden-action policy for the mission.',
        'Recommends the next loops after this mission completes (e.g. validation loop, docs reconciliation loop).',
      ],
      boundaries: ['Danger / full-access modes are blocked. No real external agent execution.'],
    },
    {
      system: 'Agent Runtime',
      mode: 'handoff plan only (P1 does not execute)',
      plan: [
        'Future execution envelope: task lifecycle, policies, routing, evidence capture, approval gates.',
        'P1 hands off a compiled mission prompt for a human-supervised coding agent; no runtime jobs are created or run.',
      ],
      boundaries: ['No autonomous execution in P1. Runtime integration requires its own reviewed design first.'],
    },
    {
      system: 'MCP Server',
      mode: 'boundary statement only',
      plan: [
        'Future controlled tool bridge: tools must be registered, scoped, and approval-gated before any agent may call them.',
        'P1 only states these boundaries; no MCP tools are invoked.',
      ],
      boundaries: ['Never run insert-p3b.js / insert-p3b.mjs (one-time inserts already executed — re-running corrupts state).'],
    },
    {
      system: 'Memory Vault',
      mode: 'optional future intake',
      plan: [
        'Mission artifacts (compiled prompt, evidence report) are candidates for durable memory intake in a later phase.',
      ],
      boundaries: ['No SQLite/memory data mutation. Vault contents are never committed.'],
    },
  ];
}
