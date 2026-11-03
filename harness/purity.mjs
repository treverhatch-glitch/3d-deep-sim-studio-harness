#!/usr/bin/env node
/**
 * harness/purity.mjs — 2.72.0 (b): `npm run purity`, the purity ratchet's baselines (harness/ratchet.mjs).
 *
 *   npm run purity [-- list] [--json]       standing, new and fixed hits per baseline (the purity check's; a ratchet
 *                                           check's from its last run on this tree)
 *   npm run purity -- baseline --write --by <person> [--permission "<their words>"] [--check <id>] [--no-commit]
 *                                           record today's hits as the standing ones: cartridges/<name>/ and the studio
 *                                           game's purity-baseline.json ("purity"), plus each game check with
 *                                           "ratchet": true (it is run; --check names one). Growing a baseline (or
 *                                           creating one) is a person's decision: from a person's terminal, an agent on
 *                                           a person's --permission (a Producer/Director or an outside agent), or an
 *                                           outside agent under a delegation for "purity-baseline". Never a worker,
 *                                           never in a lane copy. Committed (only these files) unless --no-commit.
 *   npm run purity -- baseline --shrink [--no-commit]
 *                                           drop the hits that are fixed (anyone; task done does this itself)
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT, emitEvent } from './event.mjs';
import * as rat from './ratchet.mjs';

const git = (...a) => spawnSync('git', a, { windowsHide: true, cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const flag = (a, k) => (a.includes(k) ? String(a[a.indexOf(k) + 1] || '') : '');

/** Why this caller may not grow a baseline as `by`, or '' (with `as`: how the decision counts). */
export async function growRefusal({ by, permission = '', env = process.env } = {}) {
  const who = String(by || '').trim();
  if (!who) return { why: 'say which person decides: --by <person>' };
  const { inLaneCopy } = await import('./worktree.mjs');
  if (inLaneCopy()) return { why: 'this is a lane copy: a baseline never grows from a lane (the studio\'s branch, in the main checkout, holds it)' };
  const { WORKER_NAME, agentOnPermission, permissionText } = await import('./permission.mjs');
  const owner = String(env.STUDIO_LOCK_OWNER || '').trim();
  const worker = [who, owner].find((n) => n && WORKER_NAME.test(n));
  if (worker) return { why: `${worker} is a worker agent: a worker never grows a baseline, with or without permission; hand the task back with a note naming the hits and why` };
  const { ownerShellRefusal, delegationFor, recordUse } = await import('./delegation.mjs');
  const agentWhy = ownerShellRefusal({ env, lane: false });
  if (!agentWhy) return { why: '', as: 'person' };
  const d = delegationFor({ action: 'purity-baseline', by: who, env, autonomy: false });
  if (d.ok) { recordUse(d, { action: 'purity-baseline' }); return { why: '', as: 'delegation', permission: d.permission }; }
  const perm = permissionText(permission);
  if (perm) {
    const rec = agentOnPermission({ permission: perm, env });
    if (rec.ok) return { why: '', as: 'permission', permission: `${perm.slice(0, 300)} (recorded by ${rec.recordedBy})` };
    return { why: rec.why };
  }
  return { why: `${agentWhy}: growing a baseline accepts standing hits, a person's decision. Ask them, then run it with --permission "<their words, or a link to the message>"${d.why ? ` (${d.why})` : ''}` };
}

async function currentSections({ only = '' } = {}) {
  const gameRoot = (await rat.ratchetChecks()).root;
  const out = new Map(); // rel -> { section: Map }
  const put = (rel, sec, m) => { if (!out.has(rel)) out.set(rel, {}); out.get(rel)[sec] = m; };
  if (!only || only === rat.PURITY_SECTION) {
    const lines = rat.purityHits(REPO_ROOT);
    if (lines === null) throw new Error('the purity check gave no hits list (node scripts/check-sim-purity.mjs --hits-json)');
    const by = new Map();
    for (const h of rat.parseHits(lines.join('\n'), { root: REPO_ROOT })) {
      const rel = rat.baselineRelFor(h.file, { gameRoot });
      if (!rel) continue;
      if (!by.has(rel)) by.set(rel, []);
      by.get(rel).push(h);
    }
    for (const [rel, list] of by) put(rel, rat.PURITY_SECTION, rat.countHits(list));
    // A cartridge or game with no hit gets an empty baseline too only when asked for by name (nothing to record).
  }
  const { root, gates } = await rat.ratchetChecks();
  for (const g of gates) {
    if (only && only !== g.id) continue;
    const r = spawnSync(g.command, { cwd: REPO_ROOT, shell: true, encoding: 'utf8', env: { ...process.env, CI: 'true' }, maxBuffer: 64 * 1024 * 1024, windowsHide: true });
    const hits = rat.parseHits(`${r.stdout || ''}${r.stderr || ''}`, { root: REPO_ROOT });
    if (r.status !== 0 && !hits.length) throw new Error(`${g.id} exited ${r.status} with no hit line to record (fix the crash first)`);
    put(`${root}/${rat.BASELINE_NAME}`, g.id, rat.countHits(hits));
  }
  return out;
}

