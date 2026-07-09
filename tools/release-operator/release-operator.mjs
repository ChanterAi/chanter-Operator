#!/usr/bin/env node
// CHANTER Release Operator P0 — read-only release command center.
//
// Commands:
//   scan            Scan all cataloged CHANTER repos (branch/commit/state) and print a table.
//   report          Generate a markdown release evidence report (default: tools/release-operator/reports/).
//   gates           Print blocked actions and approval-pending items from the catalog.
//
// Flags:
//   --json          (scan) print JSON instead of a table
//   --strict        (scan) exit 1 unless every repo is clean-synced / expected-local
//   --out <path>    (report) write the report to a specific path
//   --stdout        (report) print the report instead of writing a file
//
// SAFETY: read-only by construction. See lib/git-scan.mjs allowlist.
// This tool can never push, deploy, publish, migrate, install, or mutate state.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanAll } from './lib/git-scan.mjs';
import { checkRootDocs, readFixQueue } from './lib/docs-truth.mjs';
import { generateReport } from './lib/report.mjs';

const toolDir = path.dirname(fileURLToPath(import.meta.url));

function loadConfig() {
  const configPath = path.join(toolDir, 'chanter.repos.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const chanterRoot = path.resolve(toolDir, config.chanterRoot);
  return { config, chanterRoot };
}

function pad(str, width) {
  return String(str ?? '').padEnd(width);
}

function printScanTable(scans) {
  const rows = scans.map((r) => ({
    name: r.name,
    branch: r.status ? r.status.branch : '—',
    commit: r.lastCommit ? r.lastCommit.hash : '—',
    state:
      r.classification.state +
      (r.classification.flags.length ? ` (${r.classification.flags.join(', ')})` : ''),
    remote: r.hasRemote ? 'origin' : 'none',
  }));
  const widths = {
    name: Math.max(4, ...rows.map((r) => r.name.length)),
    branch: Math.max(6, ...rows.map((r) => r.branch.length)),
    commit: Math.max(6, ...rows.map((r) => r.commit.length)),
    state: Math.max(5, ...rows.map((r) => r.state.length)),
  };
  console.log(
    `${pad('REPO', widths.name)}  ${pad('BRANCH', widths.branch)}  ${pad('COMMIT', widths.commit)}  ${pad('STATE', widths.state)}  REMOTE`
  );
  for (const r of rows) {
    console.log(
      `${pad(r.name, widths.name)}  ${pad(r.branch, widths.branch)}  ${pad(r.commit, widths.commit)}  ${pad(r.state, widths.state)}  ${r.remote}`
    );
  }
  const warnings = scans.flatMap((r) => r.warnings.map((w) => `${r.name}: ${w}`));
  if (warnings.length > 0) {
    console.log('\nWarnings:');
    for (const w of warnings) console.log(`  - ${w}`);
  }
}

const OK_STATES = new Set(['clean-synced', 'no-remote', 'non-git-expected']);

function cmdScan(args) {
  const { config, chanterRoot } = loadConfig();
  const scans = scanAll(config, chanterRoot);
  if (args.includes('--json')) {
    console.log(JSON.stringify(scans, null, 2));
  } else {
    printScanTable(scans);
  }
  if (args.includes('--strict')) {
    const bad = scans.filter((r) => !OK_STATES.has(r.classification.state));
    if (bad.length > 0) {
      console.error(`\nSTRICT: ${bad.length} repo(s) not in a clean state: ${bad.map((r) => r.name).join(', ')}`);
      process.exitCode = 1;
    }
  }
}

function cmdReport(args) {
  const { config, chanterRoot } = loadConfig();
  const scans = scanAll(config, chanterRoot);
  const report = generateReport({
    scans,
    config,
    rootDocs: checkRootDocs(chanterRoot, config.rootDocs),
    fixQueue: readFixQueue(chanterRoot),
    generatedAt: new Date().toISOString(),
  });
  if (args.includes('--stdout')) {
    console.log(report);
    return;
  }
  const outFlag = args.indexOf('--out');
  let outPath;
  if (outFlag !== -1 && args[outFlag + 1]) {
    outPath = path.resolve(args[outFlag + 1]);
  } else {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const reportsDir = path.join(toolDir, 'reports');
    mkdirSync(reportsDir, { recursive: true });
    outPath = path.join(reportsDir, `release-evidence-${stamp}.md`);
  }
  writeFileSync(outPath, report, 'utf8');
  console.log(`Release evidence report written: ${outPath}`);
}

function cmdGates() {
  const { config } = loadConfig();
  console.log('GLOBAL GATES (approval required — see CHANTER_SECURITY_GATES.md):');
  for (const g of config.globalGates) console.log(`  - ${g}`);
  console.log(`\nLive publish exact phrase required: "${config.livePublishPhrase}"`);
  console.log('\nPER-REPO:');
  for (const repo of config.repos) {
    const blocked = repo.blockedCommands ?? [];
    const pending = repo.approvalPending ?? [];
    if (blocked.length === 0 && pending.length === 0) continue;
    console.log(`  ${repo.name}`);
    for (const b of blocked) console.log(`    BLOCKED: ${b}`);
    for (const p of pending) console.log(`    APPROVAL PENDING: ${p}`);
  }
}

const [, , command, ...args] = process.argv;
switch (command) {
  case 'scan':
    cmdScan(args);
    break;
  case 'report':
    cmdReport(args);
    break;
  case 'gates':
    cmdGates();
    break;
  default:
    console.log('CHANTER Release Operator P0 (read-only)');
    console.log('Usage: node tools/release-operator/release-operator.mjs <scan|report|gates> [flags]');
    console.log('  scan   [--json] [--strict]   Scan cataloged repos');
    console.log('  report [--out <path>|--stdout]  Generate release evidence report');
    console.log('  gates                        Show blocked/approval-gated actions');
    if (command) process.exitCode = 2;
}
