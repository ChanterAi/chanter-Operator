import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFixQueueRemaining } from '../lib/docs-truth.mjs';

const FIX_QUEUE_FIXTURE = `# CHANTER Fix Queue

## P1 — high priority

| # | App | Item |
|---|-----|------|
| 5 | MCP Server | insert-p3b at repo root |

---

## Decision shortlist for the user (fastest wins first)

**Done as of 2026-07-09 checkpoint:** pushes complete.

Remaining:
1. Approve insert-p3b archive/delete (MCP Server) — still BLOCKED, do not run.
2. Approve stray file t removal (SafeCommit).
3. Pick Governor default_agent direction (mock vs enable codex).
`;

test('parses remaining decision-shortlist items', () => {
  const items = parseFixQueueRemaining(FIX_QUEUE_FIXTURE);
  assert.equal(items.length, 3);
  assert.match(items[0], /insert-p3b archive\/delete/);
  assert.match(items[2], /default_agent/);
});

test('returns empty array when shortlist section is absent', () => {
  assert.deepEqual(parseFixQueueRemaining('# Some other doc\n\nNothing here.\n'), []);
});

test('stops at next heading after shortlist', () => {
  const text = `## Decision shortlist\nRemaining:\n1. Item one.\n\n## Another section\n1. Not a decision.\n`;
  const items = parseFixQueueRemaining(text);
  assert.deepEqual(items, ['Item one.']);
});
