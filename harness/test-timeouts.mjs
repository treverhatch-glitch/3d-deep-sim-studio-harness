/**
 * harness/test-timeouts.mjs — 2.73.2 (d, B-71): per-test timeouts that fit the number of test workers.
 *
 * 2.68.0 sizes a game's test workers to the machine (heavy-budget.mjs testWorkers: 25 on a 28-thread box), but the game's
 * test config keeps the per-test timeout it was tuned with on a quiet run (a 15 s vitest testTimeout). With that many
 * workers every test runs slower (shared cores, efficiency cores, a lower all-core clock), so heavy tests failed on time
 * alone: false reds, main red. So when game-gates runs a check whose command clearly runs vitest, jest or node --test
 * (directly, or as the last step of the npm script it calls), it passes the runner a per-test timeout scaled for the load:
 *
 *   factor = ceil(4 x workers / logical cores), between 1 and 4      (workerFactor)
 *
 * 2.76.0 (j, B-89): "workers" there is every check's test workers on the machine (this check's share plus the others'
 * running now: heavy-budget.mjs testWorkers machineWorkers), so sharing the cores never shortens a timeout.
 *
 * A test's timeout is taken as fitting a box at a quarter load or less (one worker per four logical cores, about one per
 * physical core with room to spare); at full load a CPU-bound test takes up to about 4 x as long. (Measured on a
 * 28-thread box: a game's 15 s testTimeout went red at 25 workers and was raised to 60 s, x4, by hand.) The factor used is
 * the largest of that, the gate's own load factor (heavy.mjs loadFactor) and the manifest's slowTests minScale.
 * STUDIO_TEST_TIMEOUT_SCALE=<n> (>= 1) replaces the worker-derived factor; =off passes nothing (the game's own timeouts).
 *
 *   vitest   --testTimeout=<base x factor> --hookTimeout=<hook base x factor>
 *   jest     --testTimeout=<base x factor>
 *   node     --test-timeout=<base x factor>, only when the command sets one (node --test has no per-test timeout by default)
 *
 * The base is read from the game's config (vitest.config.* / vite.config.*, found upward from the command's folder as
 * vitest does, or the --config the command names; jest.config.* or package.json "jest"): the largest number literal
 * given for testTimeout (hookTimeout). None given: the runner's default (vitest 5 s / 10 s, jest 5 s). A timeout the
 * harness can't read as a number (an expression, a workspace or projects config, a flag already in the npm script) is
 * left alone, saying why: the result is never below what the game set. Only a runtime flag: no file changes, the test's
 * assertions are the same (the weakened-tests gate reads diffs, so it has nothing to flag), and the check's row records
 * it ("testTimeout": { ms, baseMs, factor, why, flags }) for a reviewer.
 * Node built-ins only.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const MAX_WORKER_FACTOR = 4;
export const RUNNER_DEFAULTS = {
  vitest: { testMs: 5000, hookMs: 10000 },
  jest: { testMs: 5000, hookMs: null },
  'node --test': { testMs: Infinity, hookMs: null },
};
const off = (v) => /^(off|0|false|no)$/i.test(String(v ?? '').trim());
const segs = (cmd) => String(cmd || '').split(/&&|\|\||;/);
const toks = (s) => String(s || '').trim().split(/\s+/).filter(Boolean).map((t) => t.replace(/^["']|["']$/g, ''));
const base = (t) => t.replace(/\\/g, '/').split('/').pop().replace(/\.(c?m?js|cmd|exe|ps1)$/i, '').toLowerCase();

/** The runner a command segment clearly runs: 'vitest' | 'jest' | 'node --test' | null (harness/train-focus.mjs's rule). */
export function runnerOf(segment) {
  const s = String(segment || '').trim();
  if (!s || /[|<>]/.test(s)) return null;
  const t = toks(s);
  if (t.some((x) => base(x) === 'vitest')) return 'vitest';
  if (t.some((x) => base(x) === 'jest')) return 'jest';
  if (t.length && base(t[0]) === 'node' && t.includes('--test')) return 'node --test';
  return null;
}

/** The worker-derived factor: ceil(4 x workers / cores), 1..4; 1 worker (or fewer) is 1. */
export function workerFactor(workers, cores) {
  const w = Number(workers);
  const c = Math.max(1, Number(cores) || 1);
  if (!(w > 1)) return 1;
  return Math.min(MAX_WORKER_FACTOR, Math.max(1, Math.ceil((4 * w) / c)));
}

