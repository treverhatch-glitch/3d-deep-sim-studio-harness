/**
 * qa/selftest-284c.mjs — 2.84 (c): `npm run overseer -- sheet`, one page of everything that waits on a person or the overseer.
 *
 *   sheet   a studio with one of each kind planted lists each in its section with the right command; the text has the
 *           summary line; an empty studio says "Nothing waits"; a malformed holds file and a missing line state are an
 *           empty section, not a crash; the command changes no file
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export async function selftest284C({ dir, root, report, tmpRoot }) {
  const guard = async (name, fn) => { try { const [ok, detail] = await fn(); report(name, Boolean(ok), ok ? '' : String(detail || '').slice(0, 3000)); } catch (e) { report(name, false, String(e?.stack || e).slice(0, 3000)); } };
  const write = (b, rel, text) => { fs.mkdirSync(path.dirname(path.join(b, rel)), { recursive: true }); fs.writeFileSync(path.join(b, rel), text); };
  const harnessRoot = root || dir;
  const clean = {};
  for (const k of Object.keys(process.env)) if (/^(CLAUDE|CODEX|CURSOR|AIDER|GEMINI|STUDIO_|AGENT_|AI_AGENT|ANTHROPIC|OPENAI)/i.test(k)) clean[k] = '';

  const S = path.join(tmpRoot, `284c-studio-${process.pid}`);
  fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
  for (const x of ['.studio', 'studio/asks', 'studio/task-holds.json']) fs.rmSync(path.join(S, x), { recursive: true, force: true });
  fs.mkdirSync(path.join(S, '.studio'), { recursive: true });
  const evFile = path.join(S, '.studio', 'events-284c.jsonl');
  const env = { ...process.env, ...clean, AGENT_EVENTS_FILE: evFile, STUDIO_MAIN_ROOT: S, CI: '', NODE_OPTIONS: '' };
  const sheet = (...a) => spawnSync(process.execPath, [path.join(S, 'harness', 'overseer.mjs'), 'sheet', ...a], { windowsHide: true, cwd: S, env, encoding: 'utf8', timeout: 120000 });
  const json = () => JSON.parse(sheet('--json').stdout);
  const items = (sh, key) => { const sec = sh.sections.find((s) => s.key === key); return sec ? (sec.items || sec.groups.flatMap((g) => g.items)) : []; };
  const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
  const H = 3600000;

  // ---- an empty studio ----
  write(S, 'studio/NEXT.md', '# Next\n');
  write(S, 'studio/DONE.md', '# Done\n');
  write(S, '.studio/events-284c.jsonl', '');
  await guard('fails before this change: an empty studio prints "Nothing waits" and no section (no sheet command existed)', async () => {
    const r = sheet();
    const j = json();
    return [/Nothing waits/.test(r.stdout) && /^0 items wait on a person, 0 on the overseer/.test(r.stdout) && j.sections.length === 0, r.stdout + r.stderr];
  });

  // ---- one of each kind planted ----
  const task = (id, role, mark = ' ') => `- [${mark}] **${id}** [P1] (\`${role}\`) — Task ${id}\n`;
  write(S, 'studio/NEXT.md', `# Next\n${['T-100', 'T-101', 'T-102', 'T-103', 'T-104', 'T-105', 'T-106'].map((id) => task(id, 'builder')).join('')}${task('T-107', 'builder', '~')}`);
  write(S, 'studio/DONE.md', `# Done\n${task('T-050', 'builder', 'x')}`);
  const ask = (id, q, extra = {}) => write(S, `studio/asks/${id}.json`, JSON.stringify({ id, question: q, options: [], default: null, why: '', by: 'producer-1', at: iso(2 * H), deadline: null, status: 'open', ...extra }));
  ask('A-001', 'Should we spend money on a paid asset pack?');
  ask('A-002', 'Which camera angle should the lobby use?');
  ask('A-003', 'Old question', { status: 'answered' });
  write(S, 'studio/task-holds.json', JSON.stringify({ tasks: {
    'T-100': { parked: { by: 'watchdog', why: 'handed back 3 times in 2 h', at: iso(H) } },
    'T-101': { held: { by: 'conductor-1', why: 'wait for the port', at: iso(H / 2) } },
    'T-102': { parked: { by: 'harness', reason: 'owner-only', ownerOnly: true, why: 'needs the owner to sign', at: iso(3 * H) } },
    'T-103': { after: ['T-999'] },
    'T-104': { after: ['T-105'] },
    'T-106': { after: ['T-105'] },
    'T-107': { until: new Date(Date.now() + 2 * H).toISOString(), why: 'wait for the art drop' },
  } }));
  write(S, '.studio/train/queue.json', JSON.stringify([{ task: 'T-108', agent: 'builder-1', branch: 'feat/a', head: 'abc', at: iso(H), held: { tier: 'C', why: 'a tier-C file changed', at: iso(H) } }]));
  write(S, '.studio/line/state.json', JSON.stringify({ gates: { 'T-105': { since: Date.now() - 2 * H, lastEmit: null } } }));
  const ev = (type, task, extra = {}) => JSON.stringify({ ts: iso(extra.ago ?? 600000), type, task, agent: 'x', msg: extra.msg || '', ...(extra.meta ? { meta: extra.meta } : {}) });
  write(S, '.studio/events-284c.jsonl', `${[
    ev('task.train.unity.dropped', 'T-110', { msg: 'T-110 handed back: rules red', meta: { cause: 'rules' } }),
    ev('task.half_landed', 'T-111', { msg: 'half', meta: { engine: 'unity', branch: 'feat/b', ahead: 2 } }),
    ev('task.train.unity.land_script', null, { msg: 'the land command runs a script that differs' }),
    ev('task.train.unity.flaky', null, { msg: 'flaky' }),
    ev('task.train.unity.flaky', null, { msg: 'flaky' }),
    ev('task.paused', 'T-112', { ago: 3 * H, msg: 'Handed back T-112: first' }),
    ev('task.paused', 'T-112', { ago: 2 * H, msg: 'Handed back T-112: second' }),
    ev('task.paused', 'T-112', { ago: 1 * H, msg: `Handed back T-112: ${'x'.repeat(300)}` }),
    ev('task.paused', 'T-113', { ago: 1 * H, msg: 'Handed back T-113: once' }),
  ].join('\n')}\n`);

  const planted = json();
  await guard('fails before this change: sheet lists the owner-only ask apart from the overseer one, each with the answer command', async () => {
    const a = items(planted, 'asks');
    const own = a.find((x) => x.id === 'A-001'); const board = a.find((x) => x.id === 'A-002');
    const grp = planted.sections.find((s) => s.key === 'asks').groups;
    return [own?.who === 'person' && /owner only/.test(own.why) && board?.who === 'overseer' && !a.some((x) => x.id === 'A-003') && grp[0].items[0].id === 'A-001'
      && own.cmd === 'npm run ask -- answer A-001 "<answer>" --by <you>', JSON.stringify(a)];
  });
  await guard('fails before this change: held and parked tasks are grouped by reason with the unpark / unhold command', async () => {
    const h = items(planted, 'held');
    const byId = Object.fromEntries(h.map((x) => [x.id, x]));
    return [/watchdog/.test(byId['T-100']?.why) && byId['T-100'].cmd === 'npm run task -- unpark T-100 --by <you>'
      && byId['T-101']?.cmd === 'npm run task -- unhold T-101 --by <you>' && byId['T-102']?.who === 'person' && byId['T-107']?.cmd === null
      && planted.sections.find((s) => s.key === 'held').groups.length >= 4, JSON.stringify(h)];
  });
  await guard('fails before this change: a train lane held for a tier-C release is listed with train release', async () => {
    const t = items(planted, 'train-holds')[0];
    return [t?.id === 'T-108' && t.who === 'person' && /tier-C/.test(t.why) && t.cmd === 'npm run task -- train release T-108 --by <you>', JSON.stringify(t)];
  });
  await guard('fails before this change: the engine section has the dropped branch with its cause, the half-landed task, the land-script warning and one flaky count', async () => {
    const e = items(planted, 'engine');
    const d = e.find((x) => x.id === 'T-110'); const h = e.find((x) => x.id === 'T-111');
    return [/cause "rules"/.test(d?.why) && d.cmd === 'npm run task -- done T-110 --train --agent <you>' && h && /half landed/.test(h.what)
      && e.some((x) => /land script/.test(x.what)) && e.filter((x) => /flaky/.test(x.what)).length === 1 && /2 flaky/.test(e.find((x) => /flaky/.test(x.what)).what), JSON.stringify(e)];
  });
  await guard('fails before this change: an active chain gate says which task gates how many builder tasks since when', async () => {
    const c = items(planted, 'chains')[0];
    return [c?.id === 'T-105' && /gates 2 builder tasks/.test(c.what) && c.since && /^npm run task -- after T-104 --remove T-105$/.test(c.cmd), JSON.stringify(c)];
  });
  await guard('fails before this change: a wait on an id that is not on the board is listed with after --remove', async () => {
    const d = items(planted, 'dangling');
    return [d.length === 1 && d[0].cmd === 'npm run task -- after T-103 --remove T-999', JSON.stringify(d)];
  });
  await guard('fails before this change: a task handed back 3 times in 24 h is a dead end with the last note cut to 160 characters; one hand-back is not', async () => {
    const d = items(planted, 'dead-ends');
    return [d.length === 1 && d[0].id === 'T-112' && d[0].why.length === 160 && /3 times/.test(d[0].what), JSON.stringify(d)];
  });
  await guard('fails before this change: sections come in the documented order and the text has the summary line and arrows', async () => {
    const keys = planted.sections.map((s) => s.key).join(',');
    const t = sheet().stdout;
    return [keys === 'asks,held,train-holds,engine,chains,dangling,dead-ends' && /^\d+ items? waits? on a person, \d+ on the overseer \(/.test(t) && /→ npm run ask -- answer A-001/.test(t) && planted.summary.person === 3, `${keys}\n${t}`];
  });

  // ---- bad state: a malformed holds file, a missing line state ----
  write(S, 'studio/task-holds.json', '{ not json');
  fs.rmSync(path.join(S, '.studio', 'line'), { recursive: true, force: true });
  await guard('fails before this change: a malformed task-holds.json and a missing line state leave those sections empty and do not crash', async () => {
    const r = sheet('--json');
    let j = null; try { j = JSON.parse(r.stdout); } catch { /* below */ }
    return [r.status === 0 && j && !j.sections.some((s) => ['held', 'chains', 'dangling'].includes(s.key)) && j.sections.some((s) => s.key === 'asks'), r.stdout + r.stderr];
  });

  // ---- reads only ----
  write(S, 'studio/task-holds.json', JSON.stringify({ tasks: { 'T-100': { parked: { by: 'watchdog', why: 'x', at: iso(H) } } } }));
  const listing = () => { const out = []; const walk = (d) => { let es = []; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } for (const e of es) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else { const st = fs.statSync(f); out.push(`${path.relative(S, f).split(path.sep).join('/')}|${st.size}|${Math.floor(st.mtimeMs)}`); } } }; walk(path.join(S, 'studio')); walk(path.join(S, '.studio')); return out.sort().join('\n'); };
  await guard('fails before this change: sheet changes no file under studio/ or .studio/ (names, sizes and mtimes, event log included)', async () => {
    const before = listing();
    sheet(); sheet('--json');
    const after = listing();
    return [before === after && before.length > 0, `${before}\n---\n${after}`];
  });

  try { fs.rmSync(S, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 }); } catch { /* the sweep takes it */ }
  void harnessRoot;
}
