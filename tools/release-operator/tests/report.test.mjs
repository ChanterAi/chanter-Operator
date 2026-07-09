import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateReport, summaryTable } from '../lib/report.mjs';

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
