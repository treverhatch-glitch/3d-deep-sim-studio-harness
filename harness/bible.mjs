#!/usr/bin/env node
/**
 * harness/bible.mjs — the Game Bible: what the game is, as structured data a UI or an agent can use.
 *
 *   npm run bible                          show the Bible's state and what it still needs
 *   npm run bible -- check                 exit 1 while the Bible can't be signed yet
 *   npm run bible -- render                rewrite BIBLE.md and NOT-DOING.md from bible.json
 *   npm run bible -- layer <id> yes|explore|no [--phase 1|2|3] [--why "…"] --by <person>
 *   npm run bible -- sign --by <person>    a person signs it: pre-production ends, Phase 1 opens
 *   npm run bible -- phase open <2|3> --by <person> [--force "reason"]
 *   npm run bible -- json                  the whole Bible plus the question and layer catalogs
 *   npm run bible -- voice [--tone "…"] [--do "…"] [--dont "…"] [--never "a, b"] [--example "…"]
 *                                          the game's voice: read by every agent writing what players see
 *
 * The authority is `studio/bible/bible.json`. `BIBLE.md` and `NOT-DOING.md` are written from it for
 * agents to read; edit the JSON through intake, this CLI, the Director, or the War Room, not by hand.
 * Free-form parts stay Markdown next to it: STORYBOARD.md, REFERENCES.md, reviews/, ideas/.
 *
 * Phases are parts of the game the player plays (1 early, 2 mid, 3 endgame). Layers are kinds of
 * progression or systems (levels, a tech tree, factions…). Every layer is answered yes, explore or
 * no; a "no" is crossed out and agents never build it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, emitEvent } from './event.mjs';

export const BIBLE_DIR = path.join(REPO_ROOT, 'studio', 'bible');
export const BIBLE_FILE = path.join(BIBLE_DIR, 'bible.json');
export const IDEAS_DIR = path.join(BIBLE_DIR, 'ideas');
export const REVIEWS_DIR = path.join(BIBLE_DIR, 'reviews');

export const GENRES = ['management', 'simulation', 'strategy', 'rpg', 'roguelike', 'action', 'puzzle', 'story', 'sandbox', 'multiplayer'];

/** How long the game is to play. Shorter is easier: start with a demo. */
export const PLAY_LENGTHS = {
  demo: { label: '15 to 30 minutes (a demo)', layers: 3, involvement: 'The best first project. The studio can finish most of it on its own; you sign the plan and playtest.' },
  short: { label: '1 to 3 hours', layers: 5, involvement: 'Plan on reviews and a playtest from you most weeks.' },
  medium: { label: '5 to 15 hours', layers: 8, involvement: 'Regular involvement: ideas, sign-offs at each phase, playtests.' },
  long: { label: '20 hours or more', layers: 12, involvement: 'A lot of your time. Long games need a person steering often; some people enjoy exactly that.' },
  endless: { label: 'No end (sandbox or live game)', layers: 10, involvement: 'Ongoing design from you, phase after phase.' },
};

/** The intake questions, in order. `kind`: text, list (several lines), choice, multi. */
export const QUESTIONS = [
  { id: 'origin', kind: 'choice', options: ['new', 'existing'], ask: 'Starting from scratch (new), or bringing a game that already exists (existing)?' },
  { id: 'title', kind: 'text', ask: 'Working title of the game?' },
  { id: 'fantasy', kind: 'text', ask: 'What does the player get to be or do? (the fantasy, one sentence)' },
  { id: 'verb', kind: 'text', ask: 'The main thing the player does, minute to minute (one verb or short phrase)?' },
  { id: 'genres', kind: 'multi', options: GENRES, ask: 'Which of these describe it?' },
  { id: 'playLength', kind: 'choice', options: Object.keys(PLAY_LENGTHS), ask: 'How long is the whole game to play? Shorter games are much easier to finish; a demo is the best start.' },
  { id: 'session', kind: 'choice', options: ['5-15 min', '30-60 min', '1-2 h', 'open-ended'], ask: 'How long is one sitting?' },
  { id: 'audience', kind: 'text', ask: 'Who is it for?' },
  { id: 'references', kind: 'list', ask: 'Up to three games it is like, and what you take from each (one per line).' },
  { id: 'never', kind: 'text', ask: 'What must it never be or do?' },
  { id: 'win', kind: 'text', ask: 'How does the player win, finish, or know they are doing well?' },
  { id: 'lose', kind: 'text', ask: 'How can the player fail or fall behind? (or "they can\'t")' },
  { id: 'slice', kind: 'text', ask: 'The first playable slice: the smallest version you could play and judge?' },
  { id: 'platforms', kind: 'multi', options: ['web', 'desktop', 'mobile', 'console'], ask: 'Where does it run?' },
  { id: 'art', kind: 'text', ask: 'Art direction in a few words (style, mood, references)?' },
  { id: 'feelGreat', kind: 'text', ask: 'The one thing that has to feel great?' },
  { id: 'voice', kind: 'text', ask: 'How does the game talk to the player, in a few words (warm, dry, playful, epic…)?' },
  { id: 'pillars', kind: 'list', ask: '3 to 5 pillars, one per line as "name: what it rules out".' },
  { id: 'phase1', kind: 'text', ask: 'Phase 1, early game: what does the player do by hand, and what makes it start to feel slow or small?' },
  { id: 'phase2', kind: 'text', ask: 'Phase 2, mid game: how does the player scale up or build the machine, and what new pressure appears?' },
  { id: 'phase3', kind: 'text', ask: 'Phase 3, endgame: what is the peak test, and how does it end (win, prestige, endless)?' },
];

