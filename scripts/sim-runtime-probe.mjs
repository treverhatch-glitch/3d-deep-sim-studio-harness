#!/usr/bin/env node
/**
 * scripts/sim-runtime-probe.mjs <cartridge> — run one cartridge with every source of nondeterminism trapped.
 *
 * Static scans miss aliases (`const r = Math.random`, `const D = Date; D.now()`, `globalThis['Ma'+'th']`).
 * This probe replaces those globals before the cartridge is imported, then plays a replay and every
 * scenario. Any touch is recorded and the probe exits 1. Called by scripts/check-sim-purity.mjs.
 *
 * 2.58.2 (PU-22): the engine-dependent Math functions (harness/det-math.mjs) are wrapped too, and each call
 * made from the cartridge's own files (not from its detMath module) is recorded with the line it came from,
 * however it was reached (an alias, a wrapper module, a computed key). The cartridge's detMath mode decides:
 * "required" fails, "warn" prints, "off" doesn't wrap. The wrapped functions still return the real result.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const probeName = process.argv[2];
const { cartridgeDetMath, isAllowedFile, INEXACT } = await import('../harness/det-math.mjs');
const { REPO_ROOT } = await import('../harness/event.mjs');
const det = /^[a-z0-9_][\w-]*$/i.test(probeName || '') ? cartridgeDetMath(probeName) : { mode: 'off' };
const detHits = new Map();
let detStacks = 0;
if (det.mode !== 'off') {
  let cartDir = path.join(REPO_ROOT, 'cartridges', probeName);
  try { cartDir = fs.realpathSync(cartDir); } catch { /* not there: loadCartridge says so */ }
  const realRoot = (() => { try { return fs.realpathSync(REPO_ROOT); } catch { return REPO_ROOT; } })();
  const simCaller = (fnRef) => {
    const prep = Error.prepareStackTrace;
    const limit = Error.stackTraceLimit;
    Error.prepareStackTrace = (_, sites) => sites;
    Error.stackTraceLimit = 60;
    const holder = {};
    Error.captureStackTrace(holder, fnRef);
    const sites = holder.stack;
    Error.prepareStackTrace = prep;
    Error.stackTraceLimit = limit;
    for (const site of Array.isArray(sites) ? sites : []) {
      let f = site.getFileName?.();
      if (!f) continue;
      if (f.startsWith('file:')) f = fileURLToPath(f);
      if (isAllowedFile(f, det, realRoot) || isAllowedFile(f, det, REPO_ROOT)) return null;
      if (f === cartDir || f.startsWith(cartDir + path.sep)) return `${path.relative(realRoot, f).split(path.sep).join('/')}:${site.getLineNumber()}`;
    }
    return null;
  };
  for (const fn of INEXACT) {
    const real = Math[fn];
    const wrapped = function (...args) {
      if (detStacks < 5000) {
        detStacks += 1;
        const at = simCaller(wrapped);
        if (at) detHits.set(`${at} Math.${fn}`, (detHits.get(`${at} Math.${fn}`) || 0) + 1);
      }
      return real.apply(Math, args);
    };
    Object.defineProperty(Math, fn, { value: wrapped, writable: true, configurable: true, enumerable: false });
  }
}

const touched = new Set();
const trap = (name) =>
  function trapped() {
    touched.add(name);
    throw new Error(`sim purity: ${name} is not allowed inside a cartridge`);
  };

const RealDate = Date;
function FakeDate() {
  touched.add('Date()');
  throw new Error('sim purity: Date is not allowed inside a cartridge');
}
FakeDate.now = trap('Date.now');
FakeDate.parse = RealDate.parse; // parsing a fixed string is deterministic
FakeDate.UTC = RealDate.UTC;

Math.random = trap('Math.random');
globalThis.Date = FakeDate;
for (const name of ['setTimeout', 'setInterval', 'setImmediate']) globalThis[name] = trap(name);
if (globalThis.performance) {
  Object.defineProperty(globalThis, 'performance', { value: { now: trap('performance.now') }, configurable: true });
}
if (globalThis.crypto) {
  Object.defineProperty(globalThis, 'crypto', {
    value: { getRandomValues: trap('crypto.getRandomValues'), randomUUID: trap('crypto.randomUUID'), subtle: undefined },
    configurable: true,
  });
}
// The Function constructors build code from strings; reaching them through any function's
// prototype (`(() => {}).constructor('…')`) would get around every trap above.
for (const fn of [function () {}, async function () {}, function* () {}, async function* () {}]) {
  Object.defineProperty(Object.getPrototypeOf(fn), 'constructor', { value: trap('Function constructor'), configurable: true, writable: true });
}
process.hrtime = trap('process.hrtime');
process.hrtime.bigint = trap('process.hrtime.bigint');
for (const name of ['window', 'document', 'localStorage', 'navigator', 'requestAnimationFrame']) {
  Object.defineProperty(globalThis, name, {
    get() {
      touched.add(name);
      return undefined;
    },
    configurable: true,
  });
}

const name = process.argv[2];
const { loadCartridge, replay, runScenario } = await import('../harness/cartridge.mjs');
let error = null;
try {
  const cart = await loadCartridge(name);
  replay(cart, { seed: 1337, tick: 120 });
  for (const sc of Object.keys(cart.scenarios)) runScenario(cart, sc);
} catch (err) {
  error = err;
}

if (touched.size) {
  console.error(`[sim-runtime] FAIL ${name} touched: ${[...touched].join(', ')}`);
  process.exit(1);
}
if (error) {
  console.error(`[sim-runtime] FAIL ${name} crashed under the probe: ${error.message}`);
  process.exit(1);
}
if (detHits.size) {
  const lines = [...detHits].map(([k, n]) => `${k} (${n} call${n === 1 ? '' : 's'})`);
  const head = `${name} called engine-dependent Math while playing (use the game's detMath module, written to give the same bits in every engine)`;
  if (det.mode === 'required') {
    console.error(`[sim-runtime] FAIL ${head}:`);
    for (const l of lines.slice(0, 25)) console.error(`  x ${l}`);
    process.exit(1);
  }
  console.log(`[sim-runtime] WARN ${head}; detMath mode warn:`);
  for (const l of lines.slice(0, 25)) console.log(`  ! ${l}`);
}
console.log(`[sim-runtime] PASS ${name}: no randomness, clock, timer or DOM access while playing`);
