// CHANTER Release Operator P0 — read-only git scanner.
//
// HARD SAFETY CONTRACT:
// - Only the allowlisted read-only git subcommands below may ever execute.
// - This module must never push, pull, fetch, commit, deploy, publish,
//   install, or mutate any repository or external system.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const ALLOWED_GIT_SUBCOMMANDS = new Set(['status', 'log', 'rev-parse', 'remote']);

export function runGit(repoPath, args) {
  const subcommand = args[0];
  if (!ALLOWED_GIT_SUBCOMMANDS.has(subcommand)) {
    throw new Error(`Blocked git subcommand (read-only scanner): ${subcommand}`);
  }
  return execFileSync('git', ['-C', repoPath, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

// Extract the file path from a `git status --porcelain=v2` entry line.
export function extractEntryPath(line) {
  if (line.startsWith('? ') || line.startsWith('! ')) return line.slice(2);
  const parts = line.split(' ');
  if (line.startsWith('1 ')) return parts.slice(8).join(' ');
  if (line.startsWith('2 ')) return parts.slice(9).join(' ').split('\t')[0];
  if (line.startsWith('u ')) return parts.slice(10).join(' ');
  return line;
}

// Parse `git status --porcelain=v2 --branch` output into a structured record.
export function parseStatusPorcelainV2(text) {
  const result = {
    oid: null,
    branch: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    changedCount: 0,
    untrackedCount: 0,
    dirtyFiles: [],
  };
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('# branch.oid ')) {
      result.oid = line.slice('# branch.oid '.length).trim();
    } else if (line.startsWith('# branch.head ')) {
      result.branch = line.slice('# branch.head '.length).trim();
    } else if (line.startsWith('# branch.upstream ')) {
      result.upstream = line.slice('# branch.upstream '.length).trim();
    } else if (line.startsWith('# branch.ab ')) {
      const m = line.match(/\+(\d+) -(\d+)/);
      if (m) {
        result.ahead = Number(m[1]);
        result.behind = Number(m[2]);
      }
    } else if (/^[12u] /.test(line)) {
      result.changedCount += 1;
      result.dirtyFiles.push(extractEntryPath(line));
    } else if (line.startsWith('? ')) {
      result.untrackedCount += 1;
      result.dirtyFiles.push(extractEntryPath(line));
    }
  }
  return result;
}

// Classify a scanned repo into a primary state plus informational flags.
// States: missing | non-git-expected | not-a-git-repo | dirty | no-remote |
//         no-upstream | diverged | ahead | behind | clean-synced
export function classifyRepoState(scan) {
  if (!scan.exists) return { state: 'missing', flags: [] };
  if (!scan.isGitRepo) {
    return {
      state: scan.expectGit === false ? 'non-git-expected' : 'not-a-git-repo',
      flags: [],
    };
  }
  const s = scan.status;
  const flags = [];
  if (s.ahead > 0) flags.push(`ahead ${s.ahead}`);
  if (s.behind > 0) flags.push(`behind ${s.behind}`);
  if (s.changedCount + s.untrackedCount > 0) return { state: 'dirty', flags };
  if (!scan.hasRemote) return { state: 'no-remote', flags };
  if (!s.upstream) return { state: 'no-upstream', flags };
  if (s.ahead > 0 && s.behind > 0) return { state: 'diverged', flags };
  if (s.ahead > 0) return { state: 'ahead', flags };
  if (s.behind > 0) return { state: 'behind', flags };
  return { state: 'clean-synced', flags };
}

function normalizePath(p) {
  return path.resolve(p).toLowerCase();
}

// Scan one repo from the catalog. All git access is read-only.
export function scanRepo(repoConfig, chanterRoot) {
  const absPath = path.resolve(chanterRoot, repoConfig.path);
  const record = {
    name: repoConfig.name,
    path: repoConfig.path,
    absPath,
    exists: existsSync(absPath),
    expectGit: repoConfig.git !== false,
    isGitRepo: false,
    hasRemote: false,
    remoteUrl: null,
    status: null,
    lastCommit: null,
    warnings: [],
  };

  if (record.exists && record.expectGit) {
    try {
      const inside = runGit(absPath, ['rev-parse', '--is-inside-work-tree']).trim();
      record.isGitRepo = inside === 'true';
    } catch {
      record.isGitRepo = false;
    }
  }

  if (record.isGitRepo) {
    // Guard against wrapper folders inheriting a parent repo's state.
    try {
      const toplevel = runGit(absPath, ['rev-parse', '--show-toplevel']).trim();
      if (normalizePath(toplevel) !== normalizePath(absPath)) {
        record.warnings.push(`git toplevel mismatch: ${toplevel}`);
        record.isGitRepo = false;
      }
    } catch {
      record.warnings.push('could not resolve git toplevel');
    }
  }

  if (record.isGitRepo) {
    record.status = parseStatusPorcelainV2(
      runGit(absPath, ['status', '--porcelain=v2', '--branch'])
    );
    try {
      record.remoteUrl = runGit(absPath, ['remote', 'get-url', 'origin']).trim();
      record.hasRemote = record.remoteUrl.length > 0;
    } catch {
      record.hasRemote = false;
    }
    try {
      const raw = runGit(absPath, ['log', '-1', '--format=%h|%ci|%s']).trim();
      const [hash, date, ...subject] = raw.split('|');
      record.lastCommit = { hash, date, subject: subject.join('|') };
    } catch {
      record.lastCommit = null;
    }
    if (repoConfig.defaultBranch && record.status.branch !== repoConfig.defaultBranch) {
      record.warnings.push(
        `branch is '${record.status.branch}', expected '${repoConfig.defaultBranch}'`
      );
    }
    if (repoConfig.expectedRemote && record.remoteUrl && !record.remoteUrl.includes(repoConfig.expectedRemote)) {
      record.warnings.push(`remote is '${record.remoteUrl}', expected '${repoConfig.expectedRemote}'`);
    }
    if (repoConfig.expectedRemote && !record.hasRemote) {
      record.warnings.push(`expected remote '${repoConfig.expectedRemote}' but none configured`);
    }
  }

  record.classification = classifyRepoState(record);
  return record;
}

export function scanAll(config, chanterRoot) {
  return config.repos.map((repo) => scanRepo(repo, chanterRoot));
}