/** Every kind of progression or system a game might have. A "no" crosses it out. */
export const LAYERS = [
  { id: 'levels-xp', group: 'Growth', label: 'Levels and XP', ask: 'Does the player (or their characters) gain XP and levels?', keywords: ['xp', 'level up', 'player level', 'experience points'], suggest: ['rpg', 'roguelike', 'action'] },
  { id: 'skills', group: 'Growth', label: 'Skills and abilities', ask: 'Are there skills or abilities to learn or choose?', keywords: ['skill', 'skills', 'ability', 'abilities', 'talent'], suggest: ['rpg', 'action', 'roguelike'] },
  { id: 'tech-tree', group: 'Growth', label: 'Tech or research tree', ask: 'Do players unlock things through a tech or research tree?', keywords: ['tech tree', 'research', 'technology'], suggest: ['strategy', 'management', 'simulation'] },
  { id: 'unlocks', group: 'Growth', label: 'Unlocks by licence, rank or reputation', ask: 'Do higher tiers open through licences, rank, reputation or contract tiers?', keywords: ['licence', 'license', 'rank', 'reputation', 'tier unlock'], suggest: ['management', 'simulation'] },
  { id: 'gear-crafting', group: 'Growth', label: 'Gear, loot and crafting', ask: 'Is there gear, loot, or crafting?', keywords: ['loot', 'gear', 'crafting', 'craft', 'equipment', 'inventory'], suggest: ['rpg', 'roguelike', 'action', 'sandbox'] },
  { id: 'collections', group: 'Growth', label: 'Collections', ask: 'Is collecting things (cards, creatures, items) a goal?', keywords: ['collection book', 'collectible', 'collectibles'], suggest: [] },
  { id: 'currency', group: 'Economy', label: 'Currencies', ask: 'Is there money or another currency?', keywords: ['money', 'currency', 'cash', 'coins', 'gold'], suggest: ['management', 'simulation', 'strategy', 'rpg'] },
  { id: 'production-chains', group: 'Economy', label: 'Production chains', ask: 'Do resources turn into other resources in chains?', keywords: ['production chain', 'supply chain', 'refine', 'factory'], suggest: ['management', 'strategy'] },
  { id: 'upkeep-loans', group: 'Economy', label: 'Upkeep and loans', ask: 'Do things cost upkeep over time, or can the player borrow?', keywords: ['upkeep', 'maintenance cost', 'loan', 'debt', 'salary'], suggest: ['management'] },
  { id: 'markets', group: 'Economy', label: 'Markets and prices', ask: 'Do prices move with supply and demand?', keywords: ['market', 'prices', 'trade', 'trading'], suggest: ['management', 'strategy'] },
  { id: 'map-expansion', group: 'World', label: 'Map or space expansion', ask: 'Does the playable space grow (land, rooms, regions)?', keywords: ['map expansion', 'new region', 'new map', 'buy land', 'land parcel'], suggest: ['management', 'strategy', 'sandbox'] },
  { id: 'building', group: 'World', label: 'Building and bases', ask: 'Does the player build or lay out structures?', keywords: ['build mode', 'base building', 'bases', 'construction'], suggest: ['management', 'simulation', 'strategy', 'sandbox'] },
  { id: 'hazards', group: 'World', label: 'Hazards, wear and crisis events', ask: 'Can things break, wear out, or be hit by events and crises?', keywords: ['breakdown', 'breakdowns', 'hazard', 'hazards', 'crisis', 'disaster', 'wear and tear'], suggest: ['management', 'simulation', 'strategy'] },
  { id: 'npc-needs', group: 'People', label: 'Crew, staff and NPC needs', ask: 'Do people in the world have needs, moods, skills or traits?', keywords: ['npc needs', 'mood', 'morale', 'traits', 'staff', 'crew'], suggest: ['management', 'simulation'] },
  { id: 'automation', group: 'People', label: 'Automation and delegation', ask: 'Does the player hand work to staff, schedules or machines later on?', keywords: ['automate', 'automation', 'delegate', 'conveyor'], suggest: ['management', 'simulation', 'strategy'] },
  { id: 'factions', group: 'People', label: 'Factions and standing', ask: 'Are there factions or groups whose standing with the player changes?', keywords: ['faction', 'standing', 'alliance', 'rival'], suggest: ['strategy', 'rpg'] },
  { id: 'governance', group: 'People', label: 'Politics and governance', ask: 'Are there votes, laws, policies or other governance (democracy, councils)?', keywords: ['vote', 'voting', 'election', 'laws', 'democracy', 'council', 'government', 'governance'], suggest: ['strategy'] },
  { id: 'multiplayer', group: 'People', label: 'Social or multiplayer', ask: 'Do players play with or against each other?', keywords: ['multiplayer', 'co-op', 'pvp', 'online', 'leaderboard'], suggest: ['multiplayer'] },
  { id: 'narrative', group: 'Story', label: 'Narrative beats', ask: 'Is there a story told through the game?', keywords: ['story', 'cutscene', 'dialogue', 'narrative'], suggest: ['story', 'rpg'] },
  { id: 'quests', group: 'Story', label: 'Quests and contracts', ask: 'Are there quests, missions or contracts to take on?', keywords: ['quest', 'mission', 'contract', 'objective'], suggest: ['rpg', 'management'] },
  { id: 'victory', group: 'The end', label: 'A final victory', ask: 'Does the game end with a clear win?', keywords: ['victory', 'final win', 'ending', 'credits'], suggest: ['strategy', 'story', 'puzzle'] },
  { id: 'endless', group: 'The end', label: 'Endless sandbox', ask: 'Can play continue forever after the main goals?', keywords: ['endless', 'sandbox mode', 'free play'], suggest: ['sandbox', 'management', 'simulation'] },
  { id: 'prestige', group: 'The end', label: 'Prestige or new game plus', ask: 'Can the player restart with bonuses (prestige, new game plus)?', keywords: ['prestige', 'new game plus', 'ng+', 'rebirth'], suggest: [] },
  { id: 'meta-progression', group: 'The end', label: 'Meta-progression across runs', ask: 'Does progress carry over between runs?', keywords: ['meta progression', 'meta-progression', 'between runs', 'permanent upgrade'], suggest: ['roguelike'] },
];


