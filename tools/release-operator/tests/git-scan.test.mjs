import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseStatusPorcelainV2,
  classifyRepoState,
  extractEntryPath,
  runGit,
} from '../lib/git-scan.mjs';

const CLEAN_SYNCED = [
  '# branch.oid 87a5c58deadbeefdeadbeefdeadbeefdeadbeef00',
  '# branch.head main',
  '# branch.upstream origin/main',
  '# branch.ab +0 -0',
  '',
].join('\n');

const AHEAD = [
  '# branch.oid 64e91f8deadbeefdeadbeefdeadbeefdeadbeef00',
  '# branch.head main',
  '# branch.upstream origin/main',
  '# branch.ab +12 -0',
  '',
].join('\n');

const DIVERGED = [
  '# branch.oid aaaa000deadbeefdeadbeefdeadbeefdeadbeef00',
  '# branch.head main',
  '# branch.upstream origin/main',
  '# branch.ab +2 -3',
  '',
].join('\n');

const DIRTY = [
  '# branch.oid a311174deadbeefdeadbeefdeadbeefdeadbeef00',
  '# branch.head master',
  '# branch.upstream origin/master',
  '# branch.ab +1 -0',
  '1 .M N... 100644 100644 100644 abc123 abc123 src/server.js',
  '2 R. N... 100644 100644 100644 abc123 abc123 R100 new-name.js\told-name.js',
  '? untracked-notes.md',
  '',
].join('\n');

const NO_UPSTREAM = [
  '# branch.oid bd1f310deadbeefdeadbeefdeadbeefdeadbeef00',
  '# branch.head master',
  '',
].join('\n');

test('parses clean synced repo status', () => {
  const s = parseStatusPorcelainV2(CLEAN_SYNCED);
  assert.equal(s.branch, 'main');
  assert.equal(s.upstream, 'origin/main');
  assert.equal(s.ahead, 0);
  assert.equal(s.behind, 0);
  assert.equal(s.changedCount, 0);
  assert.equal(s.untrackedCount, 0);
});

test('parses ahead count', () => {
  const s = parseStatusPorcelainV2(AHEAD);
  assert.equal(s.ahead, 12);
  assert.equal(s.behind, 0);
});

test('parses dirty entries including renames and untracked', () => {
  const s = parseStatusPorcelainV2(DIRTY);
  assert.equal(s.changedCount, 2);
  assert.equal(s.untrackedCount, 1);
  assert.deepEqual(s.dirtyFiles, ['src/server.js', 'new-name.js', 'untracked-notes.md']);
});

test('parses missing upstream as null', () => {
  const s = parseStatusPorcelainV2(NO_UPSTREAM);
  assert.equal(s.branch, 'master');
  assert.equal(s.upstream, null);
});

test('extractEntryPath handles all entry types', () => {
  assert.equal(extractEntryPath('? notes.md'), 'notes.md');
  assert.equal(
    extractEntryPath('1 .M N... 100644 100644 100644 abc abc src/a b.js'),
    'src/a b.js'
  );
  assert.equal(
    extractEntryPath('2 R. N... 100644 100644 100644 abc abc R100 new.js\told.js'),
    'new.js'
  );
});

function gitScan(statusText, { exists = true, isGitRepo = true, hasRemote = true, expectGit = true } = {}) {
  return {
    exists,
    isGitRepo,
    hasRemote,
    expectGit,
    status: statusText ? parseStatusPorcelainV2(statusText) : null,
  };
}

test('classifies clean-synced', () => {
  assert.equal(classifyRepoState(gitScan(CLEAN_SYNCED)).state, 'clean-synced');
});

test('classifies ahead', () => {
  const c = classifyRepoState(gitScan(AHEAD));
  assert.equal(c.state, 'ahead');
  assert.deepEqual(c.flags, ['ahead 12']);
});

test('classifies diverged', () => {
  assert.equal(classifyRepoState(gitScan(DIVERGED)).state, 'diverged');
});

test('classifies dirty (dirty wins over ahead, ahead kept as flag)', () => {
  const c = classifyRepoState(gitScan(DIRTY));
  assert.equal(c.state, 'dirty');
  assert.deepEqual(c.flags, ['ahead 1']);
});

test('classifies no-remote', () => {
  const c = classifyRepoState(gitScan(NO_UPSTREAM, { hasRemote: false }));
  assert.equal(c.state, 'no-remote');
});

test('classifies no-upstream when remote exists but branch has no upstream', () => {
  const c = classifyRepoState(gitScan(NO_UPSTREAM, { hasRemote: true }));
  assert.equal(c.state, 'no-upstream');
});

test('classifies missing and non-git states', () => {
  assert.equal(classifyRepoState(gitScan(null, { exists: false })).state, 'missing');
  assert.equal(classifyRepoState(gitScan(null, { isGitRepo: false })).state, 'not-a-git-repo');
  assert.equal(
    classifyRepoState(gitScan(null, { isGitRepo: false, expectGit: false })).state,
    'non-git-expected'
  );
});

test('runGit blocks non-allowlisted subcommands', () => {
  assert.throws(() => runGit('.', ['push']), /Blocked git subcommand/);
  assert.throws(() => runGit('.', ['commit', '-m', 'x']), /Blocked git subcommand/);
  assert.throws(() => runGit('.', ['fetch']), /Blocked git subcommand/);
  assert.throws(() => runGit('.', ['reset', '--hard']), /Blocked git subcommand/);
});
