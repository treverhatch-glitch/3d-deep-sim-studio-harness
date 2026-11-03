/**
 * harness/divergence.mjs — 2.72.0 (a): where a red golden first went wrong.
 *
 * A red golden said only "hash differs": the agent then bisected by hand (or re-recorded). On a red (never in a routine
 * run: per-tick hashing of the whole state roughly doubles a run), the harness now re-runs the golden twice in lockstep,
 * on this tree and on a reference tree, with a cheap per-subsystem digest per tick (FNV-1a of each top-level state key's
 * canonical JSON), stops at the first tick where a digest differs and names the first field that differs there:
 *
 *   [golden] first divergence: tick 23, resources.credits 101 -> 102 (subsystem resources; example-1337.json vs 3f2a1b4c, ...)
 *   [golden] divergence-json {"file":"example-1337.json","tick":23,"subsystem":"resources","field":"resources.credits",...}
 *
 * The reference is the commit that last changed the golden file (it recorded the hash; STUDIO_DIVERGENCE_REF names
 * another). Its cartridge folder is read with `git show` into a temp folder and loaded with loadCartridge({ dir }). The
 * reference is then run to its end: when its sha256 is not the golden's, the line says the reference does not
 * reproduce the golden (the divergence is against that commit, not the recording). It LOCATES a bug; the golden check
 * still decides red or green. STUDIO_GOLDEN_DIVERGENCE=off turns it off.
 *
 * Generic contract for a studio game (not a cartridge): its studio.gates.json may declare
 *   "divergence": { "command": "<prints per-tick digests as JSON lines>", "gate": "<check id, default: any id with
 *                   'golden'>", "state": "<optional: prints the state at {tick} of {run} as one JSON object>",
 *                   "goldens": ["<paths whose last commit is the reference>"] }
 * Each line the command prints: { "run": "<name, optional>", "tick": <n>, "digests": { "<subsystem>": "<hash>" },
 * "fields": { "<subsystem>": { ...values, optional } } }. When that check fails, the harness runs the command on this
 * tree and on the reference commit (a detached git worktree in the temp folder, node_modules linked), compares the
 * lines and prints the same two lines (prefix [game-gates]). The harness does the comparison; the game only prints.
 * Results are events (golden.divergence) and are read back from a log by divergenceFromLog (hand-back facts, gates.run).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const divergenceOn = (env = process.env) => !/^(off|0|false|no)$/i.test(String(env.STUDIO_GOLDEN_DIVERGENCE || '').trim());

/** Canonical JSON: object keys sorted, so a digest never depends on insertion order. */
export function canonical(v) {
  if (v === undefined) return 'null';
  if (v === null || typeof v !== 'object') return typeof v === 'number' && !Number.isFinite(v) ? JSON.stringify(String(v)) : JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
}

/** FNV-1a 32-bit of a string, 8 hex. Cheap; a red re-run only. */
export function digestOf(value) {
  const s = typeof value === 'string' ? value : canonical(value);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h.toString(16).padStart(8, '0');
}

/** One digest per subsystem (top-level key of the state); a non-object state is one subsystem, "state". */
export function stateDigests(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return { state: digestOf(state) };
  const out = {};
  for (const k of Object.keys(state).sort()) out[k] = digestOf(state[k]);
  return out;
}

/** The subsystems whose digests differ, in key order. */
export function differingKeys(a = {}, b = {}) {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].sort().filter((k) => a[k] !== b[k]);
}

/** The first path where two values differ: { path, from, to } or null ("a.b[3].x"). */
export function firstFieldDiff(a, b, at = '') {
  if (canonical(a) === canonical(b)) return null;
  const bothObj = a && b && typeof a === 'object' && typeof b === 'object' && Array.isArray(a) === Array.isArray(b);
  if (!bothObj) return { path: at || '(state)', from: a, to: b };
  if (Array.isArray(a)) {
    for (let i = 0; i < Math.max(a.length, b.length); i++) { const d = firstFieldDiff(a[i], b[i], `${at}[${i}]`); if (d) return d; }
    return { path: `${at}.length`, from: a.length, to: b.length };
  }
  // The state's own key order (a reader expects the field the code writes first), then keys only the other side has.
  for (const k of [...new Set([...Object.keys(a), ...Object.keys(b)])]) {
    const d = firstFieldDiff(a[k], b[k], at ? `${at}.${k}` : k);
    if (d) return d;
  }
  return null;
}