/** Follow-up questions per kept or explore layer, and per phase. Always available: no model, no keys. */
export const FOLLOWUPS = {
  'voice:win': ['Write one line the game says when the player wins or finishes something big.'],
  'voice:fail': ['Write one line the game says when the player fails or falls behind.'],
  'voice:never': ['Which words or phrases should the game never use? (comma-separated)'],
  'phase:1': ['What does the very first minute look like, before the player has learned anything?', 'What is the first small win, and how long until it happens?'],
  'phase:2': ['What bottleneck from Phase 1 pushes the player into Phase 2, and what solves it?', 'What new pressure appears in the mid game that wasn\'t there before?'],
  'phase:3': ['What is the hardest test the game asks of the player?', 'What does the player see or feel when they finish (or decide to keep playing)?'],
  'levels-xp': ['What earns XP, and what does a new level give the player?', 'Roughly how many levels, and how long should the first one take?'],
  skills: ['How does the player get a new skill: choose it, earn it, or find it?', 'Name one skill early, one mid, one late.'],
  'tech-tree': ['How many tiers does the tree have, and what does the first unlock solve?', 'Is research paid with time, money, or something else?'],
  unlocks: ['What are the tiers called (licences, ranks, reputation levels), and what does each open?', 'How does the player earn the next tier?'],
  'gear-crafting': ['Where does gear come from: drops, shops, or crafting?', 'What is one recipe or item the player will remember?'],
  collections: ['What is collected, and how many are there in total?', 'What does finishing a set give the player?'],
  currency: ['What currencies are there, and what is each one spent on?', 'Where does money come from early, and where does it go late?'],
  'production-chains': ['What is the first chain (raw to finished), and how many steps?', 'What happens when a chain breaks or backs up?'],
  'upkeep-loans': ['What costs money every day or every turn?', 'Can the player borrow, and what happens if they can\'t pay?'],
  markets: ['Which prices move, and what moves them?', 'Can the player influence a market, or only react to it?'],
  'map-expansion': ['How does the playable space grow, and how big is it at the end?', 'What makes a new area worth opening?'],
  building: ['What can the player build, and on what grid or shape rules?', 'Can buildings be moved, upgraded, or destroyed?'],
  hazards: ['What can go wrong, and how often?', 'Can the player prevent it, or only recover from it?'],
  'npc-needs': ['Which needs or traits matter, and how does the player see them?', 'What happens when needs are ignored?'],
  automation: ['What is the first thing the player stops doing by hand?', 'How does the player set up or direct the automation?'],
  factions: ['Which factions are there, and what does each want?', 'How does standing go up or down, and what does it change?'],
  governance: ['What does the player decide (votes, laws, policies), and how often?', 'Who pushes back, and what happens when they do?'],
  multiplayer: ['Together or against each other, and how many players?', 'What does one player see of the others?'],
  narrative: ['Who tells the story, and when does the player hear it?', 'Does the story change with the player\'s choices?'],
  quests: ['Where do quests or contracts come from, and how many at once?', 'Give one example quest from each phase.'],
  victory: ['What exactly triggers the win?', 'What happens after the win?'],
  endless: ['What keeps endless play interesting after the main goals?', 'Does anything get harder or change over time?'],
  prestige: ['What resets on prestige, and what carries over?', 'Why would a player choose to reset?'],
  'meta-progression': ['What carries over between runs?', 'How does a new player\'s first run differ from their tenth?'],
};

/** Follow-ups still unanswered: the phases, and every layer answered yes or explore. */
export function pendingFollowups(b) {
  const keys = ['voice:win', 'voice:fail', 'voice:never', 'phase:1', 'phase:2', 'phase:3', ...LAYERS.filter((l) => ['yes', 'explore'].includes(b.layers?.[l.id]?.answer)).map((l) => l.id)];
  const out = [];
  for (const k of keys) (FOLLOWUPS[k] || []).forEach((q, i) => {
    const key = `${k}#${i + 1}`;
    if (!b.followups?.[key]?.a) out.push({ key, about: k, q, source: 'bank' });
  });
  for (const [key, f] of Object.entries(b.followups || {})) if (f.source === 'model' && !f.a) out.push({ key, about: f.about, q: f.q, source: 'model' });
  return out;
}

