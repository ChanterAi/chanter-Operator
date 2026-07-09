import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileMission, renderMarkdown, renderText, buildRepoTruth } from '../lib/mission.mjs';

const fakeScans = [
  {
    name: 'chanter-Operator',
    status: { branch: 'master', dirtyFiles: [] },
    lastCommit: { hash: '5a1337b', date: '2026-07-09 10:00:00 +0300', subject: 'local work' },
    remoteUrl: 'https://github.com/example/chanter-Operator.git',
    hasRemote: true,
    warnings: [],
    classification: { state: 'ahead', flags: ['ahead 1'] },
  },
  {
    name: 'chanter-auto-poster',
    status: { branch: 'main', dirtyFiles: [] },
    lastCommit: { hash: 'c7ad74c', date: '2026-07-09 09:00:00 +0300', subject: 'ok' },
    remoteUrl: 'https://github.com/example/chanter-auto-poster.git',
    hasRemote: true,
    warnings: [],
    classification: { state: 'ahead', flags: ['ahead 1'] },
  },
  {
    name: 'chanter-premium-site',
    status: { branch: 'main', dirtyFiles: [] },
    lastCommit: { hash: '86ad590', date: '2026-07-08 09:00:00 +0300', subject: 'ok' },
    remoteUrl: 'https://github.com/example/chanter-site.git',
    hasRemote: true,
    warnings: [],
    classification: { state: 'clean-synced', flags: [] },
  },
];

const fakeConfig = {
  globalGates: [
    'No `git push` / force push (all repos) without approval',
    'No deploy (Render/Vercel/Firebase/…) without approval',
    'No TikTok/Instagram live publish without the exact approval phrase',
  ],
  livePublishPhrase: 'I approve the controlled live publish test.',
  repos: [
    {
      name: 'chanter-auto-poster',
      path: 'apps/chanter-auto-poster',
      blockedCommands: ['any TikTok/Instagram live publish script', 'deploy', 'git push'],
      approvalPending: ['Controlled live publish test — requires the exact approval phrase'],
    },
    { name: 'chanter-premium-site', path: 'apps/chanter-premium-site', blockedCommands: ['deploy', 'git push'] },
    { name: 'chanter-Operator', path: 'apps/chanter-Operator' },
  ],
};

const presentDocs = [
  { name: 'CHANTER_PRODUCT_REGISTRY.md', exists: true },
  { name: 'CHANTER_SECURITY_GATES.md', exists: true },
];
const missingDocs = [
  { name: 'CHANTER_PRODUCT_REGISTRY.md', exists: false },
  { name: 'CHANTER_SECURITY_GATES.md', exists: false },
];

function compileSample(overrides = {}) {
  return compileMission({
    intentText: 'Upgrade CHANTER creatively and product-wise without breaking cohesion',
    scans: fakeScans,
    rootDocs: presentDocs,
    fixQueue: { exists: true, remaining: ['Decide X'] },
    config: fakeConfig,
    generatedAt: '2026-07-09T12:00:00.000Z',
    ...overrides,
  });
}

test('company upgrade mission compiles AutoPoster + Premium Site as primary visible targets', () => {
  const m = compileSample();
  assert.deepEqual(m.targets.primary.map((t) => t.name), ['chanter-auto-poster', 'chanter-premium-site']);
  assert.deepEqual(m.targets.support.map((t) => t.name), ['chanter-Operator']);
  assert.match(m.executionPrompt, /PRIMARY: AutoPoster/);
  assert.match(m.executionPrompt, /PRIMARY: Premium Site/);
  assert.match(m.executionPrompt, /SUPPORT: Operator/);
});