const show = (v) => { const t = v === undefined ? 'undefined' : JSON.stringify(v); return t.length > 60 ? `${t.slice(0, 57)}...` : t; };

/**
 * Step two copies of a golden run in lockstep (the reference cartridge and this tree's), digest every tick, stop at the
 * first difference. spec: the golden ({ seed, tick, actions } or { scenario, seed }). Returns
 * { found, tick, subsystems, field, from, to, refTicks, curTicks, refEnd } where refEnd is the reference's final
 * sha256 (it runs on to its end so we can say whether it reproduces the golden).
 */
export function lockstep(refCart, curCart, spec, { groupActions }) {
  const sc = spec.scenario ? { ref: refCart.scenarios?.[spec.scenario], cur: curCart.scenarios?.[spec.scenario] } : null;
  if (sc && (!sc.ref || !sc.cur)) return { error: `the scenario "${spec.scenario}" is missing from the ${!sc.ref ? 'reference' : 'current'} cartridge` };
  const seed = spec.scenario ? spec.seed ?? sc.cur.seed ?? 1 : spec.seed ?? 1;
  const ticks = spec.scenario ? sc.cur.maxTicks ?? 1000 : spec.tick ?? 100;
  const mk = (cart, s) => ({ cart, sc: s, state: cart.init(seed, spec.tuning), scripted: groupActions(s ? s.actions || [] : spec.actions || []), done: false, ticks: 0, err: null });
  const A = mk(refCart, sc?.ref);
  const B = mk(curCart, sc?.cur);
  const stepOne = (x, t) => {
    if (x.done) return;
    const acts = [...(x.scripted.get(t) || [])];
    if (x.sc && typeof x.sc.policy === 'function') { const extra = x.sc.policy(x.state, t); if (extra) acts.push(...(Array.isArray(extra) ? extra : [extra])); }
    try { x.state = x.cart.step(x.state, spec.scenario ? acts : acts.length ? acts : null); } catch (e) { x.err = String(e?.message || e); x.done = true; return; }
    x.ticks = t;
    if (x.cart.invariants(x.state).length) x.done = true;
    else if (x.sc && x.cart.outcome(x.state)) x.done = true;
  };
  for (let t = 1; t <= ticks; t++) {
    if (A.done && B.done) break;
    stepOne(A, t);
    stepOne(B, t);
    const da = stateDigests(A.state);
    const db = stateDigests(B.state);
    const keys = differingKeys(da, db);
    if (keys.length || A.done !== B.done) {
      const k = keys[0];
      const d = k ? firstFieldDiff(A.state?.[k], B.state?.[k], k) : null;
      for (let u = t + 1; u <= ticks && !A.done; u++) stepOne(A, u);
      return { found: true, tick: t, subsystems: keys, field: d?.path || null, from: d?.from, to: d?.to, ...(A.done !== B.done && !keys.length ? { ended: A.done ? 'reference' : 'current' } : {}), refTicks: A.ticks, curTicks: B.ticks, refEnd: A.err ? null : refCart.sha256(A.state), ...(B.err ? { threw: B.err } : {}) };
    }
  }
  return { found: false, refTicks: A.ticks, curTicks: B.ticks, refEnd: A.err ? null : refCart.sha256(A.state) };
}

const git = (cwd, args, opts = {}) => spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, windowsHide: true, ...opts });

/** The reference commit for a golden file: STUDIO_DIVERGENCE_REF, else the last commit that changed it. { ref, why } or { error }. */
export function goldenReference(root, rels, env = process.env) {
  const given = String(env.STUDIO_DIVERGENCE_REF || '').trim();
  if (given) {
    const r = git(root, ['rev-parse', '--verify', '--quiet', `${given}^{commit}`]);
    return r.status === 0 ? { ref: r.stdout.trim(), why: `STUDIO_DIVERGENCE_REF ${given}` } : { error: `STUDIO_DIVERGENCE_REF ${given} is not a commit here` };
  }
  const list = (Array.isArray(rels) ? rels : [rels]).filter(Boolean);
  const r = git(root, ['log', '-1', '--format=%H', '--', ...list]);
  const ref = r.status === 0 ? r.stdout.trim() : '';
  return ref ? { ref, why: 'the commit that recorded it' } : { error: `no commit has ${list.join(', ')} (a new, uncommitted golden, or not a git checkout: no reference to compare with)` };
}