export function answerFollowup(b, key, a, by = 'game-dev') {
  const known = pendingFollowups(b).concat(Object.entries(b.followups || {}).map(([k, f]) => ({ key: k, about: f.about, q: f.q, source: f.source })));
  const f = known.find((x) => x.key === key);
  if (!f) return false;
  b.followups = { ...(b.followups || {}), [key]: { about: f.about, q: f.q, a: String(a).trim(), source: f.source, by, at: new Date().toISOString() } };
  // Voice answers also feed the voice guide every writing agent reads.
  if (f.about === 'voice:win' || f.about === 'voice:fail') b.voice = { ...(b.voice || {}), examples: [...new Set([...(b.voice?.examples || []), String(a).trim()])] };
  if (f.about === 'voice:never') b.voice = { ...(b.voice || {}), never: [...new Set([...(b.voice?.never || []), ...String(a).split(',').map((x) => x.trim()).filter(Boolean)])] };
  return true;
}

const now = () => new Date().toISOString();
const rel = (p) => path.relative(REPO_ROOT, p).split(path.sep).join('/');

export function emptyBible() {
  return { version: 1, answers: {}, pillars: [], phases: { 1: {}, 2: {}, 3: {} }, layers: {}, signed: null, phase: { open: 0, history: [] }, updatedAt: now() };
}

export function hasBible() {
  return fs.existsSync(BIBLE_FILE);
}

export function readBible() {
  if (!hasBible()) return null;
  try {
    return { ...emptyBible(), ...JSON.parse(fs.readFileSync(BIBLE_FILE, 'utf8')) };
  } catch {
    return null;
  }
}

export function writeBible(b, { render = true } = {}) {
  b.updatedAt = now();
  fs.mkdirSync(BIBLE_DIR, { recursive: true });
  fs.writeFileSync(BIBLE_FILE, `${JSON.stringify(b, null, 2)}\n`);
  if (render) renderBible(b);
  return b;
}

/** Layers games like this usually have, from the genres and play length. */
export function suggestedLayers(answers = {}) {
  const g = new Set(answers.genres || []);
  const out = new Set(LAYERS.filter((l) => l.suggest.some((s) => g.has(s))).map((l) => l.id));
  if (['medium', 'long', 'endless'].includes(answers.playLength) && (g.has('management') || g.has('simulation'))) out.add('automation');
  if (answers.playLength === 'endless') out.add('endless');
  if (answers.playLength === 'demo' || answers.playLength === 'short') out.add('victory');
  return [...out];
}

/** Turn "name: what it rules out" lines into pillars. */
export function parsePillars(lines) {
  return (Array.isArray(lines) ? lines : String(lines || '').split('\n'))
    .map((l) => String(l).trim())
    .filter(Boolean)
    .map((l) => {
      const [name, ...rest] = l.split(':');
      return { name: name.trim(), rulesOut: rest.join(':').trim().replace(/^rules? out\s+/i, '') };
    });
}

/** Merge intake answers (any subset) into a Bible. Unknown keys are ignored. */
/** Answers that change what the game is: after signing, changing one needs a new signature. */
export const CORE_ANSWERS = ['fantasy', 'verb', 'playLength', 'win', 'lose', 'slice', 'never', 'feelGreat'];
const LIST_IDS = new Set(QUESTIONS.filter((q) => q.kind === 'list').map((q) => q.id));
const asList = (v) => (Array.isArray(v) ? v : String(v).split(/\r?\n/)).map((x) => (typeof x === 'string' ? x.trim() : x)).filter(Boolean);

/** Record a change to a signed Bible: it stays signed for history, but build work waits for a new signature. */
function amend(b, field, from, to) {
  if (!b.signed || JSON.stringify(from ?? null) === JSON.stringify(to ?? null)) return;
  b.amended = b.amended || { since: now(), changes: [] };
  b.amended.changes.push({ field, from: from ?? null, to, at: now() });
}

export function applyAnswers(b, input = {}) {
  const ids = new Set(QUESTIONS.map((q) => q.id));
  b.skipped = [];
  for (const [k, raw] of Object.entries(input.answers || input)) {
    if (!ids.has(k) || raw === undefined || raw === null || raw === '') continue;
    // "One per line" questions accept a list or a newline string.
    const v = LIST_IDS.has(k) && k !== 'pillars' ? asList(raw) : raw;
    // Once signed, pillars are locked: changing one is a person's decision (studio/decisions/), not an intake answer.
    if (k === 'pillars' && b.signed) {
      b.skipped.push('pillars are locked after signing; record a decision and edit them with a person');
      continue;
    }
    if (k === 'pillars') b.pillars = parsePillars(v);
    else if (k === 'voice') b.voice = { ...(b.voice || {}), tone: String(v).trim() };
    else if (/^phase[123]$/.test(k)) {
      amend(b, k, b.phases[k.slice(5)]?.player, String(v).trim());
      b.phases[k.slice(5)] = { ...(b.phases[k.slice(5)] || {}), player: String(v).trim() };
    } else {
      if (CORE_ANSWERS.includes(k)) amend(b, k, b.answers[k], v);
      b.answers[k] = v;
    }
  }
  for (const [id, v] of Object.entries(input.layers || {})) {
    const answer = typeof v === 'string' ? v : v?.answer;
    if (b.signed && b.layers[id]?.answer === 'no' && answer !== 'no') {
      b.skipped.push(`${id} is crossed out; a person brings it back with npm run bible -- layer ${id} yes --by <name>`);
      continue;
    }
    setLayer(b, id, typeof v === 'string' ? { answer: v } : v, { emit: false });
  }
  if (!b.skipped.length) delete b.skipped;
  return b;
}

