/**
 * harness/size-rule.mjs — 2.60.0: what a game's manifest may say about the size ratchet (harness/done-check.mjs).
 *
 * The ratchet: a game file over 400 lines (or 30 KB) can't grow, so every lane that registered a module appended to the
 * same joined line of the one big file, and every landing conflicted with every other lane. A game may now declare, in
 * its check manifest (<game root>/studio.gates.json; studio/gates.json for the whole studio):
 *
 *   "sizeRule": { "exempt": ["src/game/modules.ts"], "importLinesFree": true, "exemptMaxLines": 800 }
 *
 *   exempt           files (relative to the manifest's folder, or repo-relative; globs as in "paths") that skip the
 *                    no-growth rule. They still have a hard cap: exemptMaxLines (default twice the file limit, 800) and
 *                    twice the KB limit, so a barrel can't become the next crammed file. Functions in them keep their limit.
 *   importLinesFree  added lines that are only an import or re-export (import … from '…', import '…', export … from '…',
 *                    export * from '…', several on one line, or a whole multi-line import block) don't count as growth,
 *                    net of import lines removed, in any file the manifest covers. Any other added line still does.
 *
 * Only the owner decides this: the manifest counts only where studio/protected.json covers it (game/<name>/ and
 * web/<name>/ manifests and studio/gates.json by default), and it is read as committed on the studio's main branch
 * (else the commit the task's growth is measured from), never from the working copy or the task's own branch. An
 * exemption written anywhere else (a lane's own edit of the manifest, another file, a comment) is ignored, and the
 * refusal says so.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO_ROOT } from './event.mjs';
import { protectedGlobs } from './approve.mjs';
import { globRe, matchAny } from './merge-lane.mjs';

const gitShow = (ref, rel) => {
  const r = spawnSync('git', ['show', `${ref}:${rel}`], { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : null;
};
const parse = (text) => { try { return JSON.parse(text); } catch { return null; } };

/** The manifests that may speak for a file: its game root's studio.gates.json, then studio/gates.json. */
export function manifestsFor(file) {
  const parts = String(file).replace(/\\/g, '/').split('/');
  const out = [];
  if (parts.length > 2 && ['game', 'web', 'cartridges', 'engine'].includes(parts[0])) out.push({ rel: `${parts[0]}/${parts[1]}/studio.gates.json`, root: `${parts[0]}/${parts[1]}` });
  out.push({ rel: 'studio/gates.json', root: '' });
  return out;
}

