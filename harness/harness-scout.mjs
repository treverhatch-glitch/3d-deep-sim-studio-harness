/**
 * harness/harness-scout.mjs — 2.73.0 (f): the weekly harness scout, a research task the supervisor files once a week.
 *
 * Off by default: the owner turns it on with STUDIO_HARNESS_SCOUT=on (the studio's .env). Then on STUDIO_SCOUT_DAY
 * (monday by default; a day name, its first three letters, or 0-6 with 0 = sunday; the day in STUDIO_TZ, else UTC) the
 * supervisor's pass adds ONE task of the research type (harness/research.mjs, 2.71.0):
 *   "Research: weekly harness scout (week of <date>): new harness and agent-tooling ideas"   role rnd, P2
 * and writes its write-up template (docs/research/<ID>.md, or the game's docs folder): new harness/agent-tooling ideas
 * from the past week, each with its sources, the claim, whether it is measured or a vendor claim, and which scorecard
 * number it could move (with the studio's numbers over the last 7 days at filing time, from the event log). `task done`
 * refuses the write-up without a linked source, as for any research task.
 * Once per week (.studio/harness-scout.json); never a second while the last one is still open. Paperwork only: the
 * harness makes no network call; the reading is the task's.
 */
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, emitEvent, readRecentEvents } from './event.mjs';
import { researchRel } from './research.mjs';
import { baselineMeasures } from './upgrade-baseline.mjs';

const DAY = 86400000;
export const SCOUT_TITLE = 'Research: weekly harness scout';
const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const stateFile = (root) => path.join(root, '.studio', 'harness-scout.json');
export const scoutOn = (env = process.env) => /^(on|1|true|yes)$/i.test(String(env.STUDIO_HARNESS_SCOUT || '').trim());

/** STUDIO_SCOUT_DAY as 0-6 (0 = sunday); monday when unset or not a day. */
export function scoutDay(env = process.env) {
  const v = String(env.STUDIO_SCOUT_DAY || '').trim().toLowerCase();
  if (/^[0-6]$/.test(v)) return Number(v);
  const i = DAYS.findIndex((d) => v && (d === v || d.slice(0, 3) === v.slice(0, 3)));
  return i >= 0 ? i : 1;
}

const zoneOf = (env) => { const z = String(env.STUDIO_TZ || '').trim().replace(/^:/, ''); if (z) { try { new Intl.DateTimeFormat('en-US', { timeZone: z }); return z; } catch { /* UTC */ } } return 'UTC'; };
/** { weekday (0-6), date: "YYYY-MM-DD" } of `ms` in the studio's zone. */
export function localDay(ms, env = process.env) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zoneOf(env), year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'long' }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { weekday: DAYS.indexOf(String(p.weekday).toLowerCase()), date: `${p.year}-${p.month}-${p.day}` };
}

const v = (m) => (m?.value ?? '-');
export function scoutTemplate(task, { week, from, measures = null }) {
  const nums = measures ? `landed per hour ${v(measures.landedPerHour)}, false reds per train ${v(measures.falseRedsPerTrain)}, red verify ${v(measures.redVerifyPct)}%, tokens per landed change ${v(measures.tokensPerLanded)} (by task ${measures.tokensByTask?.tokensPerLandedNamed ?? '-'}), workarounds per day ${v(measures.workaroundsPerDay)}, hand-backs per landed ${v(measures.handBacksPerLanded)}` : 'not available';
  return `# ${task.id} research: weekly harness scout (week of ${week})

## Question
What new harness and agent-tooling ideas appeared in the past week (${from} to ${week}) that could move one of this studio's
scorecard numbers? The studio's numbers over the last 7 days when this was filed: ${nums}.
(npm run autonomy and npm run autonomy -- impact have the rest.)

## Sources
<!-- One line each: what it is, its link (https://…), when it was published and when you read it. At least one link; done refuses without. -->
- (source title): (link), published (date), read (date)

## Findings
<!-- One block per idea. Each block names its sources. "measured" only when the source shows numbers from a run someone
     can check (a benchmark, an eval, a repo with results); otherwise "vendor claim" (an announcement, a post, a demo). -->
### (idea)
- Sources: (links from the list above)
- The claim: (what it is said to do, in one or two lines)
- Evidence: measured | vendor claim (and why)
- Scorecard number it could move: landed per hour | false reds per train | tokens per landed change | red verify % | workarounds per day | hand-backs per landed | (another: name it), and which way
- Smallest try: (the experiment, and what it costs)

## Unverified
<!-- What you could not confirm from a source. Write "none" if none. -->

## Recommendation
<!-- The idea to try next, if any, as one task, with the prediction it implies (npm run release -- predict --metric <name>
     --expect "<-x%>"). "Nothing worth trying this week" is a fine answer. -->
`;
}