export function setLayer(b, id, { answer, phase = null, why = '', by = 'intake' }, { emit = true } = {}) {
  if (!LAYERS.some((l) => l.id === id)) throw new Error(`Unknown layer "${id}". Known: ${LAYERS.map((l) => l.id).join(', ')}`);
  if (!['yes', 'explore', 'no'].includes(answer)) throw new Error('A layer answer is yes, explore or no.');
  const prev = b.layers[id];
  b.layers[id] = { answer, phase: answer === 'yes' ? Number(phase) || prev?.phase || 1 : null, why: why || prev?.why || '', by, at: now() };
  if (emit && prev?.answer !== answer) emitEvent({ type: 'bible.layer', agent: by, msg: `Layer ${id}: ${prev?.answer || 'unanswered'} -> ${answer}${why ? ` (${why})` : ''}` });
  return b.layers[id];
}

/** What the Bible still needs before a person can sign it, and soft warnings. */
export function checkBible(b) {
  const missing = [];
  const warnings = [];
  const a = b.answers || {};
  for (const k of ['title', 'fantasy', 'verb', 'playLength', 'win', 'slice']) if (!a[k]) missing.push(`answer "${QUESTIONS.find((q) => q.id === k).ask}" (${k})`);
  const pillars = (b.pillars || []).filter((p) => p.name);
  if (pillars.length < 3 || pillars.length > 5) missing.push(`3 to 5 pillars (has ${pillars.length})`);
  if (pillars.some((p) => !p.rulesOut)) warnings.push('a pillar is stronger when it says what it rules out ("name: what it rules out")');
  for (const n of [1, 2, 3]) if (!b.phases?.[n]?.player) missing.push(`Phase ${n}: what the player does (phase${n})`);
  if (!b.artReference) warnings.push('no art reference yet: the art department proposes a style sheet and the game dev approves it (npm run art)');
  if (b.amended) warnings.push(`changed after signing (${b.amended.changes.map((c) => c.field).join(', ')}): new build tasks wait until a person re-signs (npm run bible -- sign --by <name>)`);
  const unanswered = LAYERS.filter((l) => !b.layers?.[l.id]);
  if (unanswered.length) missing.push(`answer every layer yes, explore or no (${unanswered.length} left: ${unanswered.slice(0, 6).map((l) => l.id).join(', ')}${unanswered.length > 6 ? ', …' : ''})`);
  const kept = LAYERS.filter((l) => b.layers?.[l.id]?.answer === 'yes');
  const budget = PLAY_LENGTHS[a.playLength]?.layers;
  if (budget && kept.length > budget) warnings.push(`${kept.length} layers kept for a ${PLAY_LENGTHS[a.playLength].label} game; about ${budget} is easier to finish. Cross some out or explore them later.`);
  const explore = LAYERS.filter((l) => b.layers?.[l.id]?.answer === 'explore');
  if (explore.length) warnings.push(`${explore.length} layer(s) marked explore: R&D prototypes them, then they become yes or no (${explore.map((l) => l.id).join(', ')})`);
  if (budget && explore.length > budget) warnings.push(`${explore.length} explore layers is a lot for this play length; decide yes or no for most now (npm run bible -- layer <id> yes|no) so R&D can focus.`);
  return { ok: missing.length === 0, missing, warnings, kept: kept.map((l) => l.id), crossed: LAYERS.filter((l) => b.layers?.[l.id]?.answer === 'no').map((l) => l.id) };
}

export function signBible(b, by, { via = null } = {}) {
  const c = checkBible(b);
  if (!c.ok) return { ok: false, error: 'not-ready', missing: c.missing };
  if (!by || /^(producer|director|builder|agent|unknown)$/i.test(by) || by === process.env.STUDIO_PRODUCER_NAME) return { ok: false, error: 'person', message: 'A person signs the Bible, not an agent: pass --by <your name> (or use the War Room).' };
  const resign = Boolean(b.signed);
  if (b.signed) b.signHistory = [...(b.signHistory || []), { ...b.signed, amended: b.amended || null }];
  b.signed = { by, at: now(), ...(via ? { via: String(via).slice(0, 200) } : {}) };
  if (resign) delete b.amended;
  else b.phase = { open: 1, history: [...(b.phase?.history || []), { phase: 1, at: now(), by, reason: 'Bible signed' }] };
  writeBible(b);
  emitEvent({ type: 'bible.signed', agent: by, to: 'producer', msg: resign ? `${by} re-signed the Game Bible${via ? ` (approved via ${via})` : ''}; build work can go on with the amended design.` : `${by} signed the Game Bible${via ? ` (approved via ${via})` : ''}. Pre-production is over; Phase 1 (early game) is open for build tasks.` });
  return { ok: true, bible: b, resign };
}

/** The newest Director review: { file, at, phase, verdict }. */
export function latestReview() {
  if (!fs.existsSync(REVIEWS_DIR)) return null;
  const files = fs.readdirSync(REVIEWS_DIR).filter((f) => f.endsWith('.md') && f !== 'README.md').map((f) => path.join(REVIEWS_DIR, f));
  const parsed = files.map(parseReview).filter(Boolean).sort((x, y) => x.at - y.at);
  return parsed.pop() || null;
}