/** Write a folder of a commit (`git show` per file, binary-safe) under `dest`. Returns the number of files. */
export function materialize(root, ref, rel, dest) {
  const ls = git(root, ['ls-tree', '-r', '-z', '--name-only', ref, '--', rel]);
  if (ls.status !== 0) throw new Error(`git ls-tree ${ref.slice(0, 8)} ${rel}: ${String(ls.stderr).trim().slice(0, 200)}`);
  const files = ls.stdout.split('\0').filter(Boolean);
  for (const f of files) {
    const b = spawnSync('git', ['show', `${ref}:${f}`], { cwd: root, maxBuffer: 256 * 1024 * 1024, windowsHide: true });
    if (b.status !== 0) throw new Error(`git show ${ref.slice(0, 8)}:${f} failed`);
    const out = path.join(dest, ...f.split('/'));
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, b.stdout);
  }
  return files.length;
}

/** The two printed lines for a result: the human one and the JSON one. */
export function divergenceLines(prefix, r) {
  if (!r) return [];
  if (r.error) return [`${prefix} first divergence: not found (${r.error})`];
  const where = `${[r.file, r.gate, r.run ? `run ${r.run}` : null].filter(Boolean).join(', ') || '?'} vs ${String(r.ref || '?').slice(0, 8)}${r.refWhy ? `, ${r.refWhy}` : ''}`;
  if (!r.found) return [`${prefix} first divergence: none: the run matches ${where} tick for tick${r.reproduces === false ? ', and neither produces the golden\'s hash: the golden file was changed by hand or recorded from other code' : ''}`];
  const what = r.field ? `${r.field} ${show(r.from)} -> ${show(r.to)}` : r.ended ? `the ${r.ended} run ended here and the other did not` : r.subsystems?.length ? `${r.subsystems.join(', ')} differ` : 'the state differs';
  const json = { file: r.file || null, run: r.run || null, gate: r.gate || null, tick: r.tick, subsystem: r.subsystems?.[0] || null, subsystems: r.subsystems || [], field: r.field || null, from: show(r.from), to: show(r.to), ref: r.ref || null, reproduces: r.reproduces ?? null, ms: r.ms ?? null };
  return [
    `${prefix} first divergence: tick ${r.tick}, ${what} (subsystem ${r.subsystems?.[0] || '?'}${r.subsystems?.length > 1 ? `, also ${r.subsystems.slice(1, 4).join(', ')}` : ''}; ${where}${r.reproduces === false ? '; NOTE that commit does not reproduce the golden, so this is the first difference from it, not from the recording' : ''}${r.threw ? `; this tree's run threw: ${String(r.threw).slice(0, 120)}` : ''})`,
    `${prefix} divergence-json ${JSON.stringify(json)}`,
  ];
}

/** The divergences a log names (its divergence-json lines), newest last. */
export function divergenceFromLog(text) {
  const out = [];
  for (const l of String(text || '').split(/\r?\n/)) {
    const m = l.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '').match(/^\s*(?:\|\s*)?\[[\w-]+\] divergence-json (\{.*\})\s*$/);
    if (m) { try { out.push(JSON.parse(m[1])); } catch {} }
  }
  return out;
}

/** "tick 23, resources.credits 101 -> 102 (subsystem resources)" for a facts line or an event message. */
export const divergenceText = (d) => (d ? `tick ${d.tick}, ${d.field ? `${d.field} ${d.from} -> ${d.to}` : (d.subsystems || []).join(', ') || 'state'} (subsystem ${d.subsystem || '?'}${d.file || d.run ? `; ${d.file || d.run}` : ''})` : '');

function emit(r, extra = {}) {
  return import('./event.mjs').then(({ emitEvent }) => {
    try { emitEvent({ type: 'golden.divergence', agent: process.env.STUDIO_LOCK_OWNER || 'gates', status: 'warn', msg: `first divergence${r.file ? ` in ${r.file}` : ''}: ${divergenceText({ ...r, subsystem: r.subsystems?.[0] })}`.slice(0, 400), meta: { file: r.file || null, run: r.run || null, gate: r.gate || null, tick: r.tick, subsystem: r.subsystems?.[0] || null, subsystems: r.subsystems || [], field: r.field || null, ref: r.ref || null, reproduces: r.reproduces ?? null, ...extra } }); } catch {}
  }).catch(() => {});
}