function grows(rel, sections) {
  let doc = null;
  try { doc = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8')); } catch {}
  if (!doc) return true;
  for (const [sec, m] of Object.entries(sections)) {
    const had = rat.sectionMap(doc, sec);
    if (!Array.isArray(doc.hits?.[sec])) return true;
    for (const [k, e] of m) if (e.count > (had.get(k)?.count || 0)) return true;
  }
  return false;
}

export async function purityCli(argv = process.argv.slice(2)) {
  const sub = argv[0] && !argv[0].startsWith('-') ? argv[0] : 'list';
  if (sub === 'baseline' && argv.includes('--shrink')) {
    const r = rat.shrinkBaselines({ commit: !argv.includes('--no-commit'), agent: process.env.STUDIO_LOCK_OWNER || null });
    console.log(r.shrunk.length ? `[purity] ${r.removed} fixed hit(s) removed from ${r.shrunk.join(', ')}${r.commit ? ` (commit ${r.commit})` : ''}` : r.error ? `[purity] not shrunk: the commit was refused (${r.error}); the files are as they were` : '[purity] nothing to shrink: every hit in the baselines still stands (a ratchet check\'s fixed hits count once it has run on this clean tree)');
    return r.error ? 1 : 0;
  }
  if (sub === 'baseline' && argv.includes('--write')) {
    const by = flag(argv, '--by');
    if ((await import('./worktree.mjs')).inLaneCopy()) { console.error('[purity] refused: this is a lane copy: a baseline is written on the studio\'s branch, never from a lane (a lane only shrinks it: npm run purity -- baseline --shrink, which task done runs). Nothing was written.'); return 1; }
    const sections = await currentSections({ only: flag(argv, '--check') });
    if (!sections.size) { console.log('[purity] no hit to record: no baseline written (a game with no hits needs none)'); return 0; }
    const growing = [...sections].filter(([rel, secs]) => grows(rel, secs)).map(([rel]) => rel);
    let as = 'shrink';
    let permission = '';
    if (growing.length || !by) {
      const ref = await growRefusal({ by, permission: flag(argv, '--permission') });
      if (ref.why) { console.error(`[purity] refused: ${ref.why}. Nothing was written.`); return 1; }
      as = ref.as;
      permission = ref.permission || '';
    }
    const at = new Date().toISOString();
    const files = [];
    for (const [rel, secs] of sections) { rat.writeBaseline(REPO_ROOT, rel, secs, { by, at, permission }); files.push(rel); }
    const total = [...sections.values()].reduce((n, secs) => n + Object.values(secs).reduce((k, m) => k + [...m.values()].reduce((x, e) => x + e.count, 0), 0), 0);
    let sha = null;
    if (!argv.includes('--no-commit') && git('rev-parse', '--verify', 'HEAD').status === 0) {
      git('add', '--', ...files);
      const c = git('commit', '-q', '--only', '-m', `purity baseline: ${total} standing hit(s) recorded by ${by}`, '-m', `Why: the ratchet (harness/ratchet.mjs) fails only on hits not listed here.${permission ? ` Permission: ${permission}` : ''}`, '--', ...files);
      if (c.status === 0) sha = (git('rev-parse', 'HEAD').stdout || '').trim().slice(0, 8);
      else console.error(`[purity] written but not committed: ${`${c.stderr || c.stdout}`.trim().slice(0, 300)}`);
    }
    try { emitEvent({ type: 'purity.baseline', agent: by, to: 'producer', msg: `purity baseline written by ${by} (${as}): ${total} standing hit(s) in ${files.join(', ')}${growing.length ? `; grew ${growing.join(', ')}` : ''}`.slice(0, 500), meta: { files, total, grew: growing, as, commit: sha } }); } catch {}
    if (growing.length) { try { (await import('./decisions-log.mjs')).logDecision({ action: 'purity-baseline', subject: files.join(', '), by, as, why: permission || `${total} standing hit(s) recorded`, undo: sha ? `git revert ${sha}` : null }); } catch {} }
    console.log(`[purity] baseline written: ${total} standing hit(s) in ${files.join(', ')}${sha ? ` (commit ${sha})` : ''}. From now on only new hits fail.`);
    return 0;
  }
  if (sub === 'list') {
    const gameRoot = (await rat.ratchetChecks()).root;
    const lines = rat.purityHits(REPO_ROOT) || [];
    const j = rat.judgeHits(rat.parseHits(lines.join('\n'), { root: REPO_ROOT }), { root: REPO_ROOT, relOf: (h) => rat.baselineRelFor(h.file, { gameRoot }), base: await rat.laneBase() });
    if (argv.includes('--json')) { console.log(JSON.stringify({ fresh: j.fresh.map((h) => h.text), standing: j.standing, fixed: j.fixed, grown: j.grown, baselines: j.ratcheted })); return 0; }
    if (!rat.knownBaselines(REPO_ROOT).length) console.log('[purity] no baseline: every hit fails (npm run purity -- baseline --write --by <person> records the standing ones)');
    for (const l of rat.ratchetLines(j, { label: '[purity]' })) console.log(l);
    for (const rel of rat.knownBaselines(REPO_ROOT)) {
      let doc = null;
      try { doc = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8')); } catch {}
      for (const [sec, list] of Object.entries(doc?.hits || {})) console.log(`[purity] ${rel} ${sec}: ${list.reduce((n, e) => n + (Number(e.count) || 1), 0)} standing hit(s)${doc.by ? ` (recorded by ${doc.by})` : ''}`);
    }
    return 0;
  }
  console.log('Usage: npm run purity [-- list [--json]] | baseline --write --by <person> [--permission "…"] [--check <id>] [--no-commit] | baseline --shrink [--no-commit]');
  return sub === 'help' || argv.includes('--help') ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) process.exit(await purityCli());
