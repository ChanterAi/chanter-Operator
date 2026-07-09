// CHANTER Operator Mission Compiler P1 — mission intake.
//
// Classifies a raw founder intent string into a mission type and extracts
// any explicitly named CHANTER apps. Pure functions, no I/O, no network,
// no LLM calls — deterministic keyword matching only.

export const INTENT_TYPES = [
  'company_upgrade',
  'app_specific_upgrade',
  'creative_product_upgrade',
  'release_readiness',
  'safety_cleanup',
  'unknown',
];

// Canonical app catalog: repo names must match tools/release-operator/chanter.repos.json.
// Aliases are matched case-insensitively on word boundaries.
export const APP_CATALOG = [
  {
    name: 'chanter-auto-poster',
    label: 'AutoPoster',
    aliases: ['autoposter', 'auto-poster', 'auto poster', 'poster'],
  },
  {
    name: 'chanter-premium-site',
    label: 'Premium Site',
    aliases: ['premium site', 'premium-site', 'chanter site', 'the site', 'website'],
  },
  {
    name: 'chanter-Operator',
    label: 'Operator',
    aliases: ['operator', 'release operator', 'mission compiler', 'command brain'],
  },
  {
    name: 'chanter-agent-runtime',
    label: 'Agent Runtime',
    aliases: ['agent runtime', 'agent-runtime'],
  },
  {
    name: 'chanter-loop.governor',
    label: 'Loop Governor',
    aliases: ['loop governor', 'loop.governor', 'loop-governor'],
  },
  {
    name: 'chanter-mcp-server',
    label: 'MCP Server',
    aliases: ['mcp server', 'mcp-server', 'mcp'],
  },
  {
    name: 'chanter-SafeCommit',
    label: 'SafeCommit',
    aliases: ['safecommit', 'safe commit', 'safe-commit'],
  },
  {
    name: 'chanter-clean.engine',
    label: 'Clean Engine',
    aliases: ['clean engine', 'clean.engine', 'photo restoration'],
  },
  {
    name: 'chanter-memory-vault',
    label: 'Memory Vault',
    aliases: ['memory vault', 'memory-vault'],
  },
  {
    name: 'chanter-crypto-radar',
    label: 'CryptoRadar',
    aliases: ['cryptoradar', 'crypto radar', 'crypto-radar'],
  },
  {
    name: 'CinemaForge',
    label: 'CinemaForge',
    aliases: ['cinemaforge', 'cinema forge'],
  },
];

function aliasPattern(alias) {
  const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`, 'i');
}

// Return catalog entries explicitly named in the intent text, in catalog order.
export function extractApps(intentText) {
  const text = String(intentText ?? '');
  return APP_CATALOG.filter((app) =>
    [app.name, ...app.aliases].some((alias) => aliasPattern(alias).test(text))
  );
}

const RELEASE_WORDS = /\brelease\b|\breadiness\b|\bship\b|ship-ready|\blaunch\b/i;
const SAFETY_WORDS = /\bsafety\b|\bsecurity\b|\bsecrets?\b|\bcleanup\b|clean up|\bhygiene\b|\bharden/i;
const CREATIVE_WORDS = /creativ|product-wise|\bdesign\b|\bvisual\b|\bpremium\b|user-facing|\bpolish\b|\bbrand\b/i;
const COMPANY_WORDS = /\bcompany\b|\bchanter\b|\beverything\b|all apps|whole stack|across the/i;

// Classify a founder intent string. Deterministic; never throws on odd input.
export function classifyIntent(intentText) {
  const raw = String(intentText ?? '').trim();
  const namedApps = extractApps(raw);
  const focus = {
    release: RELEASE_WORDS.test(raw),
    safety: SAFETY_WORDS.test(raw),
    creative: CREATIVE_WORDS.test(raw),
    companyWide: COMPANY_WORDS.test(raw) && namedApps.length === 0,
  };

  let type = 'unknown';
  if (raw.length === 0) type = 'unknown';
  else if (focus.release) type = 'release_readiness';
  else if (focus.safety) type = 'safety_cleanup';
  else if (namedApps.length > 0) type = 'app_specific_upgrade';
  else if (focus.companyWide) type = 'company_upgrade';
  else if (focus.creative) type = 'creative_product_upgrade';

  return { raw, type, namedApps, focus };
}
