import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyIntent } from '../lib/intent.mjs';
import { resolveTargets, planConnections } from '../lib/plan.mjs';

function targetsFor(intent) {
  return resolveTargets(classifyIntent(intent));
}

test('company upgrade targets AutoPoster + Premium Site primary with Operator as support', () => {
  const t = targetsFor('Upgrade CHANTER creatively and product-wise without breaking cohesion');
  assert.deepEqual(t.primary.map((a) => a.name), ['chanter-auto-poster', 'chanter-premium-site']);
  assert.deepEqual(t.support.map((a) => a.name), ['chanter-Operator']);
});

test('app-specific Operator intent targets Operator only', () => {
  const t = targetsFor('Upgrade the Operator CLI ergonomics');
  assert.deepEqual(t.primary.map((a) => a.name), ['chanter-Operator']);
  assert.deepEqual(t.support, []);
});

test('CinemaForge is excluded by default with a standing reason', () => {
  const t = targetsFor('Upgrade CHANTER creatively and product-wise');
  const cinema = t.nonTargets.find((nt) => nt.name === 'CinemaForge');
  assert.ok(cinema, 'CinemaForge must appear in non-targets');
  assert.match(cinema.reason, /out of scope by default/);
  assert.ok(!t.primary.some((a) => a.name === 'CinemaForge'));
});

test('explicitly naming CinemaForge includes it but attaches an approval caution', () => {
  const t = targetsFor('Upgrade CinemaForge export presets');
  assert.deepEqual(t.primary.map((a) => a.name), ['CinemaForge']);
  assert.match(t.notes.join(' '), /explicit user approval/);
});

test('standing exclusions cover CryptoRadar live actions and Memory Vault mutation', () => {
  const t = targetsFor('Upgrade CHANTER creatively');
  const radar = t.nonTargets.find((nt) => nt.name === 'chanter-crypto-radar');
  const vault = t.nonTargets.find((nt) => nt.name === 'chanter-memory-vault');
  assert.match(radar.reason, /PAPER TRADING ONLY/);
  assert.match(vault.reason, /mutation is blocked/);
});

test('connection plan covers all six CHANTER systems with safe boundaries', () => {
  const connections = planConnections({});
  const systems = connections.map((c) => c.system);
  assert.deepEqual(systems, [
    'Release Operator',
    'SafeCommit',
    'Loop Governor',
    'Agent Runtime',
    'MCP Server',
    'Memory Vault',
  ]);
  const safeCommit = connections.find((c) => c.system === 'SafeCommit');
  assert.match(safeCommit.mode, /advisory/);
  assert.match(safeCommit.boundaries.join(' '), /must not auto-push/);
  const mcp = connections.find((c) => c.system === 'MCP Server');
  assert.match(mcp.boundaries.join(' '), /insert-p3b/);
});

test('connection plan surfaces the approval queue from the repo catalog', () => {
  const config = {
    repos: [
      { name: 'repo-a', approvalPending: ['Delete stray tracked file `t` (P3)'] },
      { name: 'repo-b' },
    ],
  };
  const releaseOperator = planConnections({ config }).find((c) => c.system === 'Release Operator');
  assert.deepEqual(releaseOperator.approvalQueue, ['repo-a: Delete stray tracked file `t` (P3)']);
});
