/**
 * harness/golden-report.mjs — 2.73.0 (g, A13): a re-recorded golden needs the harness's first-divergence report and a
 * second signer.
 *
 * When a golden goes red (qa/check-golden.mjs, or a game's golden check with a "divergence" contract, harness/divergence.mjs)
 * or is re-recorded with a changed answer (npm run golden -- --update), the harness writes its first-divergence report:
 *   .studio/gates/divergence/<golden path, / as __>.json   { entries: [newest first, at most 8] }
 * Each entry names the golden (rel), the blob of the recorded answer it was red against (blob: what the re-record
 * replaces), the tick, subsystem and field where the run first went wrong, the reference commit, who ran it, and a
 * signature with the studio's verify key (harness/verify-key.mjs): an entry written by hand doesn't count.
 *
 * The merge train (rule golden-rerecord, tier C) finds, for each golden the lane re-records, the signed entry whose
 * blob is the golden as it was where the lane branched (main's recorded answer): the lane carries it in its queue
 * entry, the hold shows it to the releaser, and the release
 *   - needs a releaser who is not the lane's author (its agent, or a Studio-Agent trailer of its commits): a person, a
 *     delegation or autonomous review by another agent;
 *   - without a report (the divergence couldn't run, or no golden check ran before the re-record) says so and needs a
 *     person (a delegation or autonomous review is refused);
 *   - records each report's tick and field in the decision log.
 * The train's own re-records (pin refresh) and upgrade merges are not lane commits: unchanged.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { signPayload, checkSignature } from './verify-key.mjs';

const git = (cwd, args) => spawnSync('git', ['-c', 'core.quotePath=false', ...args], { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
const out = (r) => (r && r.status === 0 ? String(r.stdout || '').trim() : '');

export const REPORT_DIR = path.join('gates', 'divergence'); // under .studio/
export const reportName = (rel) => `${String(rel).replace(/\\/g, '/').replace(/\.json$/i, '').replace(/[/:]+/g, '__')}.json`;
const MAX_ENTRIES = 8;
const FIELDS = ['rel', 'blob', 'answer', 'found', 'tick', 'subsystem', 'field', 'from', 'to', 'ref', 'reproduces', 'error', 'gate', 'head', 'at', 'agent', 'by'];

/** What an entry's signature covers: every field it names, in a fixed order. */
export const entryPayload = (e) => `golden-report\n${JSON.stringify(FIELDS.map((k) => e?.[k] ?? null))}`;

/** The blob id git gives the file as it is now (its recorded answer before a re-record), or ''. */
function blobOf(root, rel) {
  return out(git(root, ['hash-object', '--', rel]));
}

/**
 * Write the report for these goldens (repo paths) from one divergence result (harness/divergence.mjs: { found, tick,
 * subsystems, field, from, to, ref, reproduces } or { error }). Call it BEFORE a re-record overwrites the file. `answer`
 * (a cartridge golden: the sha256 this tree produces) ties it to the new answer too. Signed when the studio has (or can
 * make) a verify key. Returns the entries written; never throws.
 */
export function writeGoldenReport(root, rels, d, { by = 'qa/check-golden.mjs', gate = null, answer = null, env = process.env } = {}) {
  const written = [];
  try {
    const dir = path.join(root, '.studio', REPORT_DIR);
    fs.mkdirSync(dir, { recursive: true });
    const head = out(git(root, ['rev-parse', 'HEAD'])) || null;
    const show = (v) => (v === undefined ? null : typeof v === 'string' ? v.slice(0, 200) : JSON.stringify(v).slice(0, 200));
    for (const rel0 of [...new Set((rels || []).map((r) => String(r).replace(/\\/g, '/')).filter(Boolean))]) {
      const blob = blobOf(root, rel0);
      if (!blob) continue;
      const e = { rel: rel0, blob, answer: answer || null, found: d?.error ? null : Boolean(d?.found), tick: Number.isFinite(d?.tick) ? d.tick : null, subsystem: d?.subsystems?.[0] || d?.subsystem || null, field: d?.field || null, from: d?.found ? show(d.from) : null, to: d?.found ? show(d.to) : null, ref: d?.ref || null, reproduces: d?.reproduces ?? null, error: d?.error ? String(d.error).slice(0, 300) : null, gate: gate || d?.gate || null, head, at: new Date().toISOString(), agent: String(env.STUDIO_LOCK_OWNER || '').trim() || null, by };
      const sig = signPayload(root, entryPayload(e), { create: true, env });
      if (!sig.error) e.sig = sig;
      const f = path.join(dir, reportName(rel0));
      let doc = { entries: [] };
      try { const j = JSON.parse(fs.readFileSync(f, 'utf8')); if (Array.isArray(j?.entries)) doc = j; } catch {}
      doc.entries = [e, ...doc.entries.filter((x) => !(x && x.blob === e.blob && x.head === e.head && x.agent === e.agent))].slice(0, MAX_ENTRIES);
      const tmp = `${f}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`);
      fs.renameSync(tmp, f);
      written.push(e);
    }
  } catch { /* a report is a help to the release; a write that fails leaves "no report" (a person releases) */ }
  return written;
}