const cleanRule = (raw) => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const exempt = Array.isArray(raw.exempt) ? raw.exempt.map(String).map((s) => s.trim().replace(/\\/g, '/').replace(/^\.\//, '')).filter(Boolean) : [];
  const max = Number(raw.exemptMaxLines);
  return { exempt, importLinesFree: raw.importLinesFree === true, exemptMaxLines: Number.isFinite(max) && max > 0 ? Math.floor(max) : null };
};

/**
 * The size rule for one file, as `ref` has it. limits: { lines, kb } (scripts/check-function-size.mjs LIMITS()).
 * Returns { exempt, importLinesFree, cap: { lines, kb } | null, source, ignored: [why] }.
 */
export function sizeRuleFor(file, ref, limits, cache = new Map()) {
  const f = String(file).replace(/\\/g, '/');
  const res = { exempt: false, importLinesFree: false, cap: null, source: null, ignored: [] };
  for (const m of manifestsFor(f)) {
    const key = `${ref}\n${m.rel}`;
    if (!cache.has(key)) {
      const globs = ref ? (cache.get(`${ref}\nglobs`) || protectedGlobs(ref)) : null;
      if (ref) cache.set(`${ref}\nglobs`, globs);
      const covered = Boolean(globs) && matchAny(m.rel, globs);
      const committed = ref && covered ? cleanRule(parse(gitShow(ref, m.rel) || '')?.sizeRule) : null;
      // What the working copy says, only to tell an agent why its own edit isn't used.
      let local = null;
      try { local = cleanRule(parse(fs.readFileSync(path.join(REPO_ROOT, m.rel), 'utf8'))?.sizeRule); } catch {}
      cache.set(key, { committed, local, covered });
    }
    const { committed, local, covered } = cache.get(key);
    const inScope = (p) => (m.root ? globRe(`${m.root}/${p}`).test(f) || globRe(p).test(f) : globRe(p).test(f));
    if (local && JSON.stringify(local) !== JSON.stringify(committed) && (local.importLinesFree || local.exempt.some(inScope))) {
      res.ignored.push(covered
        ? `the "sizeRule" in your copy of ${m.rel} isn't used: exemptions come from ${m.rel} as committed on ${ref ? String(ref).slice(0, 40) : 'the studio\'s main branch'} (a protected file the owner approves: npm run approve -- protected)`
        : `${m.rel} isn't a protected file (studio/protected.json), so its "sizeRule" is ignored`);
    }
    if (!committed) continue;
    if (!res.source) res.source = m.rel;
    if (committed.importLinesFree) res.importLinesFree = true;
    if (!res.exempt && committed.exempt.some(inScope)) {
      res.exempt = true;
      res.source = m.rel;
      res.cap = { lines: committed.exemptMaxLines || limits.lines * 2, kb: limits.kb * 2 };
    }
  }
  return res;
}

// ---- import-only lines ----------------------------------------------------------------------------

const Q = String.raw`(?:'[^'\n]*'|"[^"\n]*")`;
const NAMES = String.raw`(?:type\s+)?(?:[\w$]+\s*,\s*)?(?:\*\s*as\s+[\w$]+|\{[^{}]*\}|[\w$]+)`;
const STMT = new RegExp(String.raw`^\s*(?:import\s+(?:${NAMES}\s+from\s+)?${Q}|export\s+(?:type\s+)?(?:\*(?:\s+as\s+[\w$]+)?|\{[^{}]*\})\s+from\s+${Q})\s*(?:with\s*\{[^{}]*\}\s*)?;?`);
const stripComment = (line) => line.replace(/\s*\/\/.*$/, '').replace(/\s*\/\*.*?\*\/\s*$/, '');

/** One line made only of import/re-export statements (one or several, joined). Blank lines are not imports. */
export function isImportLine(line) {
  let s = stripComment(String(line));
  if (!s.trim()) return false;
  for (let i = 0; i < 64 && s.trim(); i += 1) {
    const m = s.match(STMT);
    if (!m) return false;
    s = s.slice(m[0].length);
  }
  return !s.trim();
}

const BLOCK_OPEN = /^\s*(?:import|export)\s+(?:type\s+)?(?:[\w$]+\s*,\s*)?\{[^}]*$/;
const BLOCK_MID = /^\s*(?:type\s+)?[\w$]+(?:\s+as\s+[\w$]+)?\s*,?\s*(?:\/\/.*)?$/;
const BLOCK_CLOSE = new RegExp(String.raw`^\s*(?:(?:type\s+)?[\w$]+(?:\s+as\s+[\w$]+)?\s*,?\s*)?\}\s*from\s+${Q}\s*;?\s*(?:\/\/.*)?$`);

/** How many of these consecutive lines (one side of a hunk) are import-only: single lines and whole blocks. */
export function importLines(lines) {
  let n = 0;
  let bytes = 0;
  for (let i = 0; i < lines.length; i += 1) {
    if (isImportLine(lines[i])) { n += 1; bytes += Buffer.byteLength(lines[i]) + 1; continue; }
    if (BLOCK_OPEN.test(lines[i])) {
      let j = i + 1;
      while (j < lines.length && BLOCK_MID.test(lines[j])) j += 1;
      if (j < lines.length && BLOCK_CLOSE.test(lines[j])) {
        for (let k = i; k <= j; k += 1) bytes += Buffer.byteLength(lines[k]) + 1;
        n += j - i + 1;
        i = j;
      }
    }
  }
  return { n, bytes };
}

/**
 * Import-only lines a change added, net of import-only lines it removed (never below 0), from `base` to the working
 * copy of `file`: { lines, bytes }. Lines inside one hunk are judged together, so a whole import block counts.
 */
export function freeImportLines(base, file) {
  const r = spawnSync('git', ['diff', '-U0', '--no-color', '--no-ext-diff', '--no-renames', base, '--', file], { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) return { lines: 0, bytes: 0 };
  let addN = 0; let addB = 0; let delN = 0; let delB = 0;
  const flush = (plus, minus) => {
    const a = importLines(plus); const d = importLines(minus);
    addN += a.n; addB += a.bytes; delN += d.n; delB += d.bytes;
  };
  let plus = []; let minus = [];
  for (const line of r.stdout.split('\n')) {
    if (line.startsWith('@@')) { flush(plus, minus); plus = []; minus = []; continue; }
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) plus.push(line.slice(1).replace(/\r$/, ''));
    else if (line.startsWith('-')) minus.push(line.slice(1).replace(/\r$/, ''));
  }
  flush(plus, minus);
  return { lines: Math.max(0, addN - delN), bytes: Math.max(0, addB - delB) };
}
