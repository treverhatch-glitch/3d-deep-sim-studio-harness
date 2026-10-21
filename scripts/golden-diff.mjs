#!/usr/bin/env node
/**
 * scripts/golden-diff.mjs — which recorded numbers a golden change moves, in one line.
 *
 *   node scripts/golden-diff.mjs [--staged | <commit>]
 *
 * A golden rewrite is where a broken sim gets "fixed" by re-recording the answer. So a commit that
 * changes qa/golden/** needs a Golden-Reason: trailer (the commit-msg hook refuses it otherwise) and
 * gets a Golden-Diff: trailer from this script, e.g. "example-sim-start-to-win: tick 300 → 312,
 * sha256 b8483bf1 → 9c0a11e2". The War Room shows each golden change as a card someone checks.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const git = (...a) => spawnSync('git', a, { cwd: root, encoding: 'utf8' });
const flat = (o, pre = '', out = {}) => {
  for (const [k, v] of Object.entries(o || {})) {
    const key = pre ? `${pre}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flat(v, key, out);
    else out[key] = v;
  }
  return out;
};
export function goldenDiff(ref = '--staged') {
  const staged = ref === '--staged';
  const names = (staged ? git('diff', '--cached', '--name-only', '--', 'qa/golden') : git('diff', '--name-only', `${ref}^`, ref, '--', 'qa/golden')).stdout.split('\n').filter((f) => f.endsWith('.json'));
  const parts = [];
  for (const f of names) {
    const before = git('show', `${staged ? 'HEAD' : `${ref}^`}:${f}`);
    const after = staged ? git('show', `:${f}`) : git('show', `${ref}:${f}`);
    let a = {};
    let b = {};
    try {
      a = flat(JSON.parse(before.stdout || '{}'));
      b = flat(JSON.parse(after.stdout || '{}'));
    } catch {
      // unreadable: name only
    }
    const moved = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]) && !/^(name|updatedAt|at)$/.test(k)).map((k) => {
      const show = (v) => (v === undefined ? '(none)' : typeof v === 'string' && /^[0-9a-f]{16,}$/.test(v) ? v.slice(0, 8) : JSON.stringify(v));
      return `${k.replace(/^expect\./, '')} ${show(a[k])} → ${show(b[k])}`;
    });
    parts.push(`${path.basename(f, '.json')}: ${before.status !== 0 ? 'new' : after.status !== 0 ? 'removed' : moved.slice(0, 4).join(', ') || 'formatting only'}`);
  }
  return parts.join('; ');
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  console.log(goldenDiff(process.argv[2] || '--staged'));
}