/**
 * The report for one re-recorded golden: the newest signed entry for `rel` against `blob` (the golden where the lane
 * branched) in any of the .studio/ folders given. { ok, entry, why }: ok is false with why in plain words when there is
 * none, it is unsigned, or the divergence couldn't run (entry then holds the error).
 */
export function findGoldenReport(studioDirs, rel, blob, { answer = null } = {}) {
  let unsigned = '';
  let other = '';
  let failed = null;
  for (const d of [...new Set((studioDirs || []).filter(Boolean).map((x) => path.resolve(x)))]) {
    let doc = null;
    try { doc = JSON.parse(fs.readFileSync(path.join(d, REPORT_DIR, reportName(rel)), 'utf8')); } catch { continue; }
    for (const e of Array.isArray(doc?.entries) ? doc.entries : []) {
      if (!e || e.rel !== rel || e.blob !== blob) continue;
      const s = checkSignature(path.dirname(d), entryPayload(e), e.sig);
      if (!s.ok) { unsigned ||= s.text; continue; }
      if (e.answer && answer && e.answer !== answer) { other ||= `the harness's report is for another new answer (${String(e.answer).slice(0, 12)}…, the lane records ${String(answer).slice(0, 12)}…)`; continue; }
      if (e.error) { failed ||= e; continue; }
      return { ok: true, entry: e, why: '' };
    }
  }
  if (failed) return { ok: false, entry: failed, why: `the harness couldn't find the first divergence (${failed.error})` };
  if (other) return { ok: false, entry: null, why: other };
  if (unsigned) return { ok: false, entry: null, why: `the report there is not the harness's (${unsigned})` };
  return { ok: false, entry: null, why: 'no golden check ran on it before the re-record (node qa/check-golden.mjs, or the game\'s golden check, writes the report on a red)' };
}

/** "tick 23, resources.credits 1936 -> 1937 (subsystem resources)" for an entry. */
export const reportText = (e) => (!e ? '' : e.found === false ? 'no divergence: the run matches the reference tick for tick (the golden file was changed by hand or recorded from other code)' : `tick ${e.tick}, ${e.field ? `${e.field} ${e.from} -> ${e.to}` : 'state differs'} (subsystem ${e.subsystem || '?'})`);

/** One line per golden for a hold, a release message and the decision log. */
export function reportLine(r) {
  if (r.ok) return `first divergence for ${r.rel}: ${reportText(r.entry)} (the harness's report${r.entry.agent ? `, run by ${r.entry.agent}` : ''}${r.entry.ref ? `, vs ${String(r.entry.ref).slice(0, 8)}` : ''})`;
  return `no first-divergence report for ${r.rel}: ${r.why}; only a person releases it`;
}

/**
 * The names that count as the lane's author: its agent and the Studio-Agent trailers of its own commits. 2.79 (c): a merge
 * of main into the lane (a lane refresh, the train's catch-up: every parent but the first is in main's history, `tip`) is
 * nobody's authorship, nor is a commit main already has; so the orchestrator whose only commits on a lane are lane-refresh
 * merges can be its second signer. A merge that brings in commits main hasn't (another branch) still counts.
 */
