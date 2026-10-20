#!/usr/bin/env node
/**
 * scripts/secret-scan.mjs [root] [--staged] — fail if a key-shaped string would be committed.
 *
 * In a git checkout it scans exactly what git would publish: tracked files plus untracked files
 * that are not ignored. Your own .env (ignored) never trips it, so private clones stay green.
 * --staged scans only staged files (used by the pre-commit hook). Outside git it scans the folder.
 * Pure Node, so it runs the same on Windows, macOS and Linux. Values are never printed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const STAGED = args.includes('--staged');
const ROOT = path.resolve(args.find((a) => !a.startsWith('--')) || '.');

// Length-anchored so provider ids such as "xai-grok-4" or "sk-ant" in docs do not match.
const PATTERNS = [
  /sk-[A-Za-z0-9]{20,}/, // OpenAI legacy, DeepSeek, many others
  /sk-(proj|svcacct|admin)-[A-Za-z0-9_-]{20,}/, // OpenAI project / service keys
  /sk-ant-[A-Za-z0-9_-]{20,}/, // Anthropic
  /sk-or-v1-[A-Za-z0-9]{20,}/, // OpenRouter
  /sk_live_[A-Za-z0-9]{16,}/, // Stripe
  /rk_live_[A-Za-z0-9]{16,}/,
  /nvapi-[A-Za-z0-9_-]{20,}/, // NVIDIA NIM
  /gsk_[A-Za-z0-9]{20,}/, // Groq
  /xai-[A-Za-z0-9]{20,}/, // xAI
  /AIza[0-9A-Za-z_-]{30,}/, // Google API key
  /ya29\.[0-9A-Za-z_-]{20,}/, // Google OAuth access token
  /AKIA[0-9A-Z]{16}/, // AWS access key id
  /gh[pousr]_[A-Za-z0-9]{30,}/, // GitHub tokens
  /github_pat_[A-Za-z0-9_]{20,}/,
  /glpat-[A-Za-z0-9_-]{16,}/, // GitLab
  /xox[abposr]-[A-Za-z0-9-]{20,}/, // Slack
  /hf_[A-Za-z0-9]{20,}/, // Hugging Face
  /r8_[A-Za-z0-9]{20,}/, // Replicate
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];
const SKIP = /(^|\/)(secret-scan\.(mjs|sh)|package-lock\.json|[^/]*\.lock)$/;

function listFiles() {
  const git = (a) => spawnSync('git', a, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (git(['rev-parse', '--is-inside-work-tree']).stdout?.trim() === 'true') {
    const r = STAGED ? git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']) : git(['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
    return r.stdout.split('\0').filter(Boolean);
  }
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      if (e.name === '.git' || e.name === 'node_modules') continue;
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (e.isDirectory()) walk(rel);
      else if (e.isFile()) out.push(rel);
    }
  };
  walk('');
  return out;
}

let count = 0;
const hits = new Set();
for (const rel of listFiles()) {
  const full = path.join(ROOT, rel);
  if (SKIP.test(rel) || !fs.existsSync(full) || !fs.statSync(full).isFile()) continue;
  const buf = fs.readFileSync(full);
  count += 1;
  if (buf.subarray(0, 8000).includes(0)) continue; // binary
  buf.toString('utf8').split(/\r?\n/).forEach((line, i) => {
    if (PATTERNS.some((re) => re.test(line))) hits.add(`  ${rel}:${i + 1}`);
  });
}
if (hits.size) {
  console.log('[secrets] FAIL key-shaped string(s) found (values hidden):');
  console.log([...hits].sort().join('\n'));
  console.log('[secrets] Move real keys to .env (gitignored). If one was ever committed, rotate it.');
  process.exit(1);
}
console.log(`[secrets] PASS — ${count} file(s) scanned`);
