#!/usr/bin/env node
/**
 * harness/intent.mjs — what the dev asked for, said back before work starts (2.30, J2), and the dev's
 * "do it now" (J3).
 *
 *   npm run intent -- echo --asked "add sprint" --wont "jump, stamina" --tasks T-160,T-161 --by producer
 *   npm run intent -- confirm E-001 --by <dev>        one click in the War Room does the same
 *   npm run intent -- list
 *   npm run task -- yes T-161 --by <dev>             an agent-proposed mechanic may start
 *
 * Every task is tagged dev-asked or agent-proposed when it is queued (task add --origin dev|agent; an
 * agent's add defaults to agent-proposed). An agent-proposed mechanic waits for the dev's yes; other
 * work starts at once, so nothing slows down. Test #4: "add sprint/jump" became two phased tasks the dev
 * never asked for.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STUDIO_STATE_DIR, emitEvent } from './event.mjs';
import { isPerson } from './verdict.mjs';

export const ECHO_DIR = path.join(STUDIO_STATE_DIR, 'intent');

/** A mechanic is a new thing the player can do or a new rule, said as a phrase ("add a grapple"), never a lone word ("polish the sprint dust"). */
const MECHANIC = /\b(?:add|adds|adding|new|introduce|implement)\s+(?:an?\s+|the\s+)?(?:[\w-]+\s+){0,2}(?:mechanic|ability|move|action|system|mode|resource|skill|upgrade|sprint|jump|dash|crouch|stamina|grapple|wall run)s?\b/i;
export const isMechanic = (title, meta = {}) => !/^(?:bug|fix|docs|study|review|playtest|balance)\b/i.test(String(title || '')) && (Boolean(meta.mechanic) || meta.type === 'system' || MECHANIC.test(String(title || '')));

/** dev-asked or agent-proposed. An agent's add is agent-proposed unless it says --origin dev with the dev's words. */
export function originOf({ origin, agent, asked } = {}) {
  if (origin === 'dev' || origin === 'dev-asked') return 'dev-asked';
  if (origin === 'agent' || origin === 'agent-proposed') return 'agent-proposed';
  if (asked) return 'dev-asked';
  return isPerson(agent) && !process.env.STUDIO_LOCK_OWNER ? 'dev-asked' : 'agent-proposed';
}

/**
 * Who may speak for the dev: a person's name; from inside an agent it is a relay, so it needs the dev's
 * own words and where they said them (the same rule as a fun verdict).
 */
export function devSays(by, { quote = '', source = '', viaWarRoom = false } = {}) {
  if (!isPerson(by)) return { ok: false, message: `${by || 'Nobody'} looks like an agent. Only the dev says yes here (--by <your name>).` };
  const inAgent = !viaWarRoom && Boolean(process.env.STUDIO_ROLE || process.env.STUDIO_LOCK_OWNER);
  if (inAgent && (String(quote).trim().length < 4 || !String(source).trim())) return { ok: false, message: `Relayed from an agent: give ${by}'s own words and where they said them (--quote "…" --source "<channel, time or link>").` };
  return { ok: true, relayedBy: inAgent ? process.env.STUDIO_LOCK_OWNER || 'an agent' : null };
}

const readJson = (f) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
};
export function listEchoes() {
  if (!fs.existsSync(ECHO_DIR)) return [];
  return fs.readdirSync(ECHO_DIR).filter((f) => /^E-\d+\.json$/.test(f)).sort().map((f) => readJson(path.join(ECHO_DIR, f))).filter(Boolean);
}
export const pendingEchoes = () => listEchoes().filter((e) => !e.confirmed);

/** The card: "You asked for: X. I will NOT change: Y." */
export function addEcho({ asked, wont = '', tasks = [], by = 'producer' }) {
  if (!String(asked || '').trim()) return { ok: false, message: 'Say what the dev asked for: --asked "<their words>".' };
  fs.mkdirSync(ECHO_DIR, { recursive: true });
  const n = listEchoes().reduce((m, e) => Math.max(m, Number(e.id.slice(2))), 0) + 1;
  const e = { id: `E-${String(n).padStart(3, '0')}`, asked: String(asked).trim().slice(0, 400), wont: String(wont || '').trim().slice(0, 400), tasks, by, at: new Date().toISOString(), confirmed: null };
  fs.writeFileSync(path.join(ECHO_DIR, `${e.id}.json`), `${JSON.stringify(e, null, 2)}\n`);
  emitEvent({ type: 'intent.echo', agent: by, to: 'dev', msg: `You asked for: ${e.asked}.${e.wont ? ` I will NOT change: ${e.wont}.` : ''}${tasks.length ? ` Tasks: ${tasks.join(', ')}.` : ''} (${e.id}, one click confirms)`, meta: { id: e.id, tasks } });
  return { ok: true, echo: e };
}

export function confirmEcho(id, by, opts = {}) {
  const f = path.join(ECHO_DIR, `${id}.json`);
  const e = readJson(f);
  if (!e) return { ok: false, message: `No card ${id}.` };
  const who = devSays(by, opts);
  if (!who.ok) return who;
  e.confirmed = { by, at: new Date().toISOString(), ...(who.relayedBy ? { relayedBy: who.relayedBy } : {}) };
  fs.writeFileSync(f, `${JSON.stringify(e, null, 2)}\n`);
  emitEvent({ type: 'intent.confirmed', agent: by, to: 'producer', msg: `${by} confirmed ${id}: ${e.asked}`, meta: { id, tasks: e.tasks } });
  return { ok: true, echo: e };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const flag = (k) => {
    const i = argv.indexOf(`--${k}`);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
  };
  const by = flag('by') || process.env.STUDIO_LOCK_OWNER || 'producer';
  const cmd = argv[0] || 'list';
  let r;
  if (cmd === 'echo') r = addEcho({ asked: flag('asked'), wont: flag('wont'), tasks: (flag('tasks') || '').split(/[,\s]+/).filter((x) => /^[A-Z]+-\d+$/.test(x)), by });
  else if (cmd === 'confirm') r = confirmEcho(argv[1], flag('by'), { quote: flag('quote') || '', source: flag('source') || '' });
  else if (cmd === 'list') {
    const all = listEchoes();
    console.log(all.length ? all.map((e) => `${e.id} ${e.confirmed ? `confirmed by ${e.confirmed.by}` : 'waiting on the dev'}: you asked for "${e.asked}"${e.wont ? `; I will NOT change: ${e.wont}` : ''}${e.tasks.length ? ` (${e.tasks.join(', ')})` : ''}`).join('\n') : 'No intent cards.');
    process.exit(0);
  } else {
    console.log('Usage: npm run intent -- echo --asked "…" [--wont "…"] [--tasks T-1,T-2] --by <name> | confirm <E-ID> --by <dev> | list');
    process.exit(1);
  }
  if (!r.ok) {
    console.error(r.message);
    process.exit(1);
  }
  console.log(cmd === 'echo' ? `${r.echo.id}: You asked for: ${r.echo.asked}.${r.echo.wont ? ` I will NOT change: ${r.echo.wont}.` : ''} It waits on the dev's one click (War Room, Ops) or: npm run intent -- confirm ${r.echo.id} --by <dev>` : `${argv[1]} confirmed.`);
}
