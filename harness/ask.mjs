#!/usr/bin/env node
/**
 * harness/ask.mjs — questions for the game dev, with a deadline and a default the Producer stands behind.
 *
 *   npm run ask -- "<question>" --options "a,b,c" --default b --timeout 4h [--why "…"] [--by producer-1]
 *   npm run ask -- answer A-001 "<option or words>" --by <name>
 *   npm run ask -- reverse A-001 "<option or words>" --by <name>   undo a decision made without you
 *   npm run ask -- list [--open]
 *
 * A question shows under "Needs you" in every War Room view and in the Game plan, where the game dev
 * answers with one click. If nobody answers by the deadline, the default is applied: it is logged as
 * decision.timeout with the asker's reason, written to studio/decisions/decided-without-you.md, listed
 * in the run report, and the dev can reverse it later (which queues the change for the Producer).
 *
 * Never on a timer: signing the Bible, changing pillars, bringing back a crossed-out layer, spending
 * money, or deleting anything. Questions about those wait for a person, however long it takes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, emitEvent } from './event.mjs';

export const ASKS_DIR = path.join(REPO_ROOT, 'studio', 'asks');
const LOG = path.join(REPO_ROOT, 'studio', 'decisions', 'decided-without-you.md');
const PROTECTED = /\b(sign|re-?sign|signature|pillars?|crossed[- ]out|bring back|spend|pay|purchase|buy|budget|money|delete|remove (?:the )?repo|wipe)\b/i;
// Names agents use (a role, a tool or a model, often with -1, -auto-2 …): they can't answer for a person.
const AGENTISH = /^(prod|producer|director|builder|rnd|qa|qa-playtester|playtester|reviewer|planner|art|artist|liaison|scout|reference-scout|designer|balancer|agent|watch|unknown|codex|claude|gemini|agy|gpt|grok|opus|sonnet|haiku|cursor|aider|hermes)\b/i;
const isAgent = (by) => AGENTISH.test(by) || by === process.env.STUDIO_LOCK_OWNER || by === process.env.STUDIO_PRODUCER_NAME;

const read = (f) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
};
export function allAsks() {
  if (!fs.existsSync(ASKS_DIR)) return [];
  return fs.readdirSync(ASKS_DIR).filter((f) => /^A-\d+\.json$/.test(f)).sort().map((f) => read(path.join(ASKS_DIR, f))).filter(Boolean);
}
export const openAsks = () => allAsks().filter((a) => a.status === 'open');
const write = (a) => {
  fs.mkdirSync(ASKS_DIR, { recursive: true });
  fs.writeFileSync(path.join(ASKS_DIR, `${a.id}.json`), `${JSON.stringify(a, null, 2)}\n`);
  return a;
};

export function parseDuration(s) {
  const m = String(s || '').trim().match(/^(\d+(?:\.\d+)?)\s*(m|min|h|d)?$/i);
  if (!m) return null;
  const n = Number(m[1]);
  return n * ({ m: 60000, min: 60000, h: 3600000, d: 86400000 }[(m[2] || 'h').toLowerCase()]);
}

export function ask({ question, options = [], def = null, timeout = null, why = '', by = process.env.STUDIO_LOCK_OWNER || process.env.STUDIO_PRODUCER_NAME || 'producer' }) {
  const q = String(question || '').trim();
  if (!q) return { ok: false, message: 'Ask something: npm run ask -- "<question>" --options "a,b" --default a --timeout 4h' };
  const opts = (Array.isArray(options) ? options : String(options).split(',')).map((o) => o.trim()).filter(Boolean);
  const protectedTopic = PROTECTED.test(q);
  let deadline = null;
  if (timeout && !protectedTopic) {
    const ms = parseDuration(timeout);
    if (!ms) return { ok: false, message: `--timeout is a length like 30m, 4h or 1d (got "${timeout}")` };
    if (!def) return { ok: false, message: 'A question with a deadline needs --default: what the Producer will do if nobody answers.' };
    if (opts.length && !opts.includes(def)) return { ok: false, message: `--default must be one of the options (${opts.join(', ')})` };
    if (!why) return { ok: false, message: 'Say why that default is the right call if nobody answers: --why "…" (it is shown with the decision).' };
    deadline = new Date(Date.now() + ms).toISOString();
  }
  const n = allAsks().length + 1;
  const a = write({ id: `A-${String(n).padStart(3, '0')}`, question: q.slice(0, 500), options: opts, default: def, why: String(why).slice(0, 500), by, at: new Date().toISOString(), deadline, protected: protectedTopic, status: 'open' });
  emitEvent({ type: 'ask.open', agent: by, to: 'human', msg: `${a.id} for the game dev: ${a.question}${deadline ? ` (if no answer by ${deadline.slice(11, 16)} UTC: "${def}")` : ''}` });
  return { ok: true, ask: a, note: protectedTopic && timeout ? 'This is about signing, pillars, money or deleting, so it waits for a person: no deadline.' : null };
}

function resolve(id, status, answer, by, extra = {}) {
  const a = read(path.join(ASKS_DIR, `${id}.json`));
  if (!a) return { ok: false, message: `No question ${id}` };
  if (!by || (isAgent(by) && status !== 'decided')) return { ok: false, message: 'A person answers: --by <your name>. Agents ask; they don\'t answer for the game dev.' };
  if (status !== 'decided' && by === a.by) return { ok: false, message: `${by} asked ${id}; the game dev answers it.` };
  if (!String(answer || '').trim()) return { ok: false, message: 'Give the answer.' };
  return { ok: true, a: write({ ...a, ...extra, status, answer: String(answer).slice(0, 1000), answeredBy: by, answeredAt: new Date().toISOString() }) };
}

export function answer(id, ans, by) {
  const r = resolve(id, 'answered', ans, by);
  if (!r.ok) return r;
  if (r.a.status === 'answered') emitEvent({ type: 'ask.answered', agent: by, to: r.a.by, msg: `${id} answered by ${by}: ${r.a.answer} (${r.a.question})` });
  return { ok: true, ask: r.a };
}

/** Apply defaults to questions past their deadline. Run by the watcher. */
export function expireAsks(now = Date.now()) {
  const decided = [];
  for (const a of openAsks().filter((x) => x.deadline && !x.protected && Date.parse(x.deadline) <= now)) {
    const r = resolve(a.id, 'decided', a.default, a.by);
    if (!r.ok) continue;
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    const head = fs.existsSync(LOG) ? '' : '# Decided without you\n\nQuestions nobody answered in time. The Producer applied its default; reverse any of them with `npm run ask -- reverse <id> "<answer>" --by <name>` or from the War Room.\n';
    fs.appendFileSync(LOG, `${head}\n## ${a.id} · ${new Date(now).toISOString().slice(0, 16).replace('T', ' ')} UTC\n- Question: ${a.question}\n- Decided: ${a.default} (by ${a.by}, after the deadline passed)\n- Why: ${a.why}\n`);
    emitEvent({ type: 'decision.timeout', agent: a.by, to: 'producer', msg: `${a.id}: no answer by the deadline, so ${a.by} decided "${a.default}" (${a.why})`, meta: { ask: a.id } });
    decided.push(a.id);
  }
  return decided;
}

