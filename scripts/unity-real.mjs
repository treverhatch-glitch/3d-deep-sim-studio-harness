#!/usr/bin/env node
/**
 * scripts/unity-real.mjs — 2.84: the harness's Unity readers, checked against a real editor's own output.
 *
 * Every release up to 2.83 met a real Unity editor for the first time on a crew's PC: the self-test uses stand-in land
 * scripts. This script makes three small copies of the Unity template (engine/_unity), each with one more Edit Mode test
 * assembly the .NET test project does not compile, lets the online check run the real editor on each (GameCI's test
 * runner, .github/workflows/ci.yml job engine-unity-real), and then holds the harness's own functions against what
 * the editor wrote:
 *
 *   plan    the editor is started with the arguments harness/unity.mjs editModePlan gives (-assemblyNames <the
 *           assemblies .NET does not compile>): only those tests may have run, and they must have run
 *   red     one test fails on purpose: harness/unity-gate.mjs failingTests must name it from the editor's results
 *   broken  one file does not compile: harness/unity-gate.mjs compileErrorFiles must name that file from the editor's log
 *
 *   node scripts/unity-real.mjs prepare [--out <dir>]   make the three copies; prints (and writes to $GITHUB_OUTPUT) plan_args
 *   node scripts/unity-real.mjs check   [--out <dir>]   judge what the editor left under <dir>/out/<name>/
 *
 * Without a Unity licence the workflow runs neither step and says so. Nothing here reads or prints a secret.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { editModePlan, parseNUnit } from '../harness/unity.mjs';
import { failingTests, compileErrorFiles } from '../harness/unity-gate.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE = path.join(ROOT, 'engine', '_unity');
export const CASES = ['plan', 'red', 'broken'];
export const EXTRA_ASM = 'StudioRealExtraTests';
export const EXTRA_DIR = 'Assets/Tests/RealExtra';
export const FAILING = 'Studio.RealExtra.Tests.ExtraTests.FailsOnPurpose';
export const BROKEN_FILE = `${EXTRA_DIR}/Broken.cs`;

const ASMDEF = `${JSON.stringify({
  name: EXTRA_ASM, rootNamespace: 'Studio.RealExtra.Tests', references: [], includePlatforms: ['Editor'], excludePlatforms: [],
  allowUnsafeCode: false, overrideReferences: true, precompiledReferences: ['nunit.framework.dll'], autoReferenced: false,
  defineConstraints: ['UNITY_INCLUDE_TESTS'], versionDefines: [], noEngineReferences: true,
}, null, 2)}\n`;
const testsCs = (failing) => `// Written by scripts/unity-real.mjs for the online check: an Edit Mode test assembly the .NET project does not compile.
using NUnit.Framework;

namespace Studio.RealExtra.Tests
{
    public class ExtraTests
    {
        [Test]
        public void OneAndOne() { Assert.AreEqual(2, 1 + 1); }

        [Test]
        public void TextJoins() { Assert.AreEqual("ab", "a" + "b"); }
${failing ? `
        [Test]
        public void FailsOnPurpose() { Assert.AreEqual(1, 2, "red on purpose: the harness must name this test"); }
` : ''}    }
}
`;
const BROKEN_CS = `// Written by scripts/unity-real.mjs for the online check: this file must not compile (the harness must name it).
namespace Studio.RealExtra.Tests
{
    public class Broken
    {
        public int Value() { return MissingThing.DoesNotExist; }
    }
}
`;

/** Copy the template to <out>/<name> (no Library, Temp, obj or bin) and add the extra assembly for that case. */
export function prepareCase(out, name) {
  const dir = path.join(out, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.cpSync(TEMPLATE, dir, { recursive: true, filter: (src) => !/[\\/](Library|Temp|Logs|obj|bin|Build)$/.test(src) });
  const extra = path.join(dir, ...EXTRA_DIR.split('/'));
  fs.mkdirSync(extra, { recursive: true });
  fs.writeFileSync(path.join(extra, `${EXTRA_ASM}.asmdef`), ASMDEF);
  fs.writeFileSync(path.join(extra, 'ExtraTests.cs'), testsCs(name === 'red'));
  if (name === 'broken') fs.writeFileSync(path.join(extra, 'Broken.cs'), BROKEN_CS);
  return dir;
}

/** Every file under dir (recursive) whose name matches re. */
function filesUnder(dir, re) {
  const out = [];
  const walk = (d) => { let es = []; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } for (const e of es) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (re.test(e.name)) out.push(p); } };
  walk(dir);
  return out.sort();
}
const readAll = (files) => files.map((f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } }).join('\n');
const caseNames = (xml) => [...String(xml).matchAll(/<test-case\b[^>]*\bfullname="([^"]+)"/g)].map((m) => m[1]);

