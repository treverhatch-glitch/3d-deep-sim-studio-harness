/**
 * harness/engine-target-red.mjs — when the target is red by itself, one task to fix it, once per distinct red.
 *   targetRedTask   the rules check, the daily full land run or the owed full rules run is red on the target alone:
 *                   adds one engine-porter task (unless one for this red is still open) and one warn event
 *   targetRedClear  the same source saw the target green: the record goes, so a later red files a new task
 *   targetRedLine   the `train status` line for an open task
 * Record: .studio/engine/<engine>-target-red.json, { reds: [{ key, task, at, source, tests }] }. Two lists of test names
 * are the same red when half or more of the shorter list is in the other. STUDIO_ENGINE_TARGET_RED_TASK=off turns it off.
 * Never throws: a task that cannot be filed is one warn event and the train goes on.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { emitEvent } from './event.mjs';
import { isOff, readJsonOr, writeJsonTmp } from './helpers.mjs';

const fileOf = (root, engine) => path.join(root, '.studio', 'engine', `${engine}-target-red.json`);
const load = (root, engine) => { const j = readJsonOr(fileOf(root, engine), {}); return Array.isArray(j.reds) ? j.reds : []; };
const save = (root, engine, reds) => writeJsonTmp(fileOf(root, engine), { reds });
const isOpen = (root, id) => { try { return new RegExp(`^[-*]\\s+\\[[^xX]\\]\\s+\\*\\*${id}\\*\\*`, 'm').test(fs.readFileSync(path.join(root, 'studio', 'NEXT.md'), 'utf8').replace(/\r\n/g, '\n')); } catch { return true; } };
const same = (a, b) => { if (!a.tests.length || !b.tests.length) return a.key === b.key; const s = new Set(b.tests); return a.tests.filter((t) => s.has(t)).length * 2 >= Math.min(a.tests.length, b.tests.length); };

export function targetRedTask(root, { engine = 'unity', target = 'the target', source, tests = [], why = '', train = '' } = {}) {
  try {
    if (isOff(process.env.STUDIO_ENGINE_TARGET_RED_TASK)) return null;
    const names = [...new Set((tests || []).map(String))].sort().slice(0, 40);
    const first = String(why || '').split('\n')[0].slice(0, 160);
    const now = { key: names.length ? names.join('\n') : `${source} ${first}`, tests: names };
    const reds = load(root, engine).filter((r) => isOpen(root, r.task));
    const hit = reds.find((r) => same(now, { key: r.key, tests: r.tests || [] }));
    if (hit) { if (names.length) { hit.tests = names; hit.key = now.key; } save(root, engine, reds); return { task: hit.task, already: true }; }
    const title = (names.length ? `Fix: ${target} is red by itself on ${names.length} rule test(s): ${names[0]}` : `Fix: ${target} is red by itself: the rules check fails to build`).slice(0, 200);
    const task = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), 'task.mjs');
    const r = spawnSync(process.execPath, [task, 'add', title, '--role', 'engine-porter', '--priority', 'P1', '--track', `engine:${engine}`, '--agent', process.env.STUDIO_PRODUCER_NAME || 'producer'], { windowsHide: true, cwd: root, encoding: 'utf8', timeout: 60000 });
    const id = /"id":\s*"([A-Z]+-\d+)"/.exec(String(r.stdout || ''))?.[1];
    if (!id) throw new Error(String(r.stderr || r.stdout || `exit ${r.status}`).trim().split('\n')[0].slice(0, 200));
    const note = `${target} is red by itself (${source}, ${train || 'no train id'}). No branch is blamed. ${names.length} failing test(s):\n${names.map((n) => `- ${n}`).join('\n')}\n${first}\n`;
    try { fs.mkdirSync(path.join(root, 'studio', 'handoffs'), { recursive: true }); fs.appendFileSync(path.join(root, 'studio', 'handoffs', `${id}.md`), `\n## ${new Date().toISOString()} (target red)\n${note}`); } catch { /* the event has it */ }
    save(root, engine, [...reds, { ...now, task: id, at: new Date().toISOString(), source }]);
    emitEvent({ type: `task.train.${engine}.target_red_task`, agent: 'engine-train', to: 'producer', status: 'warn', task: id, track: `engine:${engine}`, msg: `${id} filed: ${target} is red by itself (${source}${train ? `, ${train}` : ''}) on ${names.length} test(s). ${note.slice(0, 300)}`.slice(0, 600), meta: { task: id, source, train, tests: names } });
    return { task: id };
  } catch (e) {
    try { emitEvent({ type: `task.train.${engine}.target_red_task`, agent: 'engine-train', to: 'producer', status: 'warn', msg: `${target} is red by itself (${source}) but no fix task was filed: ${String(e?.message || e).slice(0, 200)}. Add one by hand.`, meta: { source, train, tests: (tests || []).slice(0, 40), failed: true } }); } catch { /* the train goes on */ }
    return null;
  }
}

export function targetRedClear(root, engine, source) {
  try { const reds = load(root, engine); if (reds.some((r) => r.source === source)) save(root, engine, reds.filter((r) => r.source !== source)); } catch { /* kept until next time */ }
}

export function targetRedLine(root, engine) {
  try { const r = load(root, engine).find((x) => isOpen(root, x.task)); return r ? `Target red: ${r.task} (${(r.tests || []).length} test(s), since ${String(r.at).slice(0, 16)})` : ''; } catch { return ''; }
}
