import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyIntent, extractApps } from '../lib/intent.mjs';

test('high-level company upgrade intent classifies as company_upgrade with no named apps', () => {
  const c = classifyIntent('Upgrade CHANTER creatively and product-wise without breaking cohesion');
  assert.equal(c.type, 'company_upgrade');
  assert.equal(c.namedApps.length, 0);
  assert.equal(c.focus.creative, true);
});

test('operator-specific intent classifies as app_specific_upgrade naming Operator only', () => {
  const c = classifyIntent('Upgrade the Operator CLI ergonomics and output quality');
  assert.equal(c.type, 'app_specific_upgrade');
  assert.deepEqual(c.namedApps.map((a) => a.name), ['chanter-Operator']);
});

test('release wording classifies as release_readiness', () => {
  const c = classifyIntent('Get CHANTER to release readiness with evidence');
  assert.equal(c.type, 'release_readiness');
});

test('safety wording classifies as safety_cleanup', () => {
  const c = classifyIntent('Do a security and hygiene cleanup across the workspace');
  assert.equal(c.type, 'safety_cleanup');
});

test('unclassifiable intent falls back to unknown', () => {
  const c = classifyIntent('zephyr quantum lattice');
  assert.equal(c.type, 'unknown');
});

test('extractApps matches aliases on word boundaries', () => {
  const apps = extractApps('Polish the AutoPoster flows and the premium site hero');
  assert.deepEqual(apps.map((a) => a.name), ['chanter-auto-poster', 'chanter-premium-site']);
  assert.deepEqual(extractApps('improve cooperator morale'), []);
});

test('empty intent is unknown and never throws', () => {
  assert.equal(classifyIntent('').type, 'unknown');
  assert.equal(classifyIntent(null).type, 'unknown');
});