/**
 * What a check's command runs: { runner, cwd, text, via, npm } or { why }. `text` is the runner's own command text
 * (the command's last step, or the npm script's); `npm` is true when the flags go through `npm run <script> --`.
 */
export function resolveRunner(command, root) {
  const parts = segs(command);
  const last = parts[parts.length - 1].trim();
  // The folder the last step runs in: the command's plain `cd <dir>` steps, from the repo root.
  let cwd = root;
  for (const p of parts.slice(0, -1)) {
    const m = p.trim().match(/^cd\s+(?:\/d\s+)?("[^"]+"|'[^']+'|\S+)$/i);
    if (m) cwd = path.resolve(cwd, m[1].replace(/^["']|["']$/g, ''));
  }
  const direct = runnerOf(last);
  if (direct) return { runner: direct, cwd, text: last, via: 'its command', npm: false };
  const m = last.match(/^npm(?:\.cmd)?\s+(?:(?:run(?:-script)?)\s+([\w:.-]+)|(test|t))\b/);
  if (!m) {
    if (/^(pnpm|yarn)(\.cmd)?\s/.test(last)) return { why: 'it runs a pnpm or yarn script (flags are passed through npm scripts only)' };
    return { why: 'its command doesn\'t clearly run vitest, jest or node --test (directly or as the last step of an npm script)' };
  }
  const name = m[1] || 'test';
  let scripts = null;
  try { scripts = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8')).scripts || {}; } catch {}
  const script = scripts?.[name];
  if (typeof script !== 'string') return { why: `npm script "${name}" wasn't found in ${path.relative(root, path.join(cwd, 'package.json')).replace(/\\/g, '/') || 'package.json'}` };
  const sp = segs(script);
  const runner = runnerOf(sp[sp.length - 1]);
  if (!runner) return { why: `npm script "${name}" (${script.slice(0, 80)}) doesn't run vitest, jest or node --test as its last step` };
  return { runner, cwd, text: sp[sp.length - 1].trim(), via: `npm script "${name}"`, npm: true };
}

const CONFIG_EXT = ['ts', 'mts', 'cts', 'js', 'mjs', 'cjs'];
function findUp(names, from, stop) {
  let d = from;
  for (;;) {
    for (const n of names) { const f = path.join(d, n); if (fs.existsSync(f)) return f; }
    const up = path.dirname(d);
    if (d === stop || up === d || !path.resolve(d).startsWith(path.resolve(stop))) return null;
    d = up;
  }
}
/** A config flag's value in a runner's command text (-c x, --config x, --config=x). */
function configFlag(text) {
  const t = toks(text);
  for (let i = 0; i < t.length; i += 1) {
    if (t[i] === '-c' || t[i] === '--config') return t[i + 1] || null;
    if (t[i].startsWith('--config=')) return t[i].slice(9);
  }
  return null;
}
/** A literal number of milliseconds (15000, 15_000, 15 * 1000, 60e3), or null. */
export function literalMs(v) {
  const s = String(v || '').trim().replace(/_/g, '');
  if (/^\d+(\.\d+)?(e\d+)?$/i.test(s)) return Number(s);
  const m = s.match(/^(\d+(?:\.\d+)?)\s*\*\s*(\d+(?:\.\d+)?)$/);
  return m ? Number(m[1]) * Number(m[2]) : null;
}
/**
 * The values a config text gives `key`: { ms: the largest literal, or null when none is given } or { why } when one isn't a
 * number literal (it can't be read, so nothing is passed for it).
 */
export function keyFromText(text, key) {
  const re = new RegExp(`["']?\\b${key}\\b["']?\\s*:\\s*([^,}\\n]+)`, 'g');
  let best = null;
  for (const m of String(text || '').matchAll(re)) {
    const v = literalMs(m[1].replace(/\/\/.*$/, '').trim());
    if (v === null) return { why: `its ${key} isn't a number literal (${m[1].trim().slice(0, 60)})` };
    best = best === null ? v : Math.max(best, v);
  }
  return { ms: best };
}

/** The game's own timeouts for this runner: { testMs, hookMs, from, why? } (why: the test timeout can't be read). */
export function gameTimeouts(r, root) {
  const d = RUNNER_DEFAULTS[r.runner];
  const rel = (f) => path.relative(root, f).replace(/\\/g, '/');
  if (r.runner === 'node --test') {
    const m = r.text.match(/--test-timeout[= ](\d+)/);
    return m ? { testMs: Number(m[1]), hookMs: null, from: 'its --test-timeout' } : { testMs: Infinity, hookMs: null, from: 'node --test\'s default (none)' };
  }
  const flagged = r.text.match(/--testTimeout[= ](\S+)/);
  if (flagged && r.npm) return { why: `the npm script already passes --testTimeout (${flagged[1]})` };
  let file = null;
  const named = configFlag(r.text);
  if (named) {
    file = path.resolve(r.cwd, named);
    if (!fs.existsSync(file)) return { why: `the config it names (${named}) wasn't found` };
  } else if (r.runner === 'vitest') {
    if (findUp(CONFIG_EXT.flatMap((e) => [`vitest.workspace.${e}`, `vitest.projects.${e}`]).concat(['vitest.workspace.json']), r.cwd, root)) return { why: 'a vitest workspace: per-project timeouts can\'t be read' };
    file = findUp(CONFIG_EXT.map((e) => `vitest.config.${e}`), r.cwd, root) || findUp(CONFIG_EXT.map((e) => `vite.config.${e}`), r.cwd, root);
  } else {
    file = findUp([...CONFIG_EXT.map((e) => `jest.config.${e}`), 'jest.config.json'], r.cwd, root);
  }
  let text = '';
  let from = '';
  if (file) { try { text = fs.readFileSync(file, 'utf8'); from = rel(file); } catch { return { why: `${rel(file)} couldn't be read` }; } }
  else if (r.runner === 'jest') {
    try { const j = JSON.parse(fs.readFileSync(path.join(r.cwd, 'package.json'), 'utf8')).jest; if (j) { text = JSON.stringify(j); from = `${rel(path.join(r.cwd, 'package.json'))} "jest"`; } } catch {}
  }
  if (r.runner === 'vitest' && /\b(projects|workspace)\s*:/.test(text)) return { why: `${from} declares projects: per-project timeouts can't be read` };
  const t = flagged ? { ms: literalMs(flagged[1]) } : keyFromText(text, 'testTimeout');
  if (t.why || (flagged && t.ms === null)) return { why: t.why || `its --testTimeout isn't a number (${flagged[1]})` };
  const h = d.hookMs === null ? { ms: null } : keyFromText(text, 'hookTimeout');
  return {
    testMs: t.ms ?? d.testMs,
    hookMs: d.hookMs === null || h.why ? null : h.ms ?? d.hookMs,
    from: flagged ? 'its --testTimeout' : t.ms !== null ? from : `${r.runner}'s default${from ? ` (${from} sets none)` : ''}`,
    ...(h.why ? { hookWhy: h.why } : {}),
  };
}

const appendFlags = (cmd, r, flags) => {
  const c = String(cmd).trimEnd();
  if (!r.npm) return `${c} ${flags.join(' ')}`;
  return /\s--(\s|$)/.test(segs(c).pop()) ? `${c} ${flags.join(' ')}` : `${c} -- ${flags.join(' ')}`;
};

/**
 * The command to run a game check with, its per-test timeout scaled for the load: { command, info } where info is null
 * (not a test runner: nothing to say) or { runner, factor, why, applied, ms?, baseMs?, hookMs?, hookBaseMs?, flags? }.
 */
export function scaleTestTimeouts({ command, root, workers, machineWorkers = null, cores = null, gateFactor = 1, minScale = 1, env = process.env }) {
  const r = resolveRunner(command, root);
  if (!r.runner) return { command, info: null, skipped: r.why };
  const c = Math.max(1, Number(cores) || (os.availableParallelism ? os.availableParallelism() : os.cpus().length) || 1);
  if (off(env.STUDIO_TEST_TIMEOUT_SCALE)) return { command, info: { runner: r.runner, factor: 1, applied: false, why: 'STUDIO_TEST_TIMEOUT_SCALE=off: the game\'s own timeouts' } };
  const given = Number(env.STUDIO_TEST_TIMEOUT_SCALE);
  // 2.76.0 (j, B-89): with the cores shared between checks, the load a test sees is every check's workers on the machine
  // (machineWorkers: this check's plus the others' running now, heavy-budget.mjs testWorkers), not its own share.
  const mw = Number(machineWorkers) > Number(workers) ? Math.round(Number(machineWorkers)) : null;
  const load = mw || workers;
  const wf = String(env.STUDIO_TEST_TIMEOUT_SCALE ?? '').trim() && Number.isFinite(given) ? Math.max(1, given) : workerFactor(load, c);
  const parts = [String(env.STUDIO_TEST_TIMEOUT_SCALE ?? '').trim() && Number.isFinite(given) ? `STUDIO_TEST_TIMEOUT_SCALE=${given}` : mw ? `${mw} test workers on the machine (${workers} its own, ${mw - workers} in other checks) on ${c} logical core${c === 1 ? '' : 's'}: ceil(4 x ${mw} / ${c}), at most ${MAX_WORKER_FACTOR}` : `${workers} test worker${Number(workers) === 1 ? '' : 's'} on ${c} logical core${c === 1 ? '' : 's'}: ceil(4 x ${workers} / ${c}), at most ${MAX_WORKER_FACTOR}`];
  if (Number(gateFactor) > wf) parts.push(`the gate's load factor ${gateFactor}`);
  if (Number(minScale) > Math.max(wf, Number(gateFactor) || 1)) parts.push(`the manifest's slowTests minScale ${minScale}`);
  const factor = Math.round(Math.max(1, wf, Number(gateFactor) || 1, Number(minScale) || 1) * 10) / 10;
  const why = `x${factor} (${parts.join('; ')})`;
  if (factor <= 1) return { command, info: { runner: r.runner, factor: 1, applied: false, why: `${why}: the game's own timeouts` } };
  const g = gameTimeouts(r, root);
  if (g.why) return { command, info: { runner: r.runner, factor, applied: false, why: `${why}, not passed: ${g.why}` } };
  if (!Number.isFinite(g.testMs)) return { command, info: { runner: r.runner, factor, applied: false, why: `${why}, nothing to scale: ${g.from}` } };
  const ms = Math.max(g.testMs, Math.round(g.testMs * factor));
  const hookMs = g.hookMs ? Math.max(g.hookMs, Math.round(g.hookMs * factor)) : null;
  let next;
  let flags;
  if (r.runner === 'node --test') {
    flags = [`--test-timeout=${ms}`];
    next = command.replace(/--test-timeout[= ]\d+/, flags[0]);
  } else {
    flags = [`--testTimeout=${ms}`, ...(r.runner === 'vitest' && hookMs ? [`--hookTimeout=${hookMs}`] : [])];
    if (!r.npm && /--testTimeout[= ]\S+/.test(command)) {
      next = command.replace(/--testTimeout[= ]\S+/, flags[0]);
      if (flags[1]) next = /--hookTimeout[= ]\S+/.test(next) ? next.replace(/--hookTimeout[= ]\S+/, flags[1]) : appendFlags(next, r, [flags[1]]);
    } else if (!r.npm && flags[1] && /--hookTimeout[= ]\S+/.test(command)) {
      next = appendFlags(command, r, [flags[0]]); // a hook timeout the command sets itself stays
      flags = [flags[0]];
    } else next = appendFlags(command, r, flags);
  }
  return { command: next, info: { runner: r.runner, factor, applied: true, ms, baseMs: g.testMs, ...(hookMs ? { hookMs, hookBaseMs: g.hookMs } : {}), from: g.from, via: r.via, flags, why: `${why}; base ${Math.round(g.testMs / 100) / 10} s from ${g.from}${g.hookWhy ? `; hookTimeout left alone: ${g.hookWhy}` : ''}` } };
}

/** The gate's line for a check: "[game-gates] <id>: per-test timeout ...". */
export function timeoutLine(id, info) {
  if (!info) return '';
  if (!info.applied) return `[game-gates] ${id}: per-test timeout: the game's own (${info.runner}; ${info.why})`;
  return `[game-gates] ${id}: per-test timeout ${Math.round(info.ms / 100) / 10} s (${info.runner}, ${info.via}: ${info.flags.join(' ')}; ${info.why}; a runtime flag, the tests are unchanged; STUDIO_TEST_TIMEOUT_SCALE=off keeps the game's own)`;
}