export function parseReview(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    const verdict = (text.match(/^Verdict:\s*(on course|drifting|off course|phase-ready)\b/im) || [])[1]?.toLowerCase() || null;
    const phase = Number((text.match(/^Phase:\s*([123])\b/im) || [])[1]) || null;
    const checked = (text.match(/^Checked:\s*(.+)$/im) || [])[1] || '';
    const next = /^##\s*Next\b[\s\S]*?^\s*[-*]\s+\S/im.test(text);
    return { file: rel(file), at: fs.statSync(file).mtimeMs, verdict, phase, checked, next, text };
  } catch {
    return null;
  }
}

/** Open the next phase. Needs a Director review saying the current phase is ready, unless forced with a reason. */
export function openPhase(b, n, { by, force = null } = {}) {
  n = Number(n);
  const open = b.phase?.open || 0;
  if (!b.signed) return { ok: false, message: 'Sign the Bible first; that opens Phase 1.' };
  if (n !== open + 1) return { ok: false, message: `Phase ${open} is open; the next one to open is Phase ${open + 1}.` };
  const since = (b.phase.history || []).at(-1)?.at;
  const r = latestReview();
  const ready = r && r.verdict === 'phase-ready' && r.phase === open && (!since || r.at >= Date.parse(since));
  if (!ready && !force) return { ok: false, message: `Phase ${open} needs a Director review with "Verdict: phase-ready" and "Phase: ${open}" since it opened (npm run director -- ping --reason "Is Phase ${open} ready?"), or --force "reason".` };
  b.phase.open = n;
  b.phase.history.push({ phase: n, at: now(), by, reason: force ? `forced: ${force}` : `Director review ${r.file}` });
  writeBible(b);
  emitEvent({ type: force ? 'bible.phase_forced' : 'bible.phase', agent: by || 'producer', to: 'producer', msg: `Phase ${n} (${n === 2 ? 'mid game' : 'endgame'}) is open for build tasks${force ? ` (forced: ${force})` : ''}.` });
  return { ok: true };
}

/** Crossed-out layers a task title touches, each with the word that matched (`word`). */
export function crossedLayersIn(title, b = readBible()) {
  if (!b) return [];
  const t = ` ${String(title).toLowerCase()} `;
  const out = [];
  for (const l of LAYERS) {
    if (b.layers?.[l.id]?.answer !== 'no') continue;
    const word = l.keywords.find((k) => new RegExp(`[^a-z0-9]${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^a-z0-9]`).test(t));
    if (word) out.push({ ...l, word });
  }
  return out;
}

// ---- Ideas (stored here so the task gate can read them without import cycles) ----
export const IDEA_STAGES = ['captured', 'shaped', 'placed', 'approved', 'parked', 'rejected', 'scheduled'];
export function readIdeas() {
  if (!fs.existsSync(IDEAS_DIR)) return [];
  return fs.readdirSync(IDEAS_DIR).filter((f) => /^I-\d+\.json$/.test(f)).sort().map((f) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(IDEAS_DIR, f), 'utf8'));
    } catch {
      return null;
    }
  }).filter(Boolean);
}
export function readIdea(id) {
  return readIdeas().find((i) => i.id === id) || null;
}
export function writeIdea(idea) {
  fs.mkdirSync(IDEAS_DIR, { recursive: true });
  idea.updatedAt = now();
  fs.writeFileSync(path.join(IDEAS_DIR, `${idea.id}.json`), `${JSON.stringify(idea, null, 2)}\n`);
  return idea;
}