/**
 * A cartridge golden (qa/check-golden.mjs) that is red on its sha256: { found, tick, subsystems, field, from, to, ref,
 * reproduces, file, ms } or { error }. opts: { root, file (the golden's file name), rel (its repo path), spec, cart (this
 * tree's), env }.
 */
export async function goldenDivergence({ root, file, rel, spec, cart, env = process.env }) {
  const t0 = Date.now();
  const ref = goldenReference(root, rel, env);
  if (ref.error) return { file, error: ref.error };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-div-'));
  try {
    const crel = `cartridges/${cart.name}`;
    const n = materialize(root, ref.ref, crel, tmp);
    if (!n) return { file, ref: ref.ref, error: `the reference ${ref.ref.slice(0, 8)} has no ${crel}` };
    const { loadCartridge, groupActions } = await import('./cartridge.mjs');
    let refCart;
    try { refCart = await loadCartridge(cart.name, { dir: path.join(tmp, ...crel.split('/')) }); } catch (e) { return { file, ref: ref.ref, error: `the reference's cartridge didn't load (${String(e.message).slice(0, 160)}; a cartridge that imports files outside its folder can't be compared this way)` }; }
    const r = lockstep(refCart, cart, spec, { groupActions });
    if (r.error) return { file, ref: ref.ref, error: r.error };
    const res = { file, ref: ref.ref, refWhy: ref.why, ...r, reproduces: r.refEnd ? r.refEnd === spec.sha256 : null, ms: Date.now() - t0 };
    if (res.found) await emit(res);
    return res;
  } catch (e) {
    return { file, error: String(e.message || e).slice(0, 200) };
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

/** Per-tick digest lines (the generic contract), grouped by run: Map(run -> [{ tick, digests, fields }]) in order. */
export function parseTrace(text) {
  const runs = new Map();
  for (const l of String(text || '').split(/\r?\n/)) {
    const t = l.trim();
    if (!t.startsWith('{')) continue;
    let j;
    try { j = JSON.parse(t); } catch { continue; }
    if (!j || !Number.isFinite(Number(j.tick)) || !j.digests || typeof j.digests !== 'object') continue;
    const run = String(j.run ?? '');
    if (!runs.has(run)) runs.set(run, []);
    runs.get(run).push({ tick: Number(j.tick), digests: j.digests, fields: j.fields && typeof j.fields === 'object' ? j.fields : null });
  }
  return runs;
}

/** Compare two traces: the first run and tick where a subsystem digest differs (or one run stops early), or { found: false }. */
export function compareTraces(refText, curText) {
  const A = parseTrace(refText);
  const B = parseTrace(curText);
  if (!B.size) return { error: 'this tree\'s divergence command printed no digest lines ({ "tick", "digests" } JSON lines)' };
  if (!A.size) return { error: 'the reference\'s divergence command printed no digest lines' };
  for (const [run, cur] of B) {
    const ref = A.get(run) || [];
    const byTick = new Map(ref.map((x) => [x.tick, x]));
    for (const c of cur) {
      const a = byTick.get(c.tick);
      if (!a) return { found: true, run: run || null, tick: c.tick, subsystems: [], ended: 'reference' };
      const keys = differingKeys(a.digests, c.digests);
      if (keys.length) {
        const k = keys[0];
        const d = a.fields?.[k] !== undefined || c.fields?.[k] !== undefined ? firstFieldDiff(a.fields?.[k], c.fields?.[k], k) : null;
        return { found: true, run: run || null, tick: c.tick, subsystems: keys, field: d?.path || null, from: d?.from, to: d?.to };
      }
    }
    if (ref.length > cur.length) return { found: true, run: run || null, tick: ref[cur.length].tick, subsystems: [], ended: 'current' };
  }
  return { found: false };
}

const runIn = (cwd, cmd, env, timeout) => spawnSync(cmd, { cwd, shell: true, encoding: 'utf8', env, timeout, maxBuffer: 256 * 1024 * 1024, windowsHide: true });

/** Link a node_modules folder into the reference tree (a junction on Windows: no admin rights needed). */
function linkModules(fromDir, toDir) {
  const src = path.join(fromDir, 'node_modules');
  const dst = path.join(toDir, 'node_modules');
  if (!fs.existsSync(src) || fs.existsSync(dst)) return;
  try { fs.mkdirSync(toDir, { recursive: true }); fs.symlinkSync(src, dst, process.platform === 'win32' ? 'junction' : 'dir'); } catch {}
}

/** The reference commit for a game's divergence: STUDIO_DIVERGENCE_REF, the last commit of its "goldens", else the merge base with main. */
export function gameReference(root, conf, env = process.env) {
  if (String(env.STUDIO_DIVERGENCE_REF || '').trim() || (Array.isArray(conf.goldens) && conf.goldens.length)) {
    const r = goldenReference(root, Array.isArray(conf.goldens) ? conf.goldens.map(String) : [], env);
    if (!r.error || String(env.STUDIO_DIVERGENCE_REF || '').trim()) return r;
  }
  const head = git(root, ['rev-parse', 'HEAD']).stdout.trim();
  for (const b of ['main', 'master']) {
    const mb = git(root, ['merge-base', 'HEAD', `refs/heads/${b}`]);
    const ref = mb.status === 0 ? mb.stdout.trim() : '';
    if (ref && ref !== head) return { ref, why: `the merge base with ${b}` };
  }
  return head ? { ref: head, why: 'HEAD (this tree\'s uncommitted changes against it)' } : { error: 'no commit to compare with' };
}

/**
 * The generic contract: a game check that failed and whose manifest declares "divergence". Runs the command on this
 * tree and on the reference commit (a detached worktree in the temp folder) and compares. Returns the result (with
 * { gate }) or { error }. Never throws.
 */
export async function gameDivergence({ root, game, conf, gate, env = process.env, timeoutMs = Number(env.STUDIO_DIVERGENCE_TIMEOUT_MS || 600000) }) {
  const t0 = Date.now();
  if (!conf || typeof conf.command !== 'string' || !conf.command.trim()) return { gate, error: 'the manifest\'s "divergence" has no "command"' };
  const ref = gameReference(root, conf, env);
  if (ref.error) return { gate, error: ref.error };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-divref-'));
  const wt = path.join(tmp, 'ref');
  const runEnv = { ...env, STUDIO_DIVERGENCE: 'trace' };
  try {
    const add = git(root, ['worktree', 'add', '--detach', '--quiet', wt, ref.ref]);
    if (add.status !== 0) return { gate, ref: ref.ref, error: `couldn't check out the reference ${ref.ref.slice(0, 8)} (git worktree add: ${String(add.stderr).trim().slice(0, 160)})` };
    linkModules(root, wt);
    if (game?.root) linkModules(path.join(root, game.root), path.join(wt, game.root));
    const cur = runIn(root, conf.command, runEnv, timeoutMs);
    const old = runIn(wt, conf.command, runEnv, timeoutMs);
    const r = compareTraces(old.stdout, cur.stdout);
    if (r.error) return { gate, ref: ref.ref, error: r.error };
    let res = { gate, ref: ref.ref, refWhy: ref.why, ...r, ms: Date.now() - t0 };
    // Optional: the whole state at that tick from both trees, to name the field ("state": "... {tick} {run}").
    if (res.found && !res.field && res.subsystems?.length && typeof conf.state === 'string' && conf.state.includes('{tick}')) {
      const cmd = conf.state.split('{tick}').join(String(res.tick)).split('{run}').join(String(res.run || ''));
      const sj = (x) => { try { return JSON.parse(String(x.stdout || '').trim().split(/\r?\n/).filter((l) => l.trim().startsWith('{')).pop()); } catch { return null; } };
      const a = sj(runIn(wt, cmd, runEnv, timeoutMs));
      const b = sj(runIn(root, cmd, runEnv, timeoutMs));
      const k = res.subsystems[0];
      const d = a && b ? firstFieldDiff(a[k], b[k], k) : null;
      if (d) res = { ...res, field: d.path, from: d.from, to: d.to };
    }
    if (res.found) await emit(res, { game: game?.name || null });
    return res;
  } catch (e) {
    return { gate, error: String(e.message || e).slice(0, 200) };
  } finally {
    try { git(root, ['worktree', 'remove', '--force', wt]); } catch {}
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    try { git(root, ['worktree', 'prune']); } catch {}
  }
}
