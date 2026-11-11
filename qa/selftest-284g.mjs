/**
 * qa/selftest-284g.mjs — 2.84 (g): the studio's same-family review switch (studio/review.json: auto | on | off).
 *
 * The owner's decision: the overseer may turn same-family reviews on and off; a second model family is the stronger
 * check, but the studio is in beta with limited resources. `auto` is the 2.83/2.84 (b) rule; `on` counts a same-family
 * review (header still written, so each is visible); `off` never counts one. `npm run review -- same-family` flips it, with
 * the harness's protected-decision verdict (permission.mjs mayDecide 'tests'): a person, the owner's stand-ins, not a Producer/Director
 * session may, a worker session never. No environment variable turns it on; the checks read the main checkout's file.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export async function selftest284G({ dir, report, tmpRoot }) {
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const guard = async (name, fn) => { try { const [ok, detail] = await fn(); report(name, Boolean(ok), ok ? '' : String(detail || '').slice(0, 3000)); } catch (e) { report(name, false, String(e?.stack || e).slice(0, 3000)); } };
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const git = (cwd, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'core.autocrlf=false', ...a], { windowsHide: true, cwd, encoding: 'utf8', env: { ...process.env, ...ident } });
  const clean = {};
  for (const k of Object.keys(process.env)) if (/^(CLAUDE|CODEX|CURSOR|AIDER|GEMINI|STUDIO_|AGENT_|AI_AGENT|ANTHROPIC|OPENAI)/i.test(k)) clean[k] = '';
  const base = {
    ...clean, ...ident, STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_VERIFY_DETACH: 'off', STUDIO_HOOKS_CHECK: 'off', STUDIO_MACHINE_SCAN: 'off',
    STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-284g-${process.pid}.pem`), CI: '', GITHUB_ACTIONS: '', NODE_OPTIONS: '', npm_lifecycle_event: '',
  };
  const S = path.join(tmpRoot, `284g-studio-${process.pid}`);
  fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
  for (const x of ['.studio', '.env', 'studio/models.json', 'studio/task-holds.json', 'studio/beta.json', 'studio/review.json', 'studio/delegation.json']) fs.rmSync(path.join(S, x), { recursive: true, force: true });
  const ev = path.join(S, '.studio', 'events-284g.jsonl');
  fs.mkdirSync(path.dirname(ev), { recursive: true });
  fs.writeFileSync(ev, '');
  const env = { ...base, AGENT_EVENTS_FILE: ev };
  const cli = (e, cmd) => spawnSync(process.execPath, cmd, { windowsHide: true, cwd: S, env: { ...process.env, ...env, ...e }, encoding: 'utf8', timeout: 180000 });
  const u = (rel) => JSON.stringify(pathToFileURL(path.join(S, rel)).href);
  const ENVF = path.join(S, '.env');
  const SWITCH = path.join(S, 'studio', 'review.json');
  const DECISIONS = path.join(S, '.studio', 'decisions.jsonl');
  const setDotenv = (text) => { fs.rmSync(ENVF, { force: true }); if (text !== null) fs.writeFileSync(ENVF, `${text}\n`); };
  const setSwitch = (v) => { fs.rmSync(SWITCH, { force: true }); if (v !== null) fs.writeFileSync(SWITCH, typeof v === 'string' ? v : JSON.stringify(v)); };
  const sw = (value) => ({ sameFamily: value, by: 'patch', at: '2026-11-12T01:02:03.000Z', why: 'beta, one model family' });
  const TWO = 'STUDIO_AGENT_MODEL=claude-opus-5-5\nSTUDIO_RESCUE_MODELS=gpt-5-codex';
  const ONE = 'STUDIO_AGENT_MODEL=claude-opus-5-5\nSTUDIO_REVIEWER_MODEL=claude-sonnet-5-5';
  const THREE = `${ONE}\nSTUDIO_RESCUE_MODELS=gpt-5-codex`;
  const blank = { STUDIO_AGENT_MODEL: '', STUDIO_REVIEWER_MODEL: '', STUDIO_RESCUE_MODELS: '', STUDIO_REVIEW_TOOLS: '', STUDIO_REVIEWER_TOOL: '' };
  const oneFam = { ...blank, STUDIO_AGENT_MODEL: 'claude-opus-5-5' };
  const OLD_H = 'same-family: no other family available';
  const NEW_H = 'same-family: allowed by the studio';

  git(S, 'init', '-q');
  git(S, 'add', '-A');
  git(S, 'commit', '-q', '-m', 'init', '--no-verify');
  const add = cli({}, ['harness/task.mjs', 'add', 'Rates', '--type', 'system']);
  const id = (out(add).match(/"id":\s*"(T-\d+)"/) || [])[1];
  if (id) {
    cli({ STUDIO_LOCK_OWNER: 'builder-g1' }, ['harness/task.mjs', 'start', id, '--agent', 'builder-g1', '--model', 'claude-opus-5-5']);
    fs.writeFileSync(path.join(S, 'GUIDE.md'), 'rates\n');
    git(S, 'add', '-A');
    git(S, 'commit', '-q', '-m', 'rates', '--no-verify', '--trailer', `Studio-Task: ${id}`);
  } else report('setup: a system task in the studio copy', false, out(add));
  const reviewText = (header) => `model-family: anthropic\nimplementer-family: anthropic\n${header ? `${header}\n` : ''}\nReview of ${id}: rates look right.\nVerdict: approve\n`;
  const rfile = (header, tag) => { const f = path.join(tmpRoot, `284g-review-${tag}-${process.pid}.md`); fs.writeFileSync(f, reviewText(header)); return f; };
  const record = (e, header, tag = 'r') => cli({ ...e, STUDIO_LOCK_OWNER: 'producer-1' }, ['harness/review.mjs', 'record', id, '--by', 'opus-reviewer', '--family', 'anthropic', '--file', rfile(header, tag), '--implementer', 'claude-opus-5-5', '--no-commit']);
  const reviewsDir = path.join(S, 'studio', 'reviews');
  const clearReviews = () => { try { for (const f of fs.readdirSync(reviewsDir)) if (f !== 'README.md') fs.rmSync(path.join(reviewsDir, f), { force: true }); } catch { /* none yet */ } };
  const writeDoneReview = (header) => { fs.mkdirSync(reviewsDir, { recursive: true }); fs.writeFileSync(path.join(reviewsDir, '2026-11-01-rates-284g.md'), reviewText(header)); };
  const approvedLine = (e) => (out(cli({ ...e, STUDIO_PRODUCER_NAME: 'prod-1' }, ['harness/done-check.mjs', id])).split('\n').find((l) => /Approved by a reviewer from another model family/.test(l)) || '(no such line)');
  const events = () => fs.readFileSync(ev, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const probe = (name, body, e = blank) => {
    const f = path.join(tmpRoot, `probe-284g-${name}-${process.pid}.mjs`);
    fs.writeFileSync(f, body);
    const r = cli(e, [f]);
    try { fs.rmSync(f, { force: true }); } catch { /* swept later */ }
    const line = String(r.stdout || '').split('\n').filter((l) => l.startsWith('{')).pop();
    try { return { j: JSON.parse(line), raw: out(r) }; } catch { return { j: {}, raw: out(r) }; }
  };
  const clearAll = () => { setSwitch(null); setDotenv(null); clearReviews(); fs.rmSync(DECISIONS, { force: true }); fs.writeFileSync(ev, ''); };

  // ---- auto: part (b) unchanged ----
  await guard('auto (no studio/review.json), two families in .env: a same-family review with the old header is still refused, and the refusal now names the setting (auto) and the command that changes it (fails before this fix: no setting named)', () => {
    clearAll(); setDotenv(TWO);
    const r = record(oneFam, OLD_H);
    return [r.status !== 0 && /openai is configured \(found in \.env\)/.test(out(r)) && /setting is auto/.test(out(r)) && /npm run review -- same-family on\|off\|auto --by <who>/.test(out(r)) && /never a worker session/.test(out(r)), out(r)];
  });
  await guard('auto, one family only: the old header is accepted, no "studio allows" line is printed, and the allowed-by-the-studio header does NOT count under auto', () => {
    clearAll(); setDotenv(ONE);
    const a = record(oneFam, OLD_H, 'a');
    const written = (() => { try { return fs.readdirSync(reviewsDir).filter((f) => /outside/.test(f)); } catch { return []; } })();
    clearReviews();
    const b = record(oneFam, NEW_H, 'b');
    return [a.status === 0 && written.length === 1 && !/studio allows/.test(out(a)) && b.status !== 0 && /Refused/.test(out(b)), `${out(a)} | ${out(b)}`];
  });

  // ---- on ----
  await guard('on with two families configured: a same-family review with the old header and one with the new header are accepted by review record; the accept line names who set it and when; the file carries the header (fails before this fix: refused because another family is configured)', () => {
    clearAll(); setDotenv(TWO); setSwitch(sw('on'));
    const a = record(oneFam, OLD_H, 'a');
    const fa = fs.readdirSync(reviewsDir).filter((f) => /outside/.test(f));
    const textA = fa.length ? fs.readFileSync(path.join(reviewsDir, fa[0]), 'utf8') : '';
    clearReviews();
    const b = record(oneFam, NEW_H, 'b');
    const fb = fs.readdirSync(reviewsDir).filter((f) => /outside/.test(f));
    const textB = fb.length ? fs.readFileSync(path.join(reviewsDir, fb[0]), 'utf8') : '';
    const line = /counted because the studio allows same-family reviews \(set by patch on 2026-11-12\)/;
    return [a.status === 0 && b.status === 0 && line.test(out(a)) && line.test(out(b)) && textA.includes(OLD_H) && textB.includes(NEW_H), `${out(a)} | ${out(b)}`];
  });
  await guard('on with two families: done-check counts a same-family approval carrying either header (fails before this fix: not counted)', () => {
    clearAll(); setDotenv(TWO); setSwitch(sw('on'));
    writeDoneReview(NEW_H);
    const a = approvedLine(oneFam);
    clearReviews(); writeDoneReview(OLD_H);
    const b = approvedLine(oneFam);
    return [/^\s*\[x\]/.test(a) && /^\s*\[x\]/.test(b), `${a} | ${b}`];
  });
  await guard('on, a same-family review without any header is refused with a line that says which header to write (fails before this fix: no such line)', () => {
    clearAll(); setDotenv(TWO); setSwitch(sw('on'));
    const r = record(oneFam, null);
    return [r.status !== 0 && /Refused/.test(out(r)) && out(r).includes(NEW_H) && /allows same-family reviews/.test(out(r)), out(r)];
  });

  // ---- off ----
  await guard('off with ONE family configured: the review is refused with the old header and with the new one; the message names the setting (off) and the command and who may run it (fails before this fix: the old header was accepted)', () => {
    clearAll(); setDotenv(ONE); setSwitch(sw('off'));
    const a = record(oneFam, OLD_H, 'a');
    const b = record(oneFam, NEW_H, 'b');
    const ok = (r) => r.status !== 0 && /switched off in studio\/review\.json \(set by patch on 2026-11-12\)/.test(out(r)) && /npm run review -- same-family on\|off\|auto --by <who>/.test(out(r)) && /the overseer/.test(out(r));
    return [ok(a) && ok(b), `${out(a)} | ${out(b)}`];
  });
  await guard('off with ONE family: done-check does not count a same-family approval with the header, and the line says the switch is off (fails before this fix: counted)', () => {
    clearAll(); setDotenv(ONE); setSwitch(sw('off')); writeDoneReview(OLD_H);
    const l = approvedLine(oneFam);
    return [/^\s*\[ \]/.test(l) && /switched off/.test(l), l];
  });

  // ---- the command ----
  const SET = (e, value, by = 'pat', why = 'beta: one family for now') => cli(e, ['harness/review.mjs', 'same-family', ...(value ? [value] : []), ...(by ? ['--by', by] : []), ...(why ? ['--why', why] : [])]);
  const readSwitch = () => { try { return JSON.parse(fs.readFileSync(SWITCH, 'utf8')); } catch { return null; } };
  const decisionLines = () => { try { return fs.readFileSync(DECISIONS, 'utf8').split('\n').filter((l) => /same-family-review/.test(l)); } catch { return []; } };
  await guard('a person in their own terminal sets on: studio/review.json holds on/by/at/why, one review.same_family event carries to/was/by/via, one decisions-log line is written (fails before this fix: no such command)', () => {
    clearAll();
    const r = SET({}, 'on', 'pat', 'beta: one family for now');
    const j = readSwitch();
    const e = events().filter((x) => x.type === 'review.same_family');
    const d = decisionLines();
    const m = e[0]?.meta || {};
    return [r.status === 0 && j?.sameFamily === 'on' && j.by === 'pat' && Number.isFinite(Date.parse(j.at)) && j.why === 'beta: one family for now' && e.length === 1 && m.to === 'on' && m.was === 'auto' && m.by === 'pat' && m.via === 'person' && d.length === 1 && /"by":"pat"/.test(d[0]), `${out(r)} | ${JSON.stringify(j)} | ${JSON.stringify(e)} | ${d}`];
  });
  await guard('printing with no value changes no file, shows the setting, who set it and when, and the configured families', () => {
    clearAll(); setDotenv(TWO); setSwitch(sw('on'));
    const before = fs.readFileSync(SWITCH, 'utf8');
    const nEvents = events().length;
    const r = SET({}, null, null, null);
    return [r.status === 0 && /Same-family review: on \(set by patch on 2026-11-12 01:02 UTC: beta, one model family\)/.test(out(r)) && /anthropic/.test(out(r)) && /openai \([^)]*\.env/.test(out(r)) && fs.readFileSync(SWITCH, 'utf8') === before && events().length === nEvents && decisionLines().length === 0, out(r)];
  });
  await guard('a launched builder session is refused under any --by and the file is unchanged; a worker name in --by from a person\'s terminal is refused too (fails before this fix: no such command)', () => {
    clearAll(); setSwitch(sw('off'));
    const before = fs.readFileSync(SWITCH, 'utf8');
    const a = SET({ STUDIO_ROLE: 'builder', STUDIO_LOCK_OWNER: 'builder-g1' }, 'on', 'pat');
    const b = SET({ STUDIO_ROLE: 'reviewer', STUDIO_LOCK_OWNER: 'reviewer-g2' }, 'on', 'patch');
    const c = SET({ STUDIO_LOCK_OWNER: 'builder-g3' }, 'on', 'patch');
    const d = SET({}, 'on', 'builder-g4');
    return [[a, b, c, d].every((r) => r.status !== 0 && /Refused/.test(out(r)) && /loosens a check/.test(out(r))) && /worker/.test(out(a)) && fs.readFileSync(SWITCH, 'utf8') === before && events().filter((x) => x.type === 'review.same_family').length === 0 && decisionLines().length === 0, `${out(a)} | ${out(b)} | ${out(c)} | ${out(d)}`];
  });
  await guard('a beta-mode agent the owner named sets it and it is recorded as theirs (by = the agent, via = beta mode), from an unmarked shell with --by and from its own STUDIO_LOCK_OWNER shell (fails before this fix: no such command)', () => {
    clearAll();
    fs.writeFileSync(path.join(S, 'studio', 'beta.json'), `${JSON.stringify({ on: true, by: 'pat', at: '2026-11-05T01:00:00.000Z', why: 'beta for the selftest', agents: ['patch-bot'], roles: ['producer', 'director'] }, null, 2)}\n`);
    git(S, 'add', 'studio/beta.json'); git(S, 'commit', '-q', '-m', 'beta on', '--no-verify');
    const a = SET({}, 'on', 'patch-bot', 'beta limits');
    const ja = readSwitch();
    const ma = events().filter((x) => x.type === 'review.same_family').at(-1)?.meta || {};
    const b = SET({ STUDIO_LOCK_OWNER: 'patch-bot' }, 'off', 'patch-bot');
    const jb = readSwitch();
    const mb = events().filter((x) => x.type === 'review.same_family').at(-1)?.meta || {};
    const dl = decisionLines();
    git(S, 'rm', '-q', '-f', 'studio/beta.json'); git(S, 'commit', '-q', '-m', 'beta off', '--no-verify');
    return [a.status === 0 && ja?.sameFamily === 'on' && ja.by === 'patch-bot' && ja.via === 'beta mode' && ma.by === 'patch-bot' && ma.via === 'beta mode' && b.status === 0 && jb?.sameFamily === 'off' && jb.by === 'patch-bot' && mb.was === 'on' && dl.length === 2, `${out(a)} | ${JSON.stringify(ja)} | ${out(b)} | ${JSON.stringify(jb)}`];
  });
  await guard('a Producer session may not flip the switch (it loosens a check: a protected decision, the owner\'s and the overseer\'s), and a bad value or a missing --by from a person is refused without writing', () => {
    clearAll();
    const a = SET({ STUDIO_ROLE: 'producer', STUDIO_LOCK_OWNER: 'producer-g1' }, 'on', 'producer-g1');
    const j = readSwitch();
    clearAll();
    const bad = SET({}, 'maybe', 'pat');
    const noBy = SET({}, 'on', null);
    return [a.status !== 0 && j === null && /Refused/.test(out(a)) && bad.status !== 0 && /on, off or auto/.test(out(bad)) && noBy.status !== 0 && /--by/.test(out(noBy)) && readSwitch() === null, `${out(a)} | ${JSON.stringify(j)} | ${out(bad)} | ${out(noBy)}`];
  });

  // ---- malformed or unknown values count as auto ----
  await guard('a malformed studio/review.json and an unknown value both count as auto: with two families configured the same-family header is refused, and the reader says auto (fails before this fix: no reader)', () => {
    clearAll(); setDotenv(TWO);
    const res = [];
    for (const v of ['{ not json', JSON.stringify({ sameFamily: 'yes', by: 'x' }), JSON.stringify({ sameFamily: 'ON ' + 'now' }), '[]', 'null']) {
      setSwitch(v); clearReviews();
      const r = record(oneFam, OLD_H);
      res.push(r.status !== 0 && /setting is auto/.test(out(r)));
    }
    const p = probe('reader', `import { readSameFamily } from ${u('harness/review-family.mjs')};
fs_dummy;`.replace('fs_dummy;', `console.log(JSON.stringify(readSameFamily({ root: ${JSON.stringify(S)} })));`));
    return [res.every(Boolean) && p.j.value === 'auto' && p.j.set === false, `${res} | ${p.raw}`];
  });

  // ---- the environment cannot turn it on ----
  await guard('with the file saying off, no model/tool variable, switch-like variable or decoy STUDIO_MAIN_ROOT (whose own studio/review.json says on) makes a same-family review count (fails before this fix: the header was accepted with one family)', () => {
    clearAll(); setDotenv(ONE); setSwitch(sw('off'));
    const decoy = path.join(tmpRoot, `284g-decoy-${process.pid}`);
    fs.mkdirSync(path.join(decoy, 'studio'), { recursive: true });
    fs.writeFileSync(path.join(decoy, 'studio', 'review.json'), JSON.stringify(sw('on')));
    // Made-up switch names, built from parts so the settings scanner does not count them as real settings.
    const decoyNames = [['SAME', 'FAMILY'], ['REVIEW', 'SAME', 'FAMILY'], ['SAMEFAMILY'], ['ALLOW', 'SAME', 'FAMILY'], ['REVIEW', 'FAMILY']].map((p) => ['STUDIO', ...p].join('_'));
    const combos = [
      blank, oneFam, { ...oneFam, STUDIO_REVIEWER_MODEL: 'claude-sonnet-5-5' }, { ...blank, STUDIO_RESCUE_MODELS: 'claude-sonnet-5-5' },
      { STUDIO_MAIN_ROOT: decoy }, { ...blank, STUDIO_MAIN_ROOT: decoy },
      Object.fromEntries(decoyNames.map((n) => [n, 'on'])),
      { STUDIO_ROLE: 'builder', STUDIO_LOCK_OWNER: 'builder-g9', STUDIO_REVIEW_TOOLS: 'claude' },
    ];
    const results = combos.map((c) => { clearReviews(); const r = record(c, OLD_H); const wrote = (() => { try { return fs.readdirSync(reviewsDir).filter((f) => /outside/.test(f)).length; } catch { return 0; } })(); return { refused: r.status !== 0 && wrote === 0, text: out(r).slice(0, 200) }; });
    clearReviews(); writeDoneReview(OLD_H);
    const l = approvedLine({ ...oneFam, STUDIO_MAIN_ROOT: decoy, ...Object.fromEntries(decoyNames.map((n) => [n, 'on'])) });
    const src = fs.readFileSync(path.join(S, 'harness', 'review-family.mjs'), 'utf8');
    const readsEnvSwitch = /env\.STUDIO_[A-Z_]*SAME/.test(src) || /process\.env\.STUDIO_[A-Z_]*SAME/.test(src);
    return [results.every((x) => x.refused) && /^\s*\[ \]/.test(l) && !readsEnvSwitch, JSON.stringify(results) + l];
  });

  // ---- launch ----
  await guard('launch with on: another family configured but out of quota plans a same-family model with the note; with the other family live it plans that one; under auto the out-of-quota case stays kept; under off no same-family review is planned (fails before this fix: kept in every case)', () => {
    clearAll(); setDotenv(THREE);
    const body = (mark) => `import { reviewLaunch } from ${u('harness/review-family.mjs')};
import { markExhausted } from ${u('harness/budget.mjs')};
${mark ? "markExhausted('gpt-5-codex', 'usage limit reached');" : ''}
const events = [{ type: 'task.start', agent: 'b1', task: 'T-9', model: 'claude-opus-5-5' }];
console.log(JSON.stringify(reviewLaunch({ taskId: 'T-10', title: 'Review T-9', events, current: 'claude-opus-5-5', env: {}, root: ${JSON.stringify(S)} })));`;
    const quota = path.join(S, '.studio', 'tool-quota.json');
    setSwitch(sw('on')); fs.rmSync(quota, { force: true });
    const live = probe('live', body(false)).j;
    fs.rmSync(quota, { force: true });
    const dead = probe('dead', body(true)).j; // the quota mark stays in .studio/tool-quota.json for the next two
    setSwitch(null);
    const auto = probe('auto', body(false)).j;
    setSwitch(sw('off'));
    const off = probe('off', body(false)).j;
    fs.rmSync(quota, { force: true });
    return [live.kind === 'other' && live.model === 'gpt-5-codex' && !live.note
      && dead.kind === 'same' && dead.model === 'claude-sonnet-5-5' && /studio allows same-family reviews \(set by patch on 2026-11-12\)/.test(dead.note || '') && String(dead.note).includes(NEW_H)
      && auto.kind === 'kept' && !auto.note && off.kind === 'kept' && !off.note, JSON.stringify({ live, dead, auto, off })];
  });
  await guard('launch with on and no other family configured: a different model of the implementer\'s family is planned and the note names the allowed header', () => {
    clearAll(); setDotenv(ONE); setSwitch(sw('on'));
    const p = probe('one', `import { reviewLaunch } from ${u('harness/review-family.mjs')};
const events = [{ type: 'task.start', agent: 'b1', task: 'T-9', model: 'claude-opus-5-5' }];
console.log(JSON.stringify(reviewLaunch({ taskId: 'T-10', title: 'Review T-9', events, current: 'claude-opus-5-5', env: {}, root: ${JSON.stringify(S)} })));`).j;
    return [p.kind === 'same' && p.model === 'claude-sonnet-5-5' && String(p.note).includes(NEW_H), JSON.stringify(p)];
  });

  // ---- the sheet ----
  await guard('the overseer sheet has the one same-family line at the bottom only under on, and the item counts are unchanged', () => {
    const run = (v) => {
      clearAll(); setSwitch(v);
      return probe(`sheet-${v ? v.sameFamily : 'none'}`, `import { overseerSheet, sheetText } from ${u('harness/overseer.mjs')};
const s = await overseerSheet({ root: ${JSON.stringify(S)}, events: [] });
console.log(JSON.stringify({ text: sheetText(s), summary: s.summary }));`).j;
    };
    const none = run(null); const on = run(sw('on')); const off = run(sw('off')); const auto = run(sw('auto'));
    const line = 'Same-family reviews count (set by patch, 2026-11-12): a second model family is the stronger check.';
    const lines = String(on.text || '').split('\n');
    return [lines.at(-1) === line && !/Same-family/.test(none.text || '') && !/Same-family/.test(off.text || '') && !/Same-family/.test(auto.text || '') && JSON.stringify(on.summary) === JSON.stringify(none.summary), JSON.stringify({ none, on, off, auto })];
  });

  clearAll();
}