// ---- Rendering for agents ----
export function renderBible(b) {
  const a = b.answers || {};
  const L = [];
  L.push(`# Game Bible: ${a.title || '(untitled)'}`, '');
  L.push('> Written from `studio/bible/bible.json` by `npm run bible -- render`. Don\'t edit this file; change the Bible with intake, `npm run bible`, the Director or the War Room.', '');
  L.push(b.signed ? `**Signed** by ${b.signed.by} on ${b.signed.at.slice(0, 10)}. **Open phase:** ${b.phase?.open || 1} of 3.` : '**Not signed yet: pre-production.** Build tasks wait until a person signs it (`npm run bible -- check`).', '');
  L.push('## Pitch', `${a.fantasy || '_?_'} The main verb: **${a.verb || '?'}**.`, '');
  const pl = PLAY_LENGTHS[a.playLength];
  L.push(`- Play length: ${pl ? pl.label : '_?_'}${pl ? `. ${pl.involvement}` : ''}`, `- One sitting: ${a.session || '_?_'}`, `- For: ${a.audience || '_?_'}`, `- Genres: ${(a.genres || []).join(', ') || '_?_'}`, `- Platforms: ${(a.platforms || []).join(', ') || '_?_'}`, `- Art: ${a.art || '_?_'}`, ...(b.artReference ? [`- Art reference: ${b.artReference.file} (approved by ${b.artReference.approvedBy} on ${b.artReference.at.slice(0, 10)}; art and renderer work is checked against it)`] : []), `- Has to feel great: ${a.feelGreat || '_?_'}`, `- Win: ${a.win || '_?_'}`, `- Lose: ${a.lose || '_?_'}`, `- First playable slice: ${a.slice || '_?_'}`, `- Never: ${a.never || '_?_'}`, '');
  if (b.voice && (b.voice.tone || b.voice.examples?.length || b.voice.do?.length)) {
    const v = b.voice;
    L.push('## Voice (how the game talks)', ...[v.tone ? `- Tone: ${v.tone}` : '', ...(v.do || []).map((x) => `- Do: ${x}`), ...(v.dont || []).map((x) => `- Don't: ${x}`), v.never?.length ? `- Never say: ${v.never.join(', ')}` : '', ...(v.examples || []).map((x) => `- Sounds like: "${x}"`)].filter(Boolean), '');
  }
  L.push('## Pillars', ...(b.pillars?.length ? b.pillars.map((p) => `- **${p.name}**${p.rulesOut ? `: rules out ${p.rulesOut}` : ''}`) : ['_None yet._']), '');
  L.push('## Phases', '');
  const names = { 1: 'Early game', 2: 'Mid game', 3: 'Endgame' };
  for (const n of [1, 2, 3]) {
    const open = (b.phase?.open || 0) >= n;
    const layers = LAYERS.filter((l) => b.layers?.[l.id]?.answer === 'yes' && b.layers[l.id].phase === n).map((l) => l.label);
    L.push(`### Phase ${n}: ${names[n]}${open ? ' (open)' : ''}`, b.phases?.[n]?.player || '_?_', ...(layers.length ? [`Layers that enter here: ${layers.join(', ')}.`] : []), '');
  }
  L.push('## Layers', '', '| Layer | Answer | Phase | Why |', '| --- | --- | --- | --- |');
  for (const l of LAYERS) {
    const v = b.layers?.[l.id];
    const ans = !v ? '_not asked_' : v.answer === 'no' ? '~~crossed out~~' : v.answer;
    L.push(`| ${v?.answer === 'no' ? `~~${l.label}~~` : l.label} | ${ans} | ${v?.phase || ''} | ${v?.why || ''} |`);
  }
  const fu = Object.values(b.followups || {}).filter((f) => f.a);
  if (fu.length) {
    L.push('', '## Details (follow-up answers)');
    const label = (k) => (k.startsWith('phase:') ? `Phase ${k.slice(6)}` : LAYERS.find((l) => l.id === k)?.label || k);
    for (const about of [...new Set(fu.map((f) => f.about))]) L.push('', `### ${label(about)}`, ...fu.filter((f) => f.about === about).map((f) => `- ${f.q} **${f.a}**`));
  }
  const refs = a.references ? asList(a.references) : [];
  if (refs.length) L.push('', '## References', ...refs.map((r) => `- ${r}`));
  const ideas = readIdeas().filter((i) => i.stage === 'approved' || i.stage === 'scheduled');
  if (ideas.length) L.push('', '## Approved ideas', ...ideas.map((i) => `- ${i.id} ${i.title}${i.place ? ` (Phase ${i.place.phase}${i.place.layer ? `, ${i.place.layer}` : ''})` : ''}`));
  fs.mkdirSync(BIBLE_DIR, { recursive: true });
  fs.writeFileSync(path.join(BIBLE_DIR, 'BIBLE.md'), `${L.join('\n')}\n`);
  const crossed = LAYERS.filter((l) => b.layers?.[l.id]?.answer === 'no');
  const nd = ['# Not doing', '', '> Written from `bible.json`. Agents never make tasks for these; `task add` refuses titles that touch them. Only a person brings one back (`npm run bible -- layer <id> yes --by <name>`).', ''];
  if (a.never) nd.push(`- **Never:** ${a.never}`);
  for (const l of crossed) nd.push(`- ~~${l.label}~~ (\`${l.id}\`)${b.layers[l.id].why ? `: ${b.layers[l.id].why}` : ''}`);
  if (nd.length === 4) nd.push('_Nothing crossed out yet._');
  fs.writeFileSync(path.join(BIBLE_DIR, 'NOT-DOING.md'), `${nd.join('\n')}\n`);
  for (const [f, body] of [
    ['STORYBOARD.md', '# Storyboard\n\nBeat sheets, screen by screen, across Phase 1, 2 and 3: what the player sees, does and feels. Loop diagrams as Mermaid. Pictures come later and are never the source of truth.\n'],
    ['REFERENCES.md', '# References\n\nComparable games and what we take from each. Studies live in `studio/research/`.\n'],
  ]) if (!fs.existsSync(path.join(BIBLE_DIR, f))) fs.writeFileSync(path.join(BIBLE_DIR, f), body);
  fs.mkdirSync(REVIEWS_DIR, { recursive: true });
  fs.mkdirSync(IDEAS_DIR, { recursive: true });
}

