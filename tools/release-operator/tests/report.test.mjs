import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateReport, summaryTable, verdictSummary } from '../lib/report.mjs';

const fakeScans = [
  {
    name: 'repo-clean',
    status: { branch: 'main', dirtyFiles: [] },
    lastCommit: { hash: 'abc1234', date: '2026-07-09 10:00:00 +0300', subject: 'ok' },
    remoteUrl: 'https://github.com/example/repo-clean.git',
    hasRemote: true,
    warnings: [],
    classification: { state: 'clean-synced', flags: [] },
  },
  {
    name: 'repo-dirty',
    status: { branch: 'master', dirtyFiles: ['src/a.js', 'notes.md'] },
    lastCommit: { hash: 'def5678', date: '2026-07-08 09:00:00 +0300', subject: 'wip' },
    remoteUrl: null,
    hasRemote: false,
    warnings: ["branch is 'master', expected 'main'"],
    classification: { state: 'dirty', flags: ['ahead 1'] },
  },
  {
    name: 'repo-ahead',
    path: 'apps/repo-ahead',
    status: { branch: 'main', dirtyFiles: [] },
    lastCommit: { hash: 'aaa9999', date: '2026-07-09 11:00:00 +0300', subject: 'local only' },
    remoteUrl: 'https://github.com/example/repo-ahead.git',
    hasRemote: true,
    warnings: [],
    classification: { state: 'ahead', flags: ['ahead 2'] },
  },
];

const fakeConfig = {
  globalGates: ['No `git push` without approval', 'No deploy without approval'],
  livePublishPhrase: 'I approve the controlled live publish test.',
  repos: [
    {
      name: 'repo-dirty',
      blockedCommands: ['git push'],
      approvalPending: ['delete stray file'],
    },
  ],
};

const fakeRootDocs = [
  { name: 'CHANTER_FIX_QUEUE.md', exists: true },
  { name: 'CHANTER_MISSING.md', exists: false },
];

const fakeFixQueue = { exists: true, remaining: ['Approve X', 'Decide Y'] };

test('summary table lists every repo with state', () => {
  const table = summaryTable(fakeScans);
  assert.match(table, /repo-clean/);
  assert.match(table, /clean-synced/);
  assert.match(table, /dirty \(ahead 1\)/);
});

test('report includes read-only guarantee and gates', () => {
  const report = generateReport({
    scans: fakeScans,
    config: fakeConfig,
    rootDocs: fakeRootDocs,
    fixQueue: fakeFixQueue,
    generatedAt: '2026-07-09T12:00:00.000Z',
  });
  assert.match(report, /READ-ONLY GUARANTEE/);
  assert.match(report, /No `git push` without approval/);
  assert.match(report, /I approve the controlled live publish test\./);
  assert.match(report, /APPROVAL PENDING: delete stray file/);
  assert.match(report, /❌ MISSING `CHANTER_MISSING\.md`/);
  assert.match(report, /1\. Approve X/);
});

test('report lists dirty files under anomalies', () => {
  const report = generateReport({
    scans: fakeScans,
    config: fakeConfig,
    rootDocs: fakeRootDocs,
    fixQueue: fakeFixQueue,
    generatedAt: '2026-07-09T12:00:00.000Z',
  });
  assert.match(report, /\*\*repo-dirty\*\* — state: dirty/);
  assert.match(report, /dirty: `src\/a\.js`/);
  assert.match(report, /warning: branch is 'master', expected 'main'/);
});

test('report notes when all repos are clean', () => {
  const report = generateReport({
    scans: [fakeScans[0]],
    config: fakeConfig,
    rootDocs: fakeRootDocs,
    fixQueue: fakeFixQueue,
    generatedAt: '2026-07-09T12:00:00.000Z',
  });
  assert.match(report, /None\. All repos are clean\/synced/);
});

test('verdict summarizes attention repos with their states', () => {
  assert.match(
    verdictSummary(fakeScans),
    /^NEEDS ATTENTION — 2 of 3 repos require operator review: repo-dirty \(dirty \(ahead 1\)\), repo-ahead \(ahead \(ahead 2\)\)\.$/
  );
  assert.match(
    verdictSummary([fakeScans[0]]),
    /^ALL CLEAR — 1 repos scanned/
  );
});

test('report leads with the verdict and suggests read-only next actions', () => {
  const report = generateReport({
    scans: fakeScans,
    config: fakeConfig,
    rootDocs: fakeRootDocs,
    fixQueue: fakeFixQueue,
    generatedAt: '2026-07-09T12:00:00.000Z',
  });
  assert.match(report, /## Verdict\n\n\*\*NEEDS ATTENTION — 2 of 3 repos/);
  assert.match(report, /## Next actions \(suggestions only — this tool never runs them\)/);
  assert.match(report, /\*\*repo-dirty\*\* — review the working tree with `git -C "repo-dirty" status`/);
  assert.match(report, /\*\*repo-ahead\*\* — local commits are not on origin — review `git -C "apps\/repo-ahead" log --oneline @\{upstream\}\.\.HEAD`; pushing requires explicit approval\./);
  assert.match(report, /Re-run `npm run release:scan -- --strict` until it reports every repo clean\./);
});

test('all-clean report says no next actions are needed', () => {
  const report = generateReport({
    scans: [fakeScans[0]],
    config: fakeConfig,
    rootDocs: fakeRootDocs,
    fixQueue: fakeFixQueue,
    generatedAt: '2026-07-09T12:00:00.000Z',
  });
  assert.match(report, /## Verdict\n\n\*\*ALL CLEAR — 1 repos scanned/);
  assert.match(report, /None — no repo needs operator action\./);
});
