#!/usr/bin/env node
/**
 * harness/gate-cache.mjs — a file-based cache for gate runs.
 *
 * A gate run is cached when it passes. The key is a hash of the gate's command and the content of
 * every file in the repo that could affect its outcome. A cache hit skips the run.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE_FILE = path.join(REPO_ROOT, '.studio', 'gate-cache.json');
const EXCLUSIONS = ['.studio/', 'studio/events', 'qa/reports/'];

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');

function readCache() {
  if (!fs.existsSync(CACHE_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function writeCache(cache) {
  fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
}

// Every file a gate could read: git's list when this is a git checkout, else a walk of the folder (a copy
// with no .git, as the self-test makes; an empty list would make every run look unchanged).
function listFiles() {
  const r = spawnSync('git', ['ls-files', '-co', '--exclude-standard'], { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status === 0 && String(r.stdout).trim()) return String(r.stdout).split('\n').filter(Boolean);
  const out = [];
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(REPO_ROOT, rel), { withFileTypes: true })) {
      if (['node_modules', '.git', '.studio', 'dist'].includes(e.name)) continue;
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out.push(p);
    }
  };
  walk('');
  return out;
}

function getContentHash(gate) {
  const files = listFiles();

  const relevantFiles = files.filter((f) => {
    if (EXCLUSIONS.some((ex) => f.startsWith(ex))) return false;
    if (gate.inputs) {
      return gate.inputs.some((input) => (input.endsWith('/') ? f.startsWith(input) : f === input));
    }
    return true;
  }).sort();

  if (relevantFiles.length === 0) return null; // nothing to hash: never cache

  const hashes = relevantFiles.map((f) => {
    try {
      const fullPath = path.join(REPO_ROOT, f);
      const content = fs.readFileSync(fullPath);
      return `${f}\0${sha256(content)}`;
    } catch {
      return `${f}\0`; // file might be gone between ls-files and read
    }
  });

  return sha256(hashes.join('\n'));
}

export function getKey(gate) {
  const contentHash = getContentHash(gate);
  if (!contentHash) return null;
  // The cartridge picked by env changes what a gate tests, so it is part of the key.
  return sha256(`${gate.command}\0${process.env.STUDIO_CARTRIDGE || ''}\0${contentHash}`);
}

export function get(gate, key = getKey(gate)) {
  if (!key) return null;
  const cache = readCache();
  return cache[key];
}

export function set(gate, ms) {
  const cache = readCache();
  const key = getKey(gate);
  if (!key) return;
  cache[key] = { id: gate.id, at: new Date().toISOString(), ms };
  writeCache(cache);
}

export function delByKey(key) {
  if (!key) return;
  const cache = readCache();
  if (cache[key]) {
    delete cache[key];
    writeCache(cache);
  }
}

export function del(gate) {
  delByKey(getKey(gate));
}
