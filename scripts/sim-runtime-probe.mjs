#!/usr/bin/env node
/**
 * scripts/sim-runtime-probe.mjs <cartridge> — run one cartridge with every source of nondeterminism trapped.
 *
 * Static scans miss aliases (`const r = Math.random`, `const D = Date; D.now()`, `globalThis['Ma'+'th']`).
 * This probe replaces those globals before the cartridge is imported, then plays a replay and every
 * scenario. Any touch is recorded and the probe exits 1. Called by scripts/check-sim-purity.mjs.
 */

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
console.log(`[sim-runtime] PASS ${name}: no randomness, clock, timer or DOM access while playing`);