export function laneAuthors(root, base, head, agent = null, { tip = null } = {}) {
  const names = new Set();
  if (String(agent || '').trim()) names.add(String(agent).trim());
  const main = tip || out(git(root, ['rev-parse', '--verify', '--quiet', 'refs/heads/main'])) || out(git(root, ['rev-parse', '--verify', '--quiet', 'refs/heads/master']));
  const r = git(root, ['log', '--format=%x1e%H %P%x09%(trailers:key=Studio-Agent,valueonly,separator=%x2C)', `${base}..${head}`, ...(main ? [`^${main}`] : [])]);
  const inMain = (sha) => Boolean(main) && git(root, ['merge-base', '--is-ancestor', sha, main]).status === 0;
  for (const block of out(r).split('\x1e').filter((b) => b.trim())) {
    const [shas = '', tags = ''] = block.replace(/\n+$/, '').split('\t');
    const parents = shas.trim().split(/\s+/).slice(1);
    if (parents.length > 1 && parents.slice(1).every(inMain)) continue; // a merge of main: no one's authorship
    for (const n of tags.split(',')) if (n.trim()) names.add(n.trim());
  }
  return [...names].slice(0, 12);
}

/**
 * For a lane classified by harness/tiers.mjs (c): the goldens it re-records under rule golden-rerecord at tier C, each
 * with its report. Adds c.rerecord = { reports: [{ rel, ok, entry, why }], authors } and one line per golden to c.why.
 * Changes c in place. Never throws.
 */
export function rerecordTier(root, c, { base, head, agent = null, dirs = [], tip = null } = {}) {
  try {
    const files = (c?.files || []).filter((f) => f.tier === 'C' && (f.rules || []).includes('golden-rerecord'));
    if (!files.length || c.tier !== 'C') return c;
    const studios = [...dirs.filter(Boolean).map((d) => path.join(d, '.studio')), path.join(root, '.studio')];
    const reports = files.map((f) => {
      const blob = out(git(root, ['rev-parse', '--verify', '--quiet', `${base}:${f.path}`]));
      let answer = null;
      try { answer = JSON.parse(out(git(root, ['show', `${head}:${f.path}`]))).sha256 || null; } catch { /* not a cartridge golden: matched by its recorded answer only */ }
      const r = blob ? findGoldenReport(studios, f.path, blob, { answer: typeof answer === 'string' ? answer : null }) : { ok: false, entry: null, why: `${f.path} is not in main where the lane branched` };
      return { rel: f.path, ...r };
    });
    c.rerecord = { reports, authors: laneAuthors(root, base, head, agent, { tip }) };
    c.why = [...c.why, ...reports.map(reportLine)];
  } catch { /* the rule's hold stands without the report lines */ }
  return c;
}

const same = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase() && String(a || '').trim() !== '';

/**
 * Why this release of a held re-record is refused, or ''. held.rerecord from rerecordTier. who: { by (the person),
 * agent (a delegation's or autonomous agent), recordedBy (an agent recording a person's permission), delegated }.
 */
export function rerecordRefusal(held, { by = '', agent = '', recordedBy = '', delegated = false, beta = false } = {}) {
  const rr = held?.rerecord;
  if (!rr || !Array.isArray(rr.reports) || !rr.reports.length) return '';
  const authors = Array.isArray(rr.authors) ? rr.authors : [];
  const signer = [agent, recordedBy, by].find((n) => authors.some((a) => same(a, n)));
  if (signer) return `${signer} is this lane's author (${authors.join(', ')}): a re-recorded golden needs a second signer, a person, a delegation or autonomous review by another agent`;
  const missing = rr.reports.filter((r) => !r.ok);
  // 2.76.0: in beta mode the owner's stand-in may release it without the report (logged; the author rule above stays).
  if (missing.length && delegated && !beta) return `${missing.map(reportLine).join('; ')}. Without the harness's first-divergence report a delegation or autonomous review can't release a re-recorded golden: a person does (npm run task -- train release <ID> --by <name>)`;
  return '';
}

/** The decision log's evidence for a released re-record: each golden's tick and field, or that it had no report. */
export const rerecordEvidence = (held) => (held?.rerecord?.reports || []).map((r) => (r.ok ? `${r.rel}: first divergence ${reportText(r.entry)}` : `${r.rel}: no first-divergence report (${r.why})`)).join('; ');
