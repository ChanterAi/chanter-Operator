// CHANTER Release Operator P0 — root operating docs reader.
//
// The Release Operator does NOT invent its own truth model. It consumes the
// existing CHANTER root docs (Product Registry, Security Gates, Release
// Checklist, Fix Queue) and mirrors their gates via the repo catalog config.
// This module is read-only.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

// Report presence of each root operating doc.
export function checkRootDocs(chanterRoot, rootDocs) {
  return rootDocs.map((name) => ({
    name,
    exists: existsSync(path.join(chanterRoot, name)),
  }));
}

// Parse the "Decision shortlist ... Remaining:" numbered list out of
// CHANTER_FIX_QUEUE.md. Tolerant: returns [] when the section is absent.
export function parseFixQueueRemaining(text) {
  const lines = text.split(/\r?\n/);
  const items = [];
  let inShortlist = false;
  let inRemaining = false;
  for (const line of lines) {
    if (/^##\s+Decision shortlist/i.test(line)) {
      inShortlist = true;
      continue;
    }
    if (inShortlist && /^##\s/.test(line)) break;
    if (inShortlist && /^Remaining:/i.test(line)) {
      inRemaining = true;
      continue;
    }
    if (inRemaining) {
      const m = line.match(/^\s*\d+\.\s+(.*)$/);
      if (m) {
        items.push(m[1].trim());
      } else if (line.trim() !== '' && items.length > 0) {
        break;
      }
    }
  }
  return items;
}

export function readFixQueue(chanterRoot, fileName = 'CHANTER_FIX_QUEUE.md') {
  const filePath = path.join(chanterRoot, fileName);
  if (!existsSync(filePath)) {
    return { exists: false, remaining: [] };
  }
  const text = readFileSync(filePath, 'utf8');
  return { exists: true, remaining: parseFixQueueRemaining(text) };
}
