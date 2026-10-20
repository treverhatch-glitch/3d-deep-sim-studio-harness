#!/usr/bin/env node
/**
 * harness/meeting.mjs — the Producer meets several agents at once.
 *
 *   node harness/meeting.mjs start "<topic>" --with builder,qa-playtester [--room production] [--agent producer]
 *   node harness/meeting.mjs say "<what>" --agent builder
 *   node harness/meeting.mjs end [--decision "<what was decided>"]... [--action "<task title>|<role>|<P0-P3>"]...
 *   node harness/meeting.mjs status
 *
 * Notes go to studio/meetings/<date>-<topic>.md. Actions become tasks in studio/NEXT.md, and the
 * outcome is added to the Producer log. The War Room's Studio view walks everyone to the table.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, STUDIO_STATE_DIR, emitEvent } from './event.mjs';
import { addTask } from './task.mjs';
import { addLogNote } from './producer-log.mjs';

export const MEETING_FILE = path.join(STUDIO_STATE_DIR, 'meeting.json');
export const MEETINGS_DIR = path.join(REPO_ROOT, 'studio', 'meetings');
const STALE_MS = 4 * 3600 * 1000;

const readJson = (f) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
};

/** The meeting in progress, or null. A meeting left open for 4 hours counts as over. */
export function activeMeeting() {
  const m = readJson(MEETING_FILE);
  if (!m || m.endedAt || Date.now() - Date.parse(m.startedAt) > STALE_MS) return null;
  return m;
}

function appendToSection(rel, heading, lines) {
  const full = path.join(REPO_ROOT, rel);
  const text = fs.readFileSync(full, 'utf8');
  const start = text.indexOf(`## ${heading}`);
  if (start === -1) return fs.writeFileSync(full, `${text.trimEnd()}\n\n## ${heading}\n${lines.join('\n')}\n`);
  const nextAt = text.indexOf('\n## ', start + 3);
  const cut = nextAt === -1 ? text.length : nextAt;
  const before = text.slice(0, cut).replace(/\s*$/, '\n');
  fs.writeFileSync(full, `${before}${lines.join('\n')}\n${nextAt === -1 ? '' : `\n${text.slice(nextAt + 1)}`}`);
}

export function startMeeting({ topic, attendees = [], room = 'production', agent = 'producer' }) {
  if (!topic) return { error: 'A meeting needs a topic.' };
  const open = activeMeeting();
  if (open) return { error: `"${open.topic}" is still running. End it first: node harness/meeting.mjs end` };
  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  const slug = topic.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'meeting';
  let id = `${date}-${slug}`;
  for (let n = 2; fs.existsSync(path.join(MEETINGS_DIR, `${id}.md`)); n++) id = `${date}-${slug}-${n}`;
  const file = `studio/meetings/${id}.md`;
  const people = [...new Set(attendees.map((a) => a.trim()).filter(Boolean))];
  fs.mkdirSync(MEETINGS_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(REPO_ROOT, file),
    `# Meeting: ${topic}\n\n- **When**: ${now.toISOString()}\n- **Called by**: ${agent}\n- **With**: ${people.join(', ') || 'nobody yet'}\n- **Room**: ${room}\n\n## Notes\n\n## Decisions\n\n## Actions\n`,
  );
  const meeting = { id, file, topic, attendees: people, room, by: agent, startedAt: now.toISOString() };
  fs.mkdirSync(path.dirname(MEETING_FILE), { recursive: true });
  fs.writeFileSync(MEETING_FILE, JSON.stringify(meeting, null, 2) + '\n');
  emitEvent({ type: 'meeting.start', agent, status: 'meeting', msg: `Meeting: ${topic}`, meta: { attendees: people, room, file } });
  return meeting;
}

export function sayInMeeting(text, agent = 'producer') {
  const m = activeMeeting();
  if (!m) return { error: 'No meeting is running.' };
  if (!text) return { error: 'Say what?' };
  appendToSection(m.file, 'Notes', [`- **${agent}**: ${text}`]);
  emitEvent({ type: 'meeting.say', agent, status: 'meeting', msg: text, meta: { meeting: m.id } });
  return m;
}

export function endMeeting({ decisions = [], actions = [], agent = 'producer' } = {}) {
  const m = activeMeeting();
  if (!m) return { error: 'No meeting is running.' };
  if (decisions.length) appendToSection(m.file, 'Decisions', decisions.map((d) => `- ${d}`));
  const made = [];
  for (const a of actions) {
    const [title, role = 'builder', priority = 'P2'] = a.split('|').map((x) => x.trim());
    if (!title) continue;
    const t = addTask({ title, role, priority, agent });
    made.push(t);
  }
  if (made.length) appendToSection(m.file, 'Actions', made.map((t) => `- ${t.id} [${t.priority}] (\`${t.role}\`): ${t.title}`));
  const ended = { ...m, endedAt: new Date().toISOString(), decisions, tasks: made.map((t) => t.id) };
  fs.writeFileSync(MEETING_FILE, JSON.stringify(ended, null, 2) + '\n');
  emitEvent({ type: 'meeting.end', agent, status: 'ok', msg: `Meeting over: ${m.topic}${made.length ? ` (${made.length} new task${made.length > 1 ? 's' : ''})` : ''}`, meta: { meeting: m.id } });
  addLogNote(
    [`Meeting "${m.topic}" with ${m.attendees.join(', ') || 'nobody'} (${m.file}).`, ...decisions.map((d) => `Decided: ${d}`), made.length ? `Tasks: ${made.map((t) => `${t.id} ${t.title}`).join('; ')}` : ''].filter(Boolean).join('\n'),
    agent,
  );
  return ended;
}

function parseArgs(argv) {
  const out = { _: [], decision: [], action: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const k = a.slice(2);
    const v = argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    if (Array.isArray(out[k])) out[k].push(v);
    else out[k] = v;
  }
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const args = parseArgs(process.argv.slice(2));
  const [cmd = 'status', ...rest] = args._;
  const agent = typeof args.agent === 'string' ? args.agent : process.env.STUDIO_LOCK_OWNER || 'producer';
  let res;
  if (cmd === 'start') res = startMeeting({ topic: rest.join(' '), attendees: String(args.with || '').split(','), room: typeof args.room === 'string' ? args.room : 'production', agent });
  else if (cmd === 'say') res = sayInMeeting(rest.join(' '), agent);
  else if (cmd === 'end') res = endMeeting({ decisions: args.decision.filter((x) => typeof x === 'string'), actions: args.action.filter((x) => typeof x === 'string'), agent });
  else if (cmd === 'status') {
    const m = activeMeeting();
    console.log(m ? `In a meeting: "${m.topic}" with ${m.attendees.join(', ')} since ${m.startedAt} (${m.file})` : 'No meeting running.');
    process.exit(0);
  } else {
    console.log('Usage: node harness/meeting.mjs start "<topic>" --with a,b | say "<text>" --agent <name> | end [--decision "..."] [--action "title|role|P2"] | status');
    process.exit(1);
  }
  if (res?.error) {
    console.error(res.error);
    process.exit(1);
  }
  console.log(cmd === 'end' ? `Meeting over. Notes: ${res.file}${res.tasks.length ? `. New tasks: ${res.tasks.join(', ')}` : ''}` : cmd === 'start' ? `Meeting started. Notes: ${res.file}` : 'Noted.');
}
