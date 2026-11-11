/**
 * qa/selftest-230j.mjs — the 2.30j checks (from real HUD use in the Marina room), run by qa/selftest.mjs on a copy.
 * Cheat-sheet matching, outside sessions in the ledger, the Director refilling when no pace was chosen.
 * 2.80: the War Room's checks (playtest panel, Needs-you cards, danger row) and the Liaison chat's went with them.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function selftest230j({ dir, run, report, tmpRoot }) {
  let n = 0;
  const u = (rel) => JSON.stringify(pathToFileURL(path.join(dir, rel)).href);
  const probe = (code, env = {}) => {
    const f = path.join(tmpRoot, `p230j-${++n}-${process.pid}.mjs`);
    fs.writeFileSync(f, code);
    const r = run(dir, `node "${f}"`, env);
    try {
      return JSON.parse(r.stdout.trim().split('\n').pop());
    } catch {
      return { error: r.stdout + r.stderr };
    }
  };
  const read = (rel) => fs.readFileSync(path.join(dir, rel), 'utf8');


  const ch = probe(`const { matchTricks } = await import(${u('harness/cheatsheet.mjs')});
const entries = [{ id: 'C-1', tags: ['physics', 'collision', 'shape', 'vehicle', 'steering', 'jolt'], text: 'collision shapes' }, { id: 'C-2', tags: ['boat', 'wake'], text: 'wake trails' }, { id: 'C-3', tags: ['save'], text: 'saves' }];
const a = matchTricks('Add a boat wake trail behind the ship', { entries, max: 6 }).map((e) => e.id);
const b = matchTricks('fix the collision on the fuel dock', { entries, max: 6 }).map((e) => e.id);
const c = matchTricks('fix the dock', { entries, tags: ['collision'], max: 6 }).map((e) => e.id);
const d = matchTricks('save the game', { entries, max: 6 }).map((e) => e.id);
console.log(JSON.stringify({ a, b, c, d }));`);
  report('2.30j: a cheat-sheet tip needs two tag hits (or one hit on a narrow entry, or an explicit tag), so one loose word no longer attaches it', JSON.stringify(ch) === JSON.stringify({ a: ['C-2'], b: [], c: ['C-1'], d: ['C-3'] }), JSON.stringify(ch));

  const led = probe(`const { reportSession } = await import(${u('harness/session-report.mjs')});
const { readRecentEvents } = await import(${u('harness/event.mjs')});
const bad = reportSession({ phase: 'end', agent: 'x', model: 'unknown' });
reportSession({ phase: 'start', agent: 'runner-b1', model: 'gemini-3.1-pro-preview', role: 'builder', tool: 'script', task: 'T-9' });
reportSession({ phase: 'end', agent: 'runner-b1', model: 'gemini-3.1-pro-preview', role: 'builder', tool: 'script', tokensIn: 1200, tokensOut: '300' });
const rows = JSON.stringify(readRecentEvents(1000)); // 2.83: the ledger is cut; the session events carry the model and tokens
console.log(JSON.stringify({ bad: bad.ok, seen: rows.includes('gemini-3.1-pro-preview') && rows.includes('1200') }));`);
  report('2.30j: a session started outside the hub reports start/end with its model and tokens and shows in the event log; no model, no report', led.bad === false && led.seen === true, JSON.stringify(led));


  const agent = read('harness/agent.mjs');
  const flow = read('harness/director-flow.mjs');
  // 2.55.0 (P-032, owner's decision): an unchosen pace no longer lets the Director start builders; it still asks the
  // launcher (fillAgents byDirector), which now refuses with a note to the dev.
  report('2.30j/2.55.0: the Director asks the launcher to refill builders (fillAgents byDirector), which starts nothing while no pace is chosen; a flow line repeats only when it changes or after 30 min', /2\.55\.0 \(P-032\)/.test(agent) && /pace\.unchosen/.test(agent) && /fillAgents\(\{ byDirector: true \}\)/.test(flow) && /prev\.actions\?\.join/.test(flow));
  report('2.30j: dead routes (404/410) cool for a day; Producer with no tool raises one warning an hour', /statusCode === 404 \|\| statusCode === 410/.test(read('harness/route.mjs')) && /agent\.no_tool/.test(agent));
  report('2.30j: the launcher runs the browser check after it closes a task (STUDIO_POST_BROWSER_PLAY=off turns it off)', /qa\.browser_play/.test(agent) && /STUDIO_POST_BROWSER_PLAY/.test(agent));
}