test('hard gates are injected into the compiled prompt', () => {
  const m = compileSample();
  assert.match(m.executionPrompt, /## Security gates \(hard blocks\)/);
  assert.match(m.executionPrompt, /No `git push` \/ force push/);
  assert.match(m.executionPrompt, /No deploy/);
  assert.match(m.executionPrompt, /live publish/i);
  assert.match(m.executionPrompt, /\*\*Do not push\.\*\*/);
});

test('no-push / no-deploy / no-live-publish blocks appear in risk and approval gates', () => {
  const m = compileSample();
  const gates = m.riskGates.join('\n');
  assert.match(gates, /push/i);
  assert.match(gates, /deploy/i);
  assert.match(gates, /live publish/i);
  assert.match(gates, /chanter-auto-poster: BLOCKED — any TikTok\/Instagram live publish script/);
  assert.match(m.approvalGates.join('\n'), /push \(any repo\)/);
});

test('SafeCommit appears as advisory/review integration, never auto-push', () => {
  const m = compileSample();
  assert.match(m.safeCommitPlan.join(' '), /advisory reviewer only/);
  const safeCommit = m.connections.find((c) => c.system === 'SafeCommit');
  assert.match(safeCommit.mode, /advisory/);
  assert.match(safeCommit.boundaries.join(' '), /must not auto-push/);
});

test('Release Operator scan truth is represented, including expected-ahead local work', () => {
  const m = compileSample();
  assert.equal(m.repoTruth.available, true);
  assert.match(m.repoTruth.verdict, /NEEDS ATTENTION/);
  assert.match(m.executionPrompt, /chanter-Operator — branch `master`, commit `5a1337b`, state: ahead \(ahead 1\)/);
  assert.match(m.executionPrompt, /EXPECTED: chanter-auto-poster is ahead of origin \(c7ad74c\)/);
  assert.match(m.releaseScanPlan.join(' '), /release:scan -- --strict/);
});

test('compiled prompt includes the validation plan', () => {
  const m = compileSample();
  assert.match(m.executionPrompt, /## Validation plan \(run before claiming success\)/);
  assert.match(m.executionPrompt, /git diff --check/);
  assert.match(m.executionPrompt, /Do not install dependencies/);
});

test('creative missions block substituting internal tooling for visible product work', () => {
  const m = compileSample();
  assert.equal(m.requiresVisibleWork, true);
  assert.match(m.executionPrompt, /Do not substitute internal tooling/);
  const releaseOnly = compileSample({ intentText: 'Check release readiness' });
  assert.equal(releaseOnly.requiresVisibleWork, false);
  assert.doesNotMatch(releaseOnly.executionPrompt, /Do not substitute internal tooling/);
});

test('missing root docs degrade gracefully instead of failing', () => {
  const m = compileSample({ rootDocs: missingDocs, scans: null, fixQueue: null });
  assert.equal(m.repoTruth.available, false);
  assert.match(m.repoTruth.verdict, /release:scan/);
  assert.deepEqual(m.context.docsPresent, []);
  assert.equal(m.context.docsMissing.length, 2);
  assert.match(m.context.degraded, /Missing root docs/);
  assert.ok(m.executionPrompt.length > 0);
});

test('markdown artifact contains all numbered mission sections and the fenced prompt', () => {
  const md = renderMarkdown(compileSample());
  for (const heading of [
    '## 1. Founder intent',
    '## 2. Objectives',
    '## 3. Targets',
    '## 4. Explicit non-targets',
    '## 5. Repo truth (Release Operator)',
    '## 6. Context docs',
    '## 7. System connections',
    '## 8. Risk gates',
    '## 9. Approval gates',
    '## 10. Validation plan',
    '## 11. SafeCommit review plan',
    '## 12. Release Operator scan plan',
    '## 13. Loop Governor policy plan',
    '## 14. Agent Runtime handoff plan',
    '## 15. MCP / tooling boundary plan',
    '## 16. Final execution prompt (copy-paste)',
    '## 17. Operator summary',
  ]) {
    assert.ok(md.includes(heading), `missing section: ${heading}`);
  }
  assert.match(md, /NON-EXECUTION GUARANTEE/);
  assert.match(md, /````markdown/);
});

test('text rendering leads with the operator summary and includes the prompt', () => {
  const txt = renderText(compileSample());
  assert.match(txt, /^CHANTER Mission — Company-wide creative & product upgrade\./);
  assert.match(txt, /--- EXECUTION PROMPT \(copy-paste below this line\) ---/);
  assert.match(txt, /## Completion criteria/);
});

test('buildRepoTruth handles empty input deterministically', () => {
  const truth = buildRepoTruth([]);
  assert.equal(truth.available, false);
  assert.deepEqual(truth.rows, []);
});

test('explicit extra targets narrow the mission to those apps', () => {
  const m = compileSample({
    intentText: 'Make it better',
    extraTargets: [{ name: 'chanter-Operator', label: 'Operator' }],
  });
  assert.equal(m.intent.type, 'app_specific_upgrade');
  assert.deepEqual(m.targets.primary.map((t) => t.name), ['chanter-Operator']);
});
