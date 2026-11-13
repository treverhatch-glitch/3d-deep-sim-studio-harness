/**
 * qa/selftest-285c.mjs — 2.85 (c): the game's own money is not real money (B-136), every ask resolves, and the
 * "continue or hand off?" check decides by rule.
 *
 *   money     a game-rules question that says "dollars" and "fee" (the ferry toll: the contract share or a flat
 *             8 dollars a car on the fee card?) is answered by the owner's stand-ins (a beta-mode agent, an outside
 *             signer); every family of real-spending words is still refused to both, with --game-rules and with a quoted
 *             --permission, and the refusal names the word; "8 dollars" with nothing tying it to the game stays the
 *             owner's; a game-work task or a Bible system ties it; the readAs record and the digest line
 *             (harness/owner-acts.mjs, harness/ask.mjs, harness/digest.mjs)
 *   timers    a default and no --timeout: STUDIO_ASK_TIMEOUT_H; no default: ask.stale once at STUDIO_ASK_STALE_H, never
 *             answered; the owner's own asks: never a deadline, never escalated (injected clock)
 *   refresh   the check point decides by rule (STUDIO_REFRESH_DECIDE): under the percentage it continues, over it or
 *             idle it hands off, no ask; `ask` mode still asks (harness/session-cap.mjs)
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export async function selftest285C({ dir, root, report, tmpRoot }) {
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const tail = (r, n = 300) => `[${r.status}] ${out(r).replace(/\s+/g, ' ').trim().slice(-n)}`;
  const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const gEnv = () => { const e = { ...process.env, ...ident }; for (const k of Object.keys(e)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|CONFIG.*|NO_REPLACE_OBJECTS)$/.test(k)) delete e[k]; return e; };
  const g = (cwd, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'core.autocrlf=false', ...a], { windowsHide: true, cwd, encoding: 'utf8', env: gEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
  const write = (b, rel, text) => { fs.mkdirSync(path.dirname(path.join(b, rel)), { recursive: true }); fs.writeFileSync(path.join(b, rel), text); };
  const guard = async (name, fn) => { try { const [ok, detail] = await fn(); report(name, Boolean(ok), ok ? '' : String(detail || '').slice(0, 3500)); } catch (e) { report(name, false, String(e?.stack || e).slice(0, 2500)); } };
  const harnessRoot = root || dir;
  const clean = {};
  for (const k of Object.keys(process.env)) if (/^(CLAUDE|CODEX|CURSOR|AIDER|GEMINI|STUDIO_|AGENT_|AI_AGENT|ANTHROPIC|OPENAI)/i.test(k)) clean[k] = '';
  const base = {
    ...clean, ...ident, STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_WATCHDOG: 'off', STUDIO_VISUAL_GATE: 'off', STUDIO_HOOKS_CHECK: 'off', STUDIO_MACHINE_SCAN: 'off',
    STUDIO_REACHABILITY: 'off', STUDIO_LANE_INFER: 'off', STUDIO_CREW_WATCH: 'off', STUDIO_OVERLAP: 'off', STUDIO_LANELESS: 'shared',
    STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-285c-${process.pid}.pem`), CI: '', GITHUB_ACTIONS: '', NODE_OPTIONS: '', npm_lifecycle_event: '', npm_config_node_options: '',
  };

  // ---- 1. the reading itself (harness/owner-acts.mjs) ----
  const oa = await import(pathToFileURL(path.join(dir, 'harness', 'owner-acts.mjs')).href);
  const FIELD = 'The ferry toll: the contract share or a flat 8 dollars a car on the fee card?';
  const act = (q, ctx) => (ctx ? oa.ownerOnlyTopic(q, '', ctx) : oa.ownerOnlyTopic(q))?.act || null;
  await guard('2.85 (c) money, the reading: a game-rules question that says "dollars" and "fee" with no real-spending word (the ferry toll: the contract share or a flat 8 dollars a car on the fee card?) is not the owner\'s real money, and is recorded as read as the game\'s own money (fails before this fix: none of the in-game words, so it was owner-only "real money")', () => {
    const r = oa.ownerOnlyReadAs(FIELD);
    return [act(FIELD) === null && r.length === 1 && r[0].act === 'money' && /game-design subject/.test(r[0].why), JSON.stringify({ act: act(FIELD), r })];
  });
  // One question per family of real spending, each written to look like a game question (in-game words, a game-design
  // subject) and read with a --game-rules tag and a game-work task: every one stays the owner's.
  const families = {
    currency: 'In-game shop balance: price the pack at 4 euros?',
    plan: 'Game balance: upgrade to the pro plan of the tile tool for 20 dollars so the level art is done?',
    subscription: 'In-game economy: the music library subscription is 9 dollars a month, keep it?',
    invoice: 'Level 3 tuning: pay the invoice of 300 dollars for the playtest build?',
    vendor: 'In-game music for level 2: pay the composer 300 dollars?',
    store: 'Game balance: the asset store price for the truck pack is 15 dollars, take it?',
    card: 'In-game unlock art: charge it to our card, 30 dollars?',
    topup: 'Tuning pass: a top-up of 50 dollars so the balance bots keep running?',
    api: 'Game balance sweep: the API credits cost 40 dollars, run it anyway?',
    hiring: 'In-game balance check: hire testers for 500 dollars?',
    bounty: 'In-game crash on level 4: post a bounty of 100 dollars on the issue?',
    buying: 'In the game the trucks are too plain: should we buy a few for 25 dollars from the art site?',
    owner: 'In-game currency: sell coins as in-app purchases at 2 dollars?',
  };
  const tie = { gameRules: true, gameTie: 'T-1 (a change task)' };
  await guard('2.85 (c) money, real spending: one word of each family of real spending (a real currency, a paid or pro plan, a subscription, an invoice, a vendor or composer, an online store, a card, a top-up, API credits, hiring people, a bounty, "we buy", in-app purchases) keeps a question the owner\'s even when it says "in-game", names a game subject, is tagged --game-rules and is tied to a game task, and the reading names the word and its family (fails before this fix: a composer, our card, a top-up, hiring, a bounty and "we buy" next to "in-game" were read as the game\'s own money)', () => {
    const wrong = Object.entries(families).filter(([fam, q]) => act(q) !== 'money' || act(q, tie) !== 'money' || oa.realSpendWord(q)?.family !== fam).map(([fam, q]) => `${fam}: ${act(q)}/${act(q, tie)}/${JSON.stringify(oa.realSpendWord(q))}`);
    return [wrong.length === 0, wrong.join(' | ')];
  });
  await guard('2.85 (c) money, the safe default: "8 dollars" with no game subject, no game task and no tag stays the owner\'s, and the refusal\'s words say it was "dollars" with nothing tying it to the game; the same question tagged --game-rules or tied to a game-work task is the game\'s own money; real spending with no money word ("upgrade to the paid tier") is the owner\'s too (fails before this fix: a tag and a task tie were not read, and "upgrade to the paid tier" was nobody\'s)', () => {
    const q = 'Is 8 dollars a car right?';
    const w = oa.ownerOnlyWord(oa.ownerOnlyTopic(q), q);
    const tagged = oa.ownerOnlyReadAs(q, '', { gameRules: true });
    const tied = oa.ownerOnlyReadAs(q, '', { gameTie: 'T-7 (a bug task)' });
    const alone = act('Upgrade to the paid tier of the art tool?');
    return [act(q) === 'money' && /"dollars", and nothing ties/.test(w) && act(q, { gameRules: true }) === null && tagged[0]?.act === 'money' && /--game-rules/.test(tagged[0].why) && /T-7/.test(tied[0]?.why || '') && alone === 'money',
      JSON.stringify({ act: act(q), w, tagged, tied, alone })];
  });

  await guard('2.85 (c) money, someone in the game buys: "players buy tools from the shop; should the price double after level 3?" and "the player hires a second cleaner for 500 dollars" are the game\'s own money (the buyer is inside the game); the same buyer with a paid plan, a real currency or a card in the question stays the owner\'s, and so does "we buy" (fails before this fix: "buy tools" read as real spending)', async () => {
    const game = ['Players buy tools from the shop; should the price double after level 3?', 'The player hires a second cleaner for 500 dollars: too cheap?', 'Customers can rent a boat for 40 dollars a day. Raise it?'];
    const real = ['Players buy tools from the shop; should we buy the tool pack for 20 dollars?', 'The player buys the pro plan for 9 dollars?', 'Should the player pay 4 euros for the boat?', 'Customers rent boats; charge it to our card?'];
    const wrong = [...game.filter((q) => act(q) !== null || oa.ownerOnlyReadAs(q)[0]?.act !== 'money').map((q) => `game read as the owner's: ${q}`), ...real.filter((q) => act(q) !== 'money' || act(q, tie) !== 'money').map((q) => `real read as the game's: ${q}`)];
    return [wrong.length === 0, wrong.join(' | ')];
  });

  // ---- the studio: beta mode naming overseer-1, signer-1 in the main checkout's .env ----
  const S = path.join(tmpRoot, `285c-studio-${process.pid}`);
  fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
  for (const x of ['.studio', '.env', 'studio/beta.json', 'studio/delegation.json', 'studio/approvals', 'studio/keys', 'studio/task-holds.json', 'studio/asks', 'studio/decisions', 'studio/bible', 'studio/engine', 'studio/digest']) fs.rmSync(path.join(S, x), { recursive: true, force: true });
  try { fs.symlinkSync(path.join(harnessRoot, 'node_modules'), path.join(S, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir'); } catch { /* the checks need no package */ }
  const { publicKey } = crypto.generateKeyPairSync('ed25519');
  write(S, 'studio/keys/owner-ed25519.pub.pem', publicKey.export({ type: 'spki', format: 'pem' }));
  write(S, 'studio/beta.json', `${JSON.stringify({ on: true, by: 'pat', at: '2026-11-05T01:00:00.000Z', why: 'beta for the selftest', agents: ['overseer-1'], roles: ['producer', 'director'] }, null, 2)}\n`);
  write(S, '.gitignore', `${fs.existsSync(path.join(dir, '.gitignore')) ? fs.readFileSync(path.join(dir, '.gitignore'), 'utf8') : ''}\n/.lanes/\n/.studio/\n.env\n`);
  write(S, '.env', 'STUDIO_OUTSIDE_SIGNERS=signer-1\n');
  const ev = path.join(S, '.studio', 'events-285c.jsonl');
  fs.mkdirSync(path.dirname(ev), { recursive: true }); fs.writeFileSync(ev, '');
  g(S, 'init', '-q', '-b', 'main'); g(S, 'add', '-A'); g(S, 'commit', '-qm', 'studio, owner key, beta on', '--no-verify');
  const env = { ...process.env, ...base, AGENT_EVENTS_FILE: ev, STUDIO_MAIN_ROOT: S };
  const cli = (actor, args) => spawnSync(process.execPath, args, { windowsHide: true, cwd: S, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000, env: { ...env, ...actor } });
  const events = () => { try { return fs.readFileSync(ev, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } };
  const u = (rel) => JSON.stringify(pathToFileURL(path.join(S, rel)).href);
  let pn = 0;
  const probe = (code, extra = {}) => {
    const f = path.join(S, `.probe-285c-${++pn}.mjs`);
    fs.writeFileSync(f, code);
    const r = cli(extra, [f]);
    try { fs.rmSync(f, { force: true }); } catch { /* left for the sweep */ }
    const l = String(r.stdout || '').split('\n').filter((x) => x.startsWith('{')).pop();
    try { return { ...JSON.parse(l), _out: out(r).slice(-1200) }; } catch { return { _raw: out(r).slice(-2500) }; }
  };
  const OVER = { CLAUDECODE: '1', STUDIO_LOCK_OWNER: 'overseer-1' }; // the beta-mode named agent
  const SIGNER = { AI_AGENT: '1', STUDIO_LOCK_OWNER: 'signer-1' }; // the outside signer the owner lists in .env
  const ASKER = { STUDIO_LOCK_OWNER: 'builder-c1' };
  const STANDINS = { overseer: [OVER, 'overseer-1'], signer: [SIGNER, 'signer-1'] };
  const askAs = (q, extra = []) => (out(cli(ASKER, ['harness/ask.mjs', q, '--by', 'builder-c1', ...extra])).match(/\b(A-\d+)\b/) || [])[1];
  const doc = (id) => readJson(path.join(S, 'studio', 'asks', `${id}.json`));
  const addTask = (title) => (out(cli({}, ['harness/task.mjs', 'add', title, '--role', 'builder', '--priority', 'P1'])).match(/\b(T-\d+)\b/) || [])[1];
  const PERM = ['--permission', 'the owner said in chat: answer the game-rules asks for me'];

  // ---- 2. through the ask command ----
  {
    const res = {};
    for (const [who, [actor, name]] of Object.entries(STANDINS)) {
      const id = askAs(`${FIELD} (${who})`);
      const r = cli(actor, ['harness/ask.mjs', 'answer', id, 'contract share', '--by', name]);
      const d = doc(id);
      const e = events().filter((x) => x.type === 'ask.answered' && x.meta?.ask === id).pop();
      res[who] = { id, r: tail(r, 200), s: d?.status, recordedBy: d?.recordedBy, readAs: (d?.readAs || []).map((x) => x.act), evReadAs: (e?.meta?.readAs || []).map((x) => x.act) };
    }
    await guard('2.85 (c) money, through `ask -- answer`: the toll question is answered unattended by a beta-mode agent (overseer-1) and by an outside signer (signer-1), each recorded as theirs, with readAs "money" on the ask and on the ask.answered event (fails before this fix: both were refused, "is about real money")', () => [
      ['overseer', 'signer'].every((w) => res[w].s === 'answered' && res[w].recordedBy === STANDINS[w][1] && res[w].readAs.includes('money') && res[w].evReadAs.includes('money')), JSON.stringify(res)]);
  }
  {
    const res = {};
    for (const [fam, q] of Object.entries(families)) {
      const id = askAs(q, ['--game-rules']);
      for (const [who, [actor, name]] of Object.entries(STANDINS)) {
        const r = cli(actor, ['harness/ask.mjs', 'answer', id, 'yes', '--by', name, ...PERM]);
        const word = oa.realSpendWord?.(q)?.word || '?';
        const ok = r.status !== 0 && /^Refused: .*real money/m.test(out(r)) && out(r).includes(`"${word}"`) && doc(id)?.status === 'open';
        if (!ok) res[`${fam}/${who}`] = tail(r, 260);
      }
    }
    await guard('2.85 (c) money, through `ask -- answer`: an ask from each family of real spending, tagged --game-rules, is refused to the beta-mode agent and to the outside signer even with the owner\'s permission quoted (--permission), stays open, and the refusal names the word that made it real money (fails before this fix: the refusal named no word, and the composer, card, top-up, hiring, bounty and "we buy" asks were answered)', () => [Object.keys(res).length === 0, JSON.stringify(res)]);
  }
  {
    const q = 'Is 8 dollars a car right?';
    const plain = askAs(q);
    const game = addTask('Toll rules for the ferry dock');
    const tool = addTask('[chore] harness flag for the land script');
    const tiedGame = askAs(q, ['--task', game]);
    const tiedTool = askAs(q, ['--task', tool]);
    const tagged = askAs(q, ['--game-rules']);
    const r = {};
    for (const [k, id] of Object.entries({ plain, tiedGame, tiedTool, tagged })) {
      const a = cli(OVER, ['harness/ask.mjs', 'answer', id, 'yes', '--by', 'overseer-1']);
      r[k] = { id, st: a.status, s: doc(id)?.status, out: tail(a, 700), tie: doc(id)?.gameTie ?? null };
    }
    await guard('2.85 (c) money, the safe default through the command: "Is 8 dollars a car right?" with no tie and no tag is refused to the beta-mode agent (the refusal says "dollars" and that nothing ties it to the game); tied with --task to a game-work task (a change task) or tagged --game-rules it is answered; tied to a tooling task ([chore] harness …) it is still refused (fails before this fix: --task and --game-rules were not read)', () => [
      game && tool && r.plain.st !== 0 && /"dollars", and nothing ties/.test(r.plain.out) && r.plain.s === 'open' && r.tiedGame.s === 'answered' && /\(a change task\)/.test(r.tiedGame.tie || '') && r.tagged.s === 'answered' && r.tiedTool.st !== 0 && r.tiedTool.s === 'open',
      JSON.stringify({ game, tool, r })]);
  }
  {
    // A system the Bible keeps ties a question to the game: the loans layer kept, "a loan" is the game's.
    write(S, 'studio/bible/bible.json', `${JSON.stringify({ version: 1, answers: {}, pillars: [], layers: { 'upkeep-loans': { answer: 'yes' } }, phases: { 1: {}, 2: {}, 3: {} } }, null, 2)}\n`);
    const id = askAs('Should a loan cost 8 dollars a day?');
    const a = cli(SIGNER, ['harness/ask.mjs', 'answer', id, 'yes', '--by', 'signer-1']);
    fs.rmSync(path.join(S, 'studio', 'bible'), { recursive: true, force: true });
    await guard('2.85 (c) money, a Bible system: with the Bible keeping the upkeep-and-loans layer, "should a loan cost 8 dollars a day?" is tied to the game (the Bible\'s "loan") and the outside signer answers it (fails before this fix: refused as real money)', () => [
      doc(id)?.status === 'answered' && /Bible's "loan"/.test(doc(id)?.gameTie || ''), JSON.stringify({ a: tail(a, 300), d: doc(id) })]);
  }
  {
    const r = probe(`const d = await import(${u('harness/digest.mjs')});
const need = await d.needsPerson({ events: [] });
console.log(JSON.stringify({ lines: need.map((x) => x.line) }));`);
    const lines = r.lines || [];
    const readLine = lines.find((l) => /about money were read as the game's own money: /.test(l)) || '';
    const ownerLine = lines.find((l) => /waiting for the owner/.test(l)) || '';
    const readIds = (readLine.match(/A-\d+/g) || []);
    const shouldRead = fs.readdirSync(path.join(S, 'studio', 'asks')).map((f) => readJson(path.join(S, 'studio', 'asks', f))).filter((a) => (a?.readAs || []).some((x) => x.act === 'money')).map((a) => a.id);
    await guard('2.85 (c) money, the digest: one line lists every ask of the day whose money words were read as the game\'s own money ("N asks about money were read as the game\'s own money: <ids>"), and the owner\'s own open asks are listed apart as waiting for the owner (fails before this fix: neither line existed)', () => [
      shouldRead.length >= 4 && shouldRead.slice(0, 8).every((x) => readIds.includes(x)) && new RegExp(`^${shouldRead.length} asks about money were read`).test(readLine) && /money/.test(ownerLine) && /A-\d+/.test(ownerLine),
      JSON.stringify({ lines, shouldRead, r: r._raw || r._out })]);
  }

  // ---- 3. every ask resolves (injected clock) ----
  {
    const T0 = Date.parse('2026-11-13T00:00:00.000Z');
    const H = 3600000;
    const r = probe(`import fs from 'node:fs';
import path from 'node:path';
const m = await import(${u('harness/ask.mjs')});
fs.rmSync(path.join(process.cwd(), 'studio', 'asks'), { recursive: true, force: true });
const T0 = ${T0}; const H = ${H};
const evs = () => fs.readFileSync(process.env.AGENT_EVENTS_FILE, 'utf8').split('\\n').filter(Boolean).map((l) => JSON.parse(l));
const withDef = m.ask({ question: 'Which panel first, the gates or the shops?', options: ['gates', 'shops'], def: 'gates', why: 'the gates panel teaches the flow', by: 'builder-t1', now: T0 }).ask;
const noDef = m.ask({ question: 'Which colour for the gates panel?', options: ['blue', 'green'], by: 'builder-t1', now: T0 }).ask;
const owner = m.ask({ question: 'Is 8 dollars a car right?', options: ['yes', 'no'], def: 'no', why: 'safe', by: 'builder-t1', now: T0 }).ask;
const short = m.ask({ question: 'Which dock name style?', options: ['a', 'b'], def: 'a', by: 'builder-t1', now: T0, env: { STUDIO_ASK_TIMEOUT_H: '1' } }).ask;
// An ask made before 2.85: a default and no deadline at all.
fs.writeFileSync(path.join(m.ASKS_DIR, 'A-005.json'), JSON.stringify({ id: 'A-005', question: 'Old: which sign colour?', options: ['red', 'blue'], default: 'red', why: 'old', by: 'builder-t1', at: new Date(T0).toISOString(), deadline: null, protected: false, status: 'open' }));
const at3 = m.expireAsks(T0 + 3 * H);
const at4 = m.expireAsks(T0 + 4 * H + 1000);
const at7 = evs().filter((e) => e.type === 'ask.stale').length;
m.expireAsks(T0 + 7 * H);
const st7 = evs().filter((e) => e.type === 'ask.stale').length;
m.expireAsks(T0 + 8 * H + 1000);
m.expireAsks(T0 + 9 * H);
m.expireAsks(T0 + 100 * H);
const stale = evs().filter((e) => e.type === 'ask.stale');
const doc = (id) => JSON.parse(fs.readFileSync(path.join(m.ASKS_DIR, id + '.json'), 'utf8'));
const log = fs.readFileSync(path.join(process.cwd(), 'studio', 'decisions', 'decided-without-you.md'), 'utf8');
const timeouts = evs().filter((e) => e.type === 'decision.timeout').map((e) => ({ ask: e.meta?.ask, from: e.meta?.deadlineFrom || null }));
console.log(JSON.stringify({ withDef: { deadline: withDef.deadline, from: withDef.deadlineFrom }, short: short.deadline, noDef: noDef.deadline, owner: { deadline: owner.deadline, ownerOnly: owner.ownerOnly }, at3, at4, at7, st7, stale: stale.map((e) => ({ ask: e.meta?.ask, cmd: e.meta?.cmd, to: e.to, overseer: e.meta?.overseer })),
  s: { withDef: doc(withDef.id).status, noDef: doc(noDef.id).status, owner: doc(owner.id).status, old: doc('A-005').status, short: doc(short.id).status }, ans: doc(withDef.id).answer, inLog: [withDef.id, 'A-005'].every((x) => log.includes('## ' + x)), timeouts, ids: { withDef: withDef.id, noDef: noDef.id, owner: owner.id, short: short.id } }));`);
    const j = r;
    await guard('2.85 (c) every ask resolves: an ask with a --default and no --timeout gets STUDIO_ASK_TIMEOUT_H (4 h by default; 1 h when set), and at the deadline its default applies as an explicit timeout does (decision.timeout, studio/decisions/decided-without-you.md), not before; an ask made before 2.85 with a default and no deadline expires 4 h after it was asked (fails before this fix: it stayed open for good)', () => [
      j.withDef?.deadline === new Date(T0 + 4 * H).toISOString() && j.withDef.from === 'STUDIO_ASK_TIMEOUT_H' && j.short === new Date(T0 + H).toISOString()
        && Array.isArray(j.at3) && !j.at3.includes(j.ids.withDef) && j.at4.includes(j.ids.withDef) && j.at4.includes('A-005') && j.s.withDef === 'decided' && j.ans === 'gates' && j.s.old === 'decided' && j.inLog
        && j.timeouts.some((t) => t.ask === j.ids.withDef && t.from === null) && j.timeouts.some((t) => t.ask === 'A-005' && t.from === 'STUDIO_ASK_TIMEOUT_H'),
      JSON.stringify(j)]);
    await guard('2.85 (c) every ask resolves: an ask with no default is never answered by itself; at STUDIO_ASK_STALE_H (8 h) it is escalated once (ask.stale to the Producer, for the overseer, with the one command that answers it), not at 7 h and not again at 9 h or 100 h (fails before this fix: nothing ever said it was waiting)', () => [
      j.noDef === null && j.s?.noDef === 'open' && j.at7 === 0 && j.st7 === 0 && j.stale.length === 1 && j.stale[0].ask === j.ids.noDef && j.stale[0].to === 'producer' && j.stale[0].overseer === true && new RegExp(`npm run ask -- answer ${j.ids.noDef} `).test(j.stale[0].cmd || ''),
      JSON.stringify(j)]);
    await guard('2.85 (c) every ask resolves, the owner\'s own (guard): an owner-only ask ("is 8 dollars a car right?", nothing tying it to the game) gets no deadline from its default, is never decided by a timer and never escalated as stale, even 100 h later', () => [
      j.owner?.deadline === null && j.owner.ownerOnly === 'money' && j.s?.owner === 'open' && !j.stale.some((e) => e.ask === j.ids.owner) && !j.timeouts.some((t) => t.ask === j.ids.owner), JSON.stringify(j)]);
    // The deadline check runs with no person: the watcher's pass calls expireAsks and the supervisor's timed passes run it.
    const watch = fs.readFileSync(path.join(dir, 'harness', 'watch.mjs'), 'utf8');
    const passes = fs.readFileSync(path.join(dir, 'harness', 'studio-passes.mjs'), 'utf8');
    // `list --open` shows the age of an open ask.
    write(S, 'studio/asks/A-099.json', JSON.stringify({ id: 'A-099', question: 'Which shade of grey?', options: [], default: null, why: '', by: 'builder-t1', at: new Date(Date.now() - 9 * H - 60000).toISOString(), deadline: null, protected: false, status: 'open' }));
    const list = cli({}, ['harness/ask.mjs', 'list', '--open']);
    await guard('2.85 (c) every ask resolves: `npm run ask -- list --open` shows each open ask\'s age and marks the owner\'s own as waiting for the owner; the deadline check runs with no person (the watcher\'s pass calls expireAsks, run from the supervisor\'s timed passes) (fails before this fix: no age shown)', () => [
      /A-099 \[open\] Which shade of grey\? \(open 9 h\)/.test(out(list)) && /waiting for the owner/.test(out(list)) && /expireAsks\(now\)/.test(watch) && /watchPass/.test(passes), tail(list, 900)]);
  }

  // ---- 4. the refresh check decides by rule ----
  {
    const r = probe(`import fs from 'node:fs';
const m = await import(${u('harness/session-cap.mjs')});
const line = (i, ctx, cmd) => JSON.stringify({ type: 'assistant', message: { id: 'm' + i, usage: { input_tokens: 10, cache_read_input_tokens: ctx, cache_creation_input_tokens: 0 }, content: cmd ? [{ type: 'tool_use', name: 'Bash', input: { command: cmd } }] : [] } });
const log = (n, ctx, workAt = -1) => Array.from({ length: n }, (_, i) => line(i, i === n - 1 ? ctx : 1000, i === workAt ? 'git -c core.autocrlf=false commit -qm "T-1: panel"' : null)).join('\\n');
const evs = () => fs.readFileSync(process.env.AGENT_EVENTS_FILE, 'utf8').split('\\n').filter(Boolean).map((l) => JSON.parse(l));
const run = (agent, l, model, env = {}) => { const h = m.heartbeatCheck(agent, { log: l, model, task: 'T-1', role: 'builder', env: { ...process.env, ...env } }); const f = m.readFlag(agent); return { decided: h.decided || null, checks: (f.checks || []).map((c) => ({ by: c.by, decision: c.decision })), endedBy: f.endedBy || null, asks: evs().filter((e) => e.type === 'agent.ask' && e.msg.includes('Check ' + agent + ':')).length, dec: evs().filter((e) => e.type === 'agent.refresh.decided' && e.agent === agent).map((e) => e.meta) }; };
const under = run('rule-under', log(61, 100000, 50), 'claude-opus-5-5');
const over = run('rule-over', log(61, 138110, 50), 'claude-opus-5-5');
const idle = run('rule-idle', log(61, 50000), 'claude-opus-5-5');
const unknown = run('rule-unknown', log(61, 138110, 55), 'some-new-model');
const asked = run('ask-mode', log(61, 138110, 50), 'claude-opus-5-5', { STUDIO_REFRESH_DECIDE: 'ask' });
console.log(JSON.stringify({ under, over, idle, unknown, asked }));`);
    const j = r;
    await guard('2.85 (c) refresh, by rule: a session past its check point under STUDIO_REFRESH_HANDOFF_PCT (100k of a 200k window, a commit 11 turns ago) continues, recorded as a check by "rule" with agent.refresh.decided (decision, why, turns, tokens, pct) and no ask raised; with an unknown model the window is twice the refresh point (138k of 240k: continue) (fails before this fix: every check point raised a "Continue or hand off" ask to the Producer)', () => [
      j.under?.decided?.decision === 'continue' && j.under.asks === 0 && j.under.checks.length === 1 && j.under.checks[0].by === 'rule' && j.under.checks[0].decision === 'continue' && !j.under.endedBy
        && j.under.dec.length === 1 && j.under.dec[0].decision === 'continue' && j.under.dec[0].turns === 61 && j.under.dec[0].tokens === 100010 && j.under.dec[0].pct === 50 && typeof j.under.dec[0].why === 'string'
        && j.unknown?.decided?.decision === 'continue' && j.unknown.dec[0]?.window === 240000 && j.unknown.asks === 0,
      JSON.stringify(j).slice(0, 3000)]);
    await guard('2.85 (c) refresh, by rule: over 60 % of the model\'s window (138k of 200k) the session hands off, and with no commit and no verify in 61 turns (STUDIO_REFRESH_IDLE_TURNS 40) it hands off too: each recorded as a hand-off check by "rule" with endedBy set (the launcher ends it as a refresh), no ask (fails before this fix: a card waited for a person, 4 of 45 never answered)', () => [
      j.over?.decided?.decision === 'handoff' && /60 %/.test(j.over.decided.why) && j.over.asks === 0 && j.over.checks[0]?.by === 'rule' && j.over.checks[0].decision === 'handoff' && /by the rule/.test(j.over.endedBy || '')
        && j.idle?.decided?.decision === 'handoff' && /no commit and no verify/.test(j.idle.decided.why) && j.idle.asks === 0 && j.idle.endedBy,
      JSON.stringify(j).slice(0, 3000)]);
    await guard('2.85 (c) refresh, ask mode (guard): with STUDIO_REFRESH_DECIDE=ask the check point raises the "Continue or hand off" ask as before and decides nothing itself', () => [
      j.asked?.asks === 1 && !j.asked.decided && j.asked.checks.length === 0 && j.asked.dec.length === 0 && !j.asked.endedBy, JSON.stringify(j.asked)]);
    const agent = fs.readFileSync(path.join(dir, 'harness', 'agent.mjs'), 'utf8');
    await guard('2.85 (c) refresh, by rule: the launcher ends a session the rule handed off as a refresh (kind "refresh"), as a person\'s `session -- check <agent> handoff` would', () => [
      /progress\?\.decided\?\.decision === 'handoff'[\s\S]{0,200}kind: 'refresh'[\s\S]{0,120}stopChild\(child\)/.test(agent), 'agent.mjs does not act on progress.decided']);
  }
  try { fs.rmSync(S, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* the sweep removes it */ }
}
