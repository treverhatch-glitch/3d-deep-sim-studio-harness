#!/usr/bin/env node
/**
 * Fail if game/cartridge code references an unapproved asset URL from APPROVALS.md.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const approvalsPath = path.join(root, 'studio', 'references', 'APPROVALS.md');
if (!fs.existsSync(approvalsPath)) {
  console.log('[approvals] no APPROVALS.md, skip');
  process.exit(0);
}

const text = fs.readFileSync(approvalsPath, 'utf8');
const pending = [];
for (const line of text.split('\n')) {
  if (!line.includes('|')) continue;
  const cols = line.split('|').map((c) => c.trim());
  const link = cols[1];
  const status = (cols[3] || '').toLowerCase();
  if (link && link.startsWith('http') && status && status !== 'approved') {
    pending.push(link);
  }
}

const scanDirs = ['cartridges', 'src'].map((d) => path.join(root, d)).filter((d) => fs.existsSync(d));
let failed = 0;
function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(full, out);
    else if (/\.(mjs|js|ts|tsx|md)$/.test(ent.name)) out.push(full);
  }
  return out;
}
const files = scanDirs.flatMap((d) => walk(d));
for (const file of files) {
  const body = fs.readFileSync(file, 'utf8');
  for (const link of pending) {
    if (body.includes(link)) {
      console.error(`[approvals] FAIL ${path.relative(root, file)} uses unapproved ${link}`);
      failed += 1;
    }
  }
}
if (failed) process.exit(1);
console.log(`[approvals] PASS (${pending.length} non-approved links not referenced)`);