/** Judge one case from what the editor left. { name, ok, why, detail }. Pure over the texts given. */
export function judgeCase(name, { xml = '', log = '', planArgs = [] } = {}) {
  const names = caseNames(xml);
  const extra = names.filter((n) => n.startsWith('Studio.RealExtra.Tests.'));
  const sim = names.filter((n) => n.startsWith('Studio.Sim.Tests.'));
  if (name === 'plan') {
    if (planArgs[0] !== '-assemblyNames' || planArgs[1] !== EXTRA_ASM) return { name, ok: false, why: `editModePlan gave ${JSON.stringify(planArgs)}, expected ["-assemblyNames","${EXTRA_ASM}"]`, detail: {} };
    const res = xml ? parseNUnit(xml) : null;
    const ok = extra.length >= 2 && sim.length === 0 && res && res.failed === 0;
    return { name, ok: Boolean(ok), why: ok ? `with ${planArgs.join(' ')} the editor ran ${extra.length} test(s) of ${EXTRA_ASM} and none of the .NET-covered assembly` : `with ${planArgs.join(' ')} the editor ran ${extra.length} extra test(s) and ${sim.length} .NET-covered test(s)${res ? `, ${res.failed} failed` : '; no results file was read'}`, detail: { extra, sim, results: res } };
  }
  if (name === 'red') {
    const fromXml = failingTests(xml);
    const fromLog = failingTests(log);
    const ok = fromXml.includes(FAILING);
    return { name, ok, why: ok ? `failingTests names ${FAILING} from the editor's results${fromLog.includes(FAILING) ? ' and from its log' : ' (its log alone does not name it)'}` : `failingTests gave ${JSON.stringify(fromXml)} from the results and ${JSON.stringify(fromLog)} from the log; expected ${FAILING}`, detail: { fromXml, fromLog, ran: names.length } };
  }
  if (name === 'broken') {
    const files = compileErrorFiles(log);
    const ok = files.some((f) => f === BROKEN_FILE || f.endsWith(`/${BROKEN_FILE}`));
    const lines = String(log).split(/\r?\n/).filter((l) => /error CS\d+/.test(l)).slice(0, 4);
    return { name, ok, why: ok ? `compileErrorFiles names ${BROKEN_FILE} from the editor's log` : `compileErrorFiles gave ${JSON.stringify(files)}; expected ${BROKEN_FILE}. Error lines the editor printed: ${JSON.stringify(lines)}`, detail: { files, lines, ran: names.length } };
  }
  return { name, ok: false, why: 'unknown case', detail: {} };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const flag = (k) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : null);
  const out = path.resolve(ROOT, flag('out') || '.unity-real');
  const cmd = argv[0];
  if (cmd === 'prepare') {
    for (const n of CASES) console.log(`[unity-real] ${n}: ${path.relative(ROOT, prepareCase(out, n)).split(path.sep).join('/')}`);
    const plan = editModePlan(path.join(out, 'plan'));
    console.log(`[unity-real] plan: ${plan.why}`);
    console.log(`[unity-real] plan_args: ${plan.args.join(' ')}`);
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `plan_args=${plan.args.join(' ')}\n`);
    process.exit(plan.args[0] === '-assemblyNames' ? 0 : 1);
  } else if (cmd === 'check') {
    const planArgs = editModePlan(path.join(out, 'plan')).args;
    let bad = 0;
    for (const n of CASES) {
      const dir = path.join(out, 'out', n);
      const xmls = filesUnder(dir, /\.xml$/i);
      const logs = filesUnder(dir, /\.(log|txt)$/i);
      console.log(`[unity-real] ${n}: the editor left ${xmls.length} results file(s) and ${logs.length} log(s) in ${path.relative(ROOT, dir).split(path.sep).join('/')}: ${[...xmls, ...logs].map((f) => path.basename(f)).join(', ') || 'nothing'}`);
      const r = judgeCase(n, { xml: readAll(xmls), log: `${readAll(logs)}\n${readAll(xmls)}`, planArgs });
      console.log(`[unity-real] ${r.ok ? 'PASS' : 'FAIL'} ${n}: ${r.why}`);
      if (!r.ok) { bad += 1; console.log(`[unity-real]   ${JSON.stringify(r.detail).slice(0, 1500)}`); }
    }
    console.log(bad ? `[unity-real] ${bad} of ${CASES.length} case(s) failed against the real editor` : `[unity-real] all ${CASES.length} cases hold against the real editor`);
    process.exit(bad ? 1 : 0);
  } else {
    console.error('Usage: node scripts/unity-real.mjs prepare|check [--out <dir>]');
    process.exit(2);
  }
}