export function catalog() {
  return { questions: QUESTIONS, layers: LAYERS, playLengths: PLAY_LENGTHS, genres: GENRES, ideaStages: IDEA_STAGES };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const flag = (k) => {
    const i = argv.indexOf(`--${k}`);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
  };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      if (argv[i + 1] && !argv[i + 1].startsWith('--')) i++;
    } else positional.push(argv[i]);
  }
  const [cmd = 'show', ...rest] = positional;
  const b = readBible();
  if (cmd === 'json') {
    console.log(JSON.stringify({ bible: b, check: b ? checkBible(b) : null, suggested: b ? suggestedLayers(b.answers) : [], ...catalog() }, null, 2));
    process.exit(0);
  }
  if (!b) {
    console.log('No Game Bible yet. Start one with `npm run intake` (questions about the game, its three phases and its layers).');
    process.exit(cmd === 'check' ? 1 : 0);
  }
  if (cmd === 'render') {
    renderBible(b);
    console.log('Wrote studio/bible/BIBLE.md and NOT-DOING.md');
    process.exit(0);
  }
  if (cmd === 'check' || cmd === 'show') {
    const c = checkBible(b);
    console.log(`${b.answers.title || '(untitled)'}: ${b.signed ? `signed by ${b.signed.by}, Phase ${b.phase.open} open` : 'not signed (pre-production)'}`);
    console.log(`Layers kept: ${c.kept.join(', ') || 'none'}. Crossed out: ${c.crossed.join(', ') || 'none'}.`);
    for (const m of c.missing) console.log(`  [ ] ${m}`);
    for (const w of c.warnings) console.log(`  note: ${w}`);
    if (!b.signed) console.log(c.ok ? 'Ready for a person to sign: npm run bible -- sign --by <name>' : 'Not ready to sign yet.');
    process.exit(cmd === 'check' && !c.ok ? 1 : 0);
  }
  if (cmd === 'layer') {
    const [id, answer] = rest;
    try {
      const by = flag('by') || process.env.STUDIO_LOCK_OWNER || 'producer';
      const prev = b.layers[id]?.answer;
      if (prev === 'no' && answer !== 'no' && b.signed && /^(producer|director)/i.test(by)) {
        console.error(`${id} was crossed out. Only a person brings it back: --by <your name>.`);
        process.exit(1);
      }
      setLayer(b, id, { answer, phase: flag('phase'), why: flag('why') || '', by });
      writeBible(b);
      console.log(`${id}: ${answer}${answer === 'yes' ? ` (Phase ${b.layers[id].phase})` : ''}`);
      process.exit(0);
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
  }
  if (cmd === 'voice') {
    const add = (k, v) => (v ? (b.voice = { ...(b.voice || {}), [k]: [...new Set([...(b.voice?.[k] || []), ...(k === 'never' ? v.split(',').map((x) => x.trim()).filter(Boolean) : [v])])] }) : null);
    if (flag('tone')) b.voice = { ...(b.voice || {}), tone: flag('tone') };
    add('do', flag('do'));
    add('dont', flag('dont'));
    add('never', flag('never'));
    add('examples', flag('example'));
    writeBible(b);
    console.log(b.voice ? Object.entries(b.voice).map(([k, v]) => `${k}: ${[].concat(v).join(' | ')}`).join('\n') : 'No voice yet: --tone "…" --do "…" --dont "…" --never "a, b" --example "…"');
    process.exit(0);
  }
  if (cmd === 'sign') {
    const res = signBible(b, flag('by'), { via: flag('via') });
    if (!res.ok) {
      console.error(res.message || `Not ready to sign:\n${res.missing.map((m) => `  [ ] ${m}`).join('\n')}`);
      process.exit(1);
    }
    console.log(res.resign ? 'Re-signed. The amended design is the Bible now; build tasks can be queued again.' : 'Signed. Pre-production is over; Phase 1 (early game) is open for build tasks.');
    process.exit(0);
  }
  if (cmd === 'pillars' && rest[0] === 'set') {
    // Pillars change only by a person, with a written decision; the new pillars are signed by that person.
    const by = flag('by');
    const decision = flag('decision');
    if (!by || /^(producer|director|builder|agent|unknown)$/i.test(by) || by === process.env.STUDIO_PRODUCER_NAME) {
      console.error('A person changes pillars: --by <your name>.');
      process.exit(1);
    }
    if (!decision || !fs.existsSync(path.resolve(REPO_ROOT, decision))) {
      console.error('Say why in a decision file first (studio/decisions/<date>-pillars.md), then pass --decision <that file>.');
      process.exit(1);
    }
    const lines = rest.slice(1);
    const next = parsePillars(lines);
    if (next.length < 3 || next.length > 5) {
      console.error('Give 3 to 5 pillars, each as one quoted argument: "name: what it rules out".');
      process.exit(1);
    }
    const before = b.pillars;
    b.pillars = next;
    if (b.signed) {
      b.signHistory = [...(b.signHistory || []), { ...b.signed, amended: { changes: [{ field: 'pillars', from: before, to: next, at: now() }] } }];
      b.signed = { by, at: now(), via: `pillars changed with ${decision}` };
      delete b.amended;
    }
    writeBible(b);
    emitEvent({ type: 'bible.pillars', agent: by, to: 'director', msg: `${by} changed the pillars (${decision}): ${next.map((p) => p.name).join(', ')}` });
    console.log(`Pillars changed by ${by}${b.signed ? ', and the Bible is signed with them' : ''}. The Director checks open work against them on its next review.`);
    process.exit(0);
  }
  if (cmd === 'phase' && rest[0] === 'open') {
    const res = openPhase(b, rest[1], { by: flag('by') || process.env.STUDIO_LOCK_OWNER || 'producer', force: flag('force') });
    if (!res.ok) {
      console.error(res.message);
      process.exit(1);
    }
    console.log(`Phase ${rest[1]} is open.`);
    process.exit(0);
  }
  console.log('Usage: npm run bible -- [show | check | render | json | layer <id> yes|explore|no [--phase n] [--why "…"] --by <name> | sign --by <person> | phase open <2|3> --by <name> [--force "reason"]]');
  process.exit(1);
}