/**
 * The supervisor's call, once per pass: files the week's scout task on the scout day. Returns null (nothing to do) or
 * { line, task?, dryRun? }. deps.addTask: task.mjs's addTask (tests pass their own).
 */
export async function scoutPass({ now = Date.now(), env = process.env, root = REPO_ROOT, dryRun = false, deps = {} } = {}) {
  if (!scoutOn(env)) return null;
  const today = localDay(now, env);
  if (today.weekday !== scoutDay(env)) return null;
  let st = {};
  try { st = JSON.parse(fs.readFileSync(stateFile(root), 'utf8')) || {}; } catch { st = {}; }
  if (st.lastWeek === today.date) return null;
  const task = deps.task || (await import('./task.mjs'));
  const open = (() => { try { const q = task.parseNextQueue(); return [...q.inProgress, ...q.backlog].find((t) => String(t.title || '').startsWith(SCOUT_TITLE)); } catch { return null; } })();
  if (open) {
    if (!dryRun) { try { fs.mkdirSync(path.dirname(stateFile(root)), { recursive: true }); fs.writeFileSync(stateFile(root), `${JSON.stringify({ ...st, lastWeek: today.date, skipped: open.id }, null, 2)}\n`); } catch {} }
    return { line: `harness scout: last week's ${open.id} is still open; no second one filed` };
  }
  const title = `${SCOUT_TITLE} (week of ${today.date}): new harness and agent-tooling ideas`;
  if (dryRun) return { line: `harness scout: would file "${title}" (dry run)`, dryRun: true };
  const r = (deps.addTask || task.addTask)({ title, role: 'rnd', priority: 'P2', agent: task.PRODUCER_NAME ? task.PRODUCER_NAME() : 'producer', overlap: false, meta: { origin: 'harness-scout', promoted: true, type: 'research' } });
  if (!r?.id) return { line: `harness scout: not filed (${r?.message || r?.error || 'no task id'})` };
  const from = localDay(now - 7 * DAY, env).date;
  let measures = null;
  try { const ev = readRecentEvents(100000); measures = baselineMeasures(ev, now - 7 * DAY, now, { env }); } catch { measures = null; }
  const rel = researchRel(r.id, root);
  try {
    const f = path.join(root, rel);
    if (!fs.existsSync(f)) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, scoutTemplate({ id: r.id }, { week: today.date, from, measures })); }
  } catch { /* the task stands; task start writes the plain template */ }
  try { fs.mkdirSync(path.dirname(stateFile(root)), { recursive: true }); fs.writeFileSync(stateFile(root), `${JSON.stringify({ lastWeek: today.date, task: r.id, at: new Date(now).toISOString() }, null, 2)}\n`); } catch {}
  try { emitEvent({ type: 'harness.scout_filed', agent: 'supervisor', task: r.id, to: 'producer', msg: `Weekly harness scout filed: ${r.id} (${rel})`, meta: { week: today.date, file: rel, duplicate: Boolean(r.duplicate) } }); } catch {}
  return { line: `harness scout: filed ${r.id} (write-up template ${rel})`, task: r.id, file: rel };
}
