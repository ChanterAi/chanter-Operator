// CHANTER Release Operator P0 — release evidence report generator.
// Pure formatting: takes scan results + config + docs truth, returns markdown.
// Never executes anything.

function stateBadge(classification) {
  const flags = classification.flags.length ? ` (${classification.flags.join(', ')})` : '';
  return `${classification.state}${flags}`;
}

function shortCommit(record) {
  if (!record.lastCommit) return '—';
  return `\`${record.lastCommit.hash}\` ${record.lastCommit.date.slice(0, 10)}`;
}

export function summaryTable(scans) {
  const lines = [
    '| Repo | Branch | Last commit | State | Remote |',
    '|---|---|---|---|---|',
  ];
  for (const r of scans) {
    const branch = r.status ? r.status.branch : '—';
    const remote = r.remoteUrl ? r.remoteUrl.replace(/^https?:\/\//, '') : 'none';
    lines.push(
      `| ${r.name} | ${branch} | ${shortCommit(r)} | ${stateBadge(r.classification)} | ${remote} |`
    );
  }
  return lines.join('\n');
}

export function generateReport({ scans, config, rootDocs, fixQueue, generatedAt }) {
  const ts = generatedAt ?? new Date().toISOString();
  const out = [];

  out.push('# CHANTER Release Evidence Report');
  out.push('');
  out.push(`Generated: ${ts} · Tool: Release Operator P0 (\`apps/chanter-Operator/tools/release-operator\`)`);
  out.push('');
  out.push('> READ-ONLY GUARANTEE: this report was produced by allowlisted read-only git');
  out.push('> commands (`status`, `log`, `rev-parse`, `remote`) plus root-doc reads.');
  out.push('> Nothing was pushed, deployed, published, migrated, installed, or mutated.');
  out.push('');

  out.push('## Repo state summary');
  out.push('');
  out.push(summaryTable(scans));
  out.push('');

  const anomalies = scans.filter(
    (r) =>
      !['clean-synced', 'non-git-expected', 'no-remote'].includes(r.classification.state) ||
      r.warnings.length > 0
  );
  out.push('## Anomalies and warnings');
  out.push('');
  if (anomalies.length === 0) {
    out.push('None. All repos are clean/synced, intentionally local-only, or expected non-git.');
  } else {
    for (const r of anomalies) {
      out.push(`- **${r.name}** — state: ${stateBadge(r.classification)}`);
      if (r.status && r.status.dirtyFiles.length > 0) {
        for (const f of r.status.dirtyFiles.slice(0, 20)) {
          out.push(`  - dirty: \`${f}\``);
        }
        if (r.status.dirtyFiles.length > 20) {
          out.push(`  - …and ${r.status.dirtyFiles.length - 20} more`);
        }
      }
      for (const w of r.warnings) out.push(`  - warning: ${w}`);
    }
  }
  out.push('');

  out.push('## Approval-gated actions (BLOCKED without explicit user approval)');
  out.push('');
  out.push('Global gates (mirrors `CHANTER_SECURITY_GATES.md` — that doc is authoritative):');
  out.push('');
  for (const gate of config.globalGates) out.push(`- ${gate}`);
  out.push('');
  out.push(`Live publish rule: a controlled live test requires the exact phrase **"${config.livePublishPhrase}"** — never automatic.`);
  out.push('');
  out.push('Per-repo blocked commands and pending approvals:');
  out.push('');
  for (const repo of config.repos) {
    const blocked = repo.blockedCommands ?? [];
    const pending = repo.approvalPending ?? [];
    if (blocked.length === 0 && pending.length === 0) continue;
    out.push(`- **${repo.name}**`);
    for (const b of blocked) out.push(`  - BLOCKED: ${b}`);
    for (const p of pending) out.push(`  - APPROVAL PENDING: ${p}`);
  }
  out.push('');

  out.push('## Root operating docs');
  out.push('');
  for (const doc of rootDocs) {
    out.push(`- ${doc.exists ? '✅' : '❌ MISSING'} \`${doc.name}\``);
  }
  out.push('');

  out.push('## Fix queue — remaining user decisions');
  out.push('');
  if (!fixQueue.exists) {
    out.push('CHANTER_FIX_QUEUE.md not found at the configured CHANTER root.');
  } else if (fixQueue.remaining.length === 0) {
    out.push('No "Remaining" decision-shortlist items parsed from CHANTER_FIX_QUEUE.md.');
  } else {
    fixQueue.remaining.forEach((item, i) => out.push(`${i + 1}. ${item}`));
  }
  out.push('');

  out.push('---');
  out.push('');
  out.push('Evidence provenance: `git status --porcelain=v2 --branch`, `git log -1`,');
  out.push('`git remote get-url origin`, `git rev-parse` per repo listed in');
  out.push('`tools/release-operator/chanter.repos.json`. Push/deploy/live-publish/migration');
  out.push('remain human-approval decisions — this tool cannot perform them.');
  out.push('');
  return out.join('\n');
}
