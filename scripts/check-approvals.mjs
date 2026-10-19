#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const approvalsPath = path.join(root, 'studio', 'references', 'APPROVALS.md');
const approvals = fs.existsSync(approvalsPath) ? fs.readFileSync(approvalsPath, 'utf8') : '';

const pending = [];
const listed = new Set();
for (const line of approvals.split('\n')) {
  if (!line.includes('|')) continue;
  const cols = line.split('|').map((c) => c.trim());
  const link = cols[1];
  const status = (cols[3] || '').toLowerCase();
  if (link && link.startsWith('http')) {
    listed.add(link);
    if (status && status !== 'approved') pending.push(link);
  }
}

const scanDirs = ['cartridges', 'src', 'public'].map((d) => path.join(root, d)).filter((d) => fs.existsSync(d));
function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(full, out);
    else if (/\.(mjs|js|ts|tsx|md|json|html)$/.test(ent.name)) out.push(full);
  }
  return out;
}
const files = scanDirs.flatMap((d) => walk(d));
const urlRe = /https?:\/\/[^\s)'"]+/g;
let failed = 0;
for (const file of files) {
  const body = fs.readFileSync(file, 'utf8');
  for (const link of pending) {
    if (body.includes(link)) {
      console.error(`[approvals] FAIL ${path.relative(root, file)} uses unapproved ${link}`);
      failed += 1;
    }
  }
  for (const match of body.match(urlRe) || []) {
    if (match.includes('github.com') || match.includes('localhost') || match.includes('127.0.0.1')) continue;
    if (!listed.has(match) && !match.includes('example.com')) {
      console.error(`[approvals] FAIL ${path.relative(root, file)} has unlisted URL ${match}`);
      failed += 1;
    }
  }
}
if (failed) process.exit(1);
console.log('[approvals] PASS');
