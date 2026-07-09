#!/usr/bin/env node
// CHANTER Operator Mission Compiler P1 — founder intent → execution mission package.
//
// Usage (from apps/chanter-Operator):
//   npm run mission:compile -- --intent "Upgrade CHANTER creatively and product-wise"
//
// Flags:
//   --intent "<text>"    (required) raw founder intent
//   --target <name>      add explicit target app(s); comma-separated or repeated
//   --format <fmt>       markdown (default) | json | text
//   --out [path]         write the artifact; bare --out uses tools/mission-compiler/reports/
//   --no-scan            skip the live Release Operator git scan (deterministic offline mode)
//
// SAFETY: local + non-executing by construction. Reads repo truth via the
// Release Operator's read-only git allowlist and the root CHANTER docs. It
// compiles a plan and a prompt — it never pushes, deploys, publishes,
// migrates, installs, calls LLM/network APIs, or mutates any state.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanAll } from '../release-operator/lib/git-scan.mjs';
import { checkRootDocs, readFixQueue } from '../release-operator/lib/docs-truth.mjs';
import { extractApps, APP_CATALOG } from './lib/intent.mjs';
import { compileMission, renderMarkdown, renderText } from './lib/mission.mjs';

const toolDir = path.dirname(fileURLToPath(import.meta.url));
const releaseOperatorDir = path.resolve(toolDir, '../release-operator');

function loadConfig() {
  const configPath = path.join(releaseOperatorDir, 'chanter.repos.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const chanterRoot = path.resolve(releaseOperatorDir, config.chanterRoot);
  return { config, chanterRoot };
}

function usage() {
  console.log('CHANTER Operator Mission Compiler P1 (local, non-executing)');
  console.log('Usage: node tools/mission-compiler/mission-compiler.mjs --intent "<founder intent>" [flags]');
  console.log('  --target <name>          add explicit target app(s), comma-separated or repeated');
  console.log('  --format markdown|json|text   output format (default: markdown)');
  console.log('  --out [path]             write artifact (default dir: tools/mission-compiler/reports/)');
  console.log('  --no-scan                skip live repo scan (offline/deterministic)');
}

function parseArgs(argv) {
  const args = { intent: null, targets: [], format: 'markdown', out: null, scan: true };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    switch (a) {
      case '--intent':
        args.intent = argv[++i];
        break;
      case '--target':
        args.targets.push(...String(argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean));
        break;
      case '--format':
        args.format = argv[++i];
        break;
      case '--out':
        if (argv[i + 1] && !argv[i + 1].startsWith('--')) args.out = argv[++i];
        else args.out = true;
        break;
      case '--no-scan':
        args.scan = false;
        break;
      case '--help':
        args.help = true;
        break;
      default:
        console.error(`Unknown flag: ${a}`);
        args.invalid = true;
    }
  }
  return args;
}

function resolveTargetOverrides(rawTargets) {
  const resolved = [];
  const unknown = [];
  for (const raw of rawTargets) {
    const matches = extractApps(raw);
    if (matches.length > 0) resolved.push(...matches);
    else unknown.push(raw);
  }
  return { resolved, unknown };
}

function safeSlug(intent) {
  const slug = String(intent)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || 'mission';
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }
  if (args.invalid || !args.intent || String(args.intent).trim() === '') {
    if (!args.invalid) console.error('Missing required flag: --intent "<founder intent>"');
    usage();
    process.exitCode = 2;
    return;
  }
  if (!['markdown', 'json', 'text'].includes(args.format)) {
    console.error(`Unknown format: ${args.format} (expected markdown | json | text)`);
    process.exitCode = 2;
    return;
  }

  const { resolved: extraTargets, unknown } = resolveTargetOverrides(args.targets);
  if (unknown.length > 0) {
    console.error(`Unknown --target value(s): ${unknown.join(', ')}`);
    console.error(`Known apps: ${APP_CATALOG.map((a) => a.label).join(', ')}`);
    process.exitCode = 2;
    return;
  }

  const { config, chanterRoot } = loadConfig();

  let scans = null;
  if (args.scan) {
    try {
      scans = scanAll(config, chanterRoot);
    } catch (err) {
      console.error(`WARN: repo scan failed (${err.message}) — compiling without live repo truth.`);
    }
  }

  const mission = compileMission({
    intentText: args.intent,
    extraTargets,
    scans,
    rootDocs: checkRootDocs(chanterRoot, config.rootDocs),
    fixQueue: readFixQueue(chanterRoot),
    config,
    generatedAt: new Date().toISOString(),
  });

  let rendered;
  if (args.format === 'json') rendered = JSON.stringify(mission, null, 2);
  else if (args.format === 'text') rendered = renderText(mission);
  else rendered = renderMarkdown(mission);

  if (args.out) {
    let outPath;
    if (args.out === true) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const reportsDir = path.join(toolDir, 'reports');
      mkdirSync(reportsDir, { recursive: true });
      const ext = args.format === 'json' ? 'json' : 'md';
      outPath = path.join(reportsDir, `mission-${safeSlug(args.intent)}-${stamp}.${ext}`);
    } else {
      outPath = path.resolve(args.out);
    }
    writeFileSync(outPath, rendered, 'utf8');
    console.log(`Mission artifact written: ${outPath}`);
    console.log('');
    console.log(mission.operatorSummary);
  } else {
    console.log(rendered);
  }
}

main();
