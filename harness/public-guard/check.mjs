#!/usr/bin/env node
/**
 * tools/public-guard/check.mjs — this repo is PUBLIC. Before anything is pushed, check that no tracked file is:
 *   - a key, token or password (common key formats, private keys, .env files)
 *   - a licence file (Unity_lic.ulf, *.ulf, *.alf, signing keystores)
 *   - part of the private studio harness (its folders, its files, its markers)
 *   - marked private or proprietary
 * Runs as the git pre-push hook (.githooks/pre-push; turn it on once: git config core.hooksPath .githooks)
 * and in CI on every push and pull request (.github/workflows/public-guard.yml), so a skipped hook is still
 * caught before a merge. Prints the file and the reason, never the secret itself.
 *
 *   node tools/public-guard/check.mjs            every tracked file
 *   node tools/public-guard/check.mjs --staged   only what is staged (fast, for a pre-commit check)
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).stdout.trim() || process.cwd();
const staged = process.argv.includes('--staged');
const list = spawnSync('git', staged ? ['diff', '--cached', '--name-only', '--diff-filter=ACMR'] : ['ls-files'], { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }).stdout.split('\n').filter(Boolean);
const SELF = 'tools/public-guard/check.mjs';

// Files that must never be in a public repo, by name.
const BAD_NAMES = [
  [/(^|\/)Unity_lic[^/]*$|\.ulf$|\.alf$/i, 'a Unity licence file (it belongs in GitHub Secrets only)'],
  [/(^|\/)\.env(\.[^/]*)?$/i, 'an .env file (keys live there)'],
  [/\.(pem|key|p12|pfx|keystore|jks|mobileprovision)$/i, 'a private key or signing keystore'],
  [/(^|\/)(id_rsa|id_ed25519)[^/]*$/i, 'an SSH key'],
  [/(^|\/)CLAUDE_PACK_REVIEW\.md$|(^|\/)AGENTS\.lite\.md$|(^|\/)\.studio\//, 'a private studio harness file'],
  [/^(harness|hub|cartridges|qa\/golden|studio\/(bible|producer|harness-notes|logs))\//, 'a private studio harness folder'],
];
// Key formats (the value is never printed).
const KEYS = [
  [/AKIA[0-9A-Z]{16}/, 'an AWS access key'],
  [/\bgh[pousr]_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{40,}\b/, 'a GitHub token'],
  [/\bsk-ant-[A-Za-z0-9_-]{20,}/, 'an Anthropic API key'],
  [/\bsk-(?:proj-)?[A-Za-z0-9]{32,}\b/, 'an OpenAI-style API key'],
  [/\bxai-[A-Za-z0-9]{30,}\b/, 'an xAI (Grok) API key'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/, 'a Google API key'],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/, 'a Slack token'],
  [/\b[MNO][A-Za-z\d]{23,25}\.[\w-]{6}\.[\w-]{27,38}\b/, 'a Discord bot token'],
  [/-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/, 'a private key'],
  [/<License\b[^>]*>[\s\S]{0,400}<DeveloperData\b/, 'the contents of a Unity licence file'],
];
// Words that mark a file as private.
const PRIVATE = [
  [/Proprietary:\s*do not share|do not share publicly/i, 'marked private or proprietary'],
  [/\b(?:INTERNAL ONLY|PRIVATE NOTES?|CONFIDENTIAL)\b/, 'marked private or proprietary'],
  // The harness's own code (its file headers and title), not a guide that names its commands.
  [/3D Deep Simulation (?:&|and) AI Game Studio Harness|^ \* harness\/[\w-]+\.mjs —/m, 'text from the private studio harness'],
];

const problems = [];
for (const f of list) {
  if (f === SELF) continue;
  for (const [re, why] of BAD_NAMES) if (re.test(f)) problems.push(`${f}: ${why}`);
  const full = path.join(root, f);
  let st;
  try { st = fs.statSync(full); } catch { continue; }
  if (!st.isFile() || st.size > 2 * 1024 * 1024) continue;
  const buf = fs.readFileSync(full);
  if (buf.includes(0)) continue; // binary
  const text = buf.toString('utf8');
  for (const [re, why] of [...KEYS, ...PRIVATE]) {
    const m = text.match(re);
    if (m) problems.push(`${f}:${text.slice(0, m.index).split('\n').length}: ${why}`);
  }
}
if (problems.length) {
  console.error(`[public-guard] BLOCKED: this repo is public, and ${problems.length} thing(s) must not be pushed:`);
  for (const p of problems) console.error(`  ${p}`);
  console.error('Remove them (licences and keys go in GitHub Secrets; harness files stay in the private harness repo), then push again.');
  process.exit(1);
}
console.log(`[public-guard] OK: ${list.length} file(s) checked, nothing private, no keys, no licence files, no harness files`);