export async function reverse(id, ans, by) {
  const a = read(path.join(ASKS_DIR, `${id}.json`));
  if (!a) return { ok: false, message: `No question ${id}` };
  if (a.status !== 'decided') return { ok: false, message: `${id} is ${a.status}; only a decision made without you can be reversed (answer it instead).` };
  const r = resolve(id, 'reversed', ans, by, { decidedWas: a.answer });
  if (!r.ok) return r;
  const { addTask } = await import('./task.mjs');
  const t = addTask({ title: `Reverse ${id}: ${by} chose "${String(ans).slice(0, 60)}" instead of "${a.answer}" (${a.question.slice(0, 50)})`, role: 'producer', priority: 'P1', agent: by });
  emitEvent({ type: 'decision.reversed', agent: by, to: 'producer', task: t.id, msg: `${by} reversed ${id}: "${ans}" instead of "${a.answer}"` });
  return { ok: true, ask: r.a, task: t.id };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const flag = (k) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : null);
  const pos = argv.filter((x, i) => !x.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--')));
  const out = (r, line) => {
    if (!r.ok) {
      console.error(r.message);
      process.exit(1);
    }
    console.log(line(r));
    process.exit(0);
  };
  if (pos[0] === 'answer') out(answer(pos[1], pos[2], flag('by')), (r) => `${r.ask.id} answered: ${r.ask.answer}`);
  if (pos[0] === 'reverse') out(await reverse(pos[1], pos[2], flag('by')), (r) => `${r.ask.id} reversed; the Producer has ${r.task} to undo it.`);
  if (pos[0] === 'expire') {
    const d = expireAsks();
    console.log(d.length ? `Decided by default: ${d.join(', ')}` : 'Nothing past its deadline.');
    process.exit(0);
  }
  if (pos[0] === 'list' || !pos.length) {
    const list = argv.includes('--open') ? openAsks() : allAsks();
    console.log(list.length ? list.map((a) => `${a.id} [${a.status}] ${a.question}${a.options.length ? ` (${a.options.join(' / ')})` : ''}${a.status === 'open' && a.deadline ? `; default "${a.default}" at ${a.deadline.slice(0, 16)}` : ''}${a.answer ? ` -> ${a.answer}` : ''}`).join('\n') : 'No questions yet.');
    process.exit(0);
  }
  out(ask({ question: pos[0], options: flag('options') || [], def: flag('default'), timeout: flag('timeout'), why: flag('why') || '', by: flag('by') || undefined }), (r) => `${r.ask.id} asked${r.ask.deadline ? `; if nobody answers by ${r.ask.deadline.slice(0, 16)} UTC the default "${r.ask.default}" applies (logged)` : '; it waits for a person'}.${r.note ? ` ${r.note}` : ''}`);
}
