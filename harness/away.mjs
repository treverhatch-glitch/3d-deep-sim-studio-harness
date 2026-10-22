#!/usr/bin/env node
/**
 * harness/away.mjs — away mode and "while you were away" review (2.30d).
 * When a developer goes away, this module tracks decisions made by the Director and Producer.
 * Upon return, it presents a summary for review. The developer's feedback (great, redo, comment)
 * is recorded to help the AI agents learn and improve their autonomous decision-making.
 *
 *   npm run away -- on --by <dev> | back --by <dev> | status
 *   npm run away -- list [--all] | verdict <id> <great|redo|comment> --by <dev>
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STUDIO_STATE_DIR, REPO_ROOT, emitEvent, readRecentEvents, actor } from './event.mjs';

const AWAY_FILE = path.join(STUDIO_STATE_DIR, 'away.json');
const REVIEWS_FILE = path.join(REPO_ROOT, 'studio', 'away', 'reviews.json');
const LEARNED_FILE = path.join(REPO_ROOT, 'studio', 'memory', 'decisions-learned.md');
const HANDOFF_DIR = path.join(REPO_ROOT, 'studio', 'handoffs');

export const DECIDER_ROLES = ['director', 'producer'];

export function readAway() {
  try {
    return { on: false, ...JSON.parse(fs.readFileSync(AWAY_FILE, 'utf8')) };
  } catch {
    return { on: false };
  }
}

export function goAway(by, { note = '', until = null } = {}) {
  if (!by) return { ok: false, message: 'Say who: --by <name>.' };
  const away = { on: true, by, since: new Date().toISOString(), note, until };
  fs.mkdirSync(STUDIO_STATE_DIR, { recursive: true });
  fs.writeFileSync(AWAY_FILE, JSON.stringify(away, null, 2) + '\n');
  emitEvent({ type: 'away.on', agent: by, msg: `Dev is away. ${note}`.trim() });
  return { ok: true, away };
}

export function comeBack(by) {
  if (!by) return { ok: false, message: 'Say who: --by <name>.' };
  const away = readAway();
  if (!away.on) return { ok: false, message: 'Not in away mode.' };

  const items = collectAwayItems(away.since);
  if (items.length > 0) {
    fs.mkdirSync(path.dirname(REVIEWS_FILE), { recursive: true });
    const reviews = fs.existsSync(REVIEWS_FILE) ? JSON.parse(fs.readFileSync(REVIEWS_FILE, 'utf8')) : { items: [] };
    const existingIds = new Set(reviews.items.map(it => it.eventId));
    const newItems = items.filter(it => !existingIds.has(it.eventId));
    let nextNum = (reviews.items.map(it => parseInt(it.id.split('-')[1], 10)).reduce((a, b) => Math.max(a, b), 0) || 0) + 1;
    for (const item of newItems) item.id = `AW-${nextNum++}`;
    reviews.items.push(...newItems);
    fs.writeFileSync(REVIEWS_FILE, JSON.stringify(reviews, null, 2) + '\n');
    emitEvent({ type: 'away.summary_ready', agent: by, msg: `Welcome back! ${newItems.length} decisions are ready for your review.`, meta: { count: newItems.length } });
  }

  away.on = false;
  fs.writeFileSync(AWAY_FILE, JSON.stringify(away, null, 2) + '\n');
  emitEvent({ type: 'away.off', agent: by, msg: 'Dev is back.' });
  return { ok: true, items };
}

export function collectAwayItems(sinceIso, { events = readRecentEvents(50000), now = Date.now() } = {}) {
  const since = Date.parse(sinceIso);
  const reviewableTypes = ['task.added', 'task.done', 'task.forced', 'task.dropped', 'task.reordered', 'proposed.promoted', 'bible.phase_override', 'director.review', 'decision.made', 'art.approved', 'build.saved'];
  const isDecider = (agent) => DECIDER_ROLES.some(role => agent?.toLowerCase().includes(role));

  const items = [];
  for (const e of events) {
    if (Date.parse(e.ts) < since) continue;
    const isDeciderAction = isDecider(e.agent);
    const isAutoAction = ['task.done', 'build.saved'].includes(e.type);
    if (!reviewableTypes.includes(e.type) || (!isDeciderAction && !isAutoAction)) continue;

    const media = [
      ...(e.meta?.screenshots?.map(p => ({ kind: 'image', path: p })) || []),
      ...(e.meta?.shot ? [{ kind: 'image', path: e.meta.shot }] : []),
      ...(e.meta?.clip ? [{ kind: 'clip', path: e.meta.clip }] : []),
      ...(e.meta?.media || []),
    ];

    items.push({
      id: null, // assigned later
      eventId: e.id,
      ts: e.ts,
      type: e.type,
      by: e.agent,
      task: e.task || null,
      title: e.msg.split('\n')[0].slice(0, 120),
      details: e.msg,
      media,
      verdict: null,
      comment: null,
    });
  }
  return items;
}

export function listReview({ pending = true } = {}) {
  if (!fs.existsSync(REVIEWS_FILE)) return [];
  const { items } = JSON.parse(fs.readFileSync(REVIEWS_FILE, 'utf8'));
  return pending ? items.filter(it => !it.verdict) : items;
}

export async function verdict(id, { by, verdict, comment = '' }) {
  if (!by) throw new Error('Verdict must have a "by" author.');
  if (!['great', 'redo', 'comment'].includes(verdict)) throw new Error('Invalid verdict.');
  if (verdict === 'comment' && !comment) throw new Error('A "comment" verdict requires a non-empty comment.');

  const reviews = JSON.parse(fs.readFileSync(REVIEWS_FILE, 'utf8'));
  const item = reviews.items.find(it => it.id === id);
  if (!item) throw new Error(`Item ${id} not found.`);

  item.verdict = verdict;
  item.comment = comment;
  item.verdictBy = by;
  item.verdictAt = new Date().toISOString();
  fs.writeFileSync(REVIEWS_FILE, JSON.stringify(reviews, null, 2) + '\n');

  const { reopenTask, addTask } = await import('./task.mjs');
  const logLine = `- [${verdict}] ${item.type} by ${item.by}: ${item.title}${comment ? `: ${comment}` : ''}\n`;
  fs.mkdirSync(path.dirname(LEARNED_FILE), { recursive: true });
  fs.appendFileSync(LEARNED_FILE, logLine);

  if (verdict === 'redo') {
    const why = `Dev said redo after away review: ${item.title}${comment ? ' — ' + comment : ''}`;
    if (item.task) {
      if (!reopenTask(item.task, why, by)) {
        fs.mkdirSync(HANDOFF_DIR, { recursive: true });
        fs.appendFileSync(path.join(HANDOFF_DIR, `${item.task}.md`), `\n## ${item.verdictAt} · ${by} (away review: redo)\n${why}\n`);
      }
    } else {
      await addTask({ title: `Redo: ${item.title}`, role: 'producer', priority: 'P1', agent: by, meta: { origin: 'dev', asked: comment || 'redo', awayItem: id } });
    }
  } else if (verdict === 'comment' && item.task) {
    const handoffFile = path.join(HANDOFF_DIR, `${item.task}.md`);
    fs.mkdirSync(HANDOFF_DIR, { recursive: true });
    if (!fs.existsSync(handoffFile)) fs.writeFileSync(handoffFile, `# Handoff notes for ${item.task}\n`);
    const note = `\n## ${item.verdictAt} · ${by} (away review)\n${comment}\n`;
    fs.appendFileSync(handoffFile, note);
    await reopenTask(item.task, `Dev commented after away review: ${comment}`, by);
  }

  emitEvent({ type: 'away.verdict', agent: by, task: item.task, status: verdict, msg: `Dev review for ${item.id} (${item.type} by ${item.by}): ${verdict}`, meta: { item: id, verdict, decider: item.by, type: item.type } });
  return { ok: true, item };
}

export function learnedSummary({ max = 8 } = {}) {
  const stats = { great: 0, redo: 0, comment: 0, byDecider: {} };
  const reviews = fs.existsSync(REVIEWS_FILE) ? JSON.parse(fs.readFileSync(REVIEWS_FILE, 'utf8')).items : [];
  for (const item of reviews) {
    if (!item.verdict) continue;
    stats[item.verdict]++;
    stats.byDecider[item.by] = stats.byDecider[item.by] || { great: 0, redo: 0, comment: 0 };
    stats.byDecider[item.by][item.verdict]++;
  }
  let recent = [];
  try {
    recent = fs.readFileSync(LEARNED_FILE, 'utf8').trim().split('\n').slice(-max);
  } catch {}
  return { ...stats, recent };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const by = arg('--by') || actor();
  const cmd = argv[0] || 'status';

  try {
    if (cmd === 'on') {
      goAway(by, { note: arg('--note'), until: arg('--until') });
      console.log('Set to away mode.');
    } else if (cmd === 'back') {
      const { items } = comeBack(by);
      console.log(`Welcome back! ${items.length} item(s) collected for review.`);
    } else if (cmd === 'list') {
      const items = listReview({ pending: !argv.includes('--all') });
      if (!items.length) {
        console.log('No items to review.');
      } else {
        items.forEach(it => console.log(`[${it.id}] ${it.ts.slice(0, 16).replace('T', ' ')} ${it.by} - ${it.title}`));
      }
    } else if (cmd === 'verdict') {
      const [id, v] = [argv[1], argv[2]];
      await verdict(id, { by, verdict: v, comment: arg('--comment') });
      console.log(`Verdict recorded for ${id}.`);
    } else if (cmd === 'learned') {
      const summary = learnedSummary();
      console.log('Learning Summary:');
      console.log(`  Great: ${summary.great}, Redo: ${summary.redo}, Comment: ${summary.comment}`);
      console.log('\nBy Decider:');
      for (const [agent, data] of Object.entries(summary.byDecider)) {
        console.log(`  ${agent}: ${Object.entries(data).map(([k, v]) => `${k}: ${v}`).join(', ')}`);
      }
      console.log('\nRecent Feedback:');
      summary.recent.forEach(line => console.log(line));
    } else if (cmd !== 'status') {
      console.log('Usage: npm run away -- on|back|list|verdict|learned|status ...');
      process.exit(1);
    } else {
      const away = readAway();
      if (away.on) {
        console.log(`Away mode is ON. Since: ${new Date(away.since).toLocaleString()}. By: ${away.by}.`);
        if (away.note) console.log(`Note: ${away.note}`);
      } else {
        console.log('Away mode is OFF.');
      }
    }
  } catch (e) {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  }
}
