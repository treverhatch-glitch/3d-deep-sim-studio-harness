/**
 * qa/selftest-278e.mjs — 2.78.0 (PU-57): a mutation score per required gate (qa/mutants.mjs), report only.
 *   a  on example-sim the report lists the mutants, each gate's kill rate and the survivors
 *   b  a deliberately weakened gate shows a lower kill rate than the normal one (and --compare says it dropped)
 *   c  a mutant that doesn't parse is discarded, not counted
 *   d  every mutant is applied in a scratch copy: the fixture's own files are unchanged afterwards
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

export async function selftest278E({ dir, run, report, tmpRoot, root }) {
  const harnessRoot = root || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const gEnv = () => { const e = { ...process.env, ...ident }; for (const k of Object.keys(e)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|CONFIG.*|NO_REPLACE_OBJECTS)$/.test(k)) delete e[k]; return e; };
  const gitIn = (cwd, ...a) => spawnSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', ...a], { windowsHide: true, cwd, encoding: 'utf8', env: gEnv() });
  const guard = async (name, fn) => { try { const [ok, detail] = await fn(); report(name, Boolean(ok), detail); } catch (e) { report(name, false, e.stack || String(e)); } };
  const want = (k) => !process.env.ONLY_278E || process.env.ONLY_278E.split(',').includes(k);
  const baseEnv = {
    STUDIO_MUTANTS_MAX: '', STUDIO_MUTANTS_SEED: '', STUDIO_MUTANTS_GATES: '', STUDIO_MUTANTS_BUDGET_MIN: '', STUDIO_CARTRIDGE: '', STUDIO_GAME: '',
    STUDIO_VERIFY_RUN: '', STUDIO_GATE_CHANGED: '', STUDIO_GATE_PATHS: '', NODE_OPTIONS: '', npm_config_node_options: '', npm_lifecycle_event: '', CI: '', ...ident,
  };

  // The fixture: a copy of the harness with its own git (autocrlf false, eol lf), never the checkout under test.
  const S = path.join(tmpRoot, `278e-fixture-${process.pid}`);
  fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|\.studio|node_modules)$/.test(src) });
  const nm = path.join(harnessRoot, 'node_modules');
  if (fs.existsSync(nm)) { try { fs.symlinkSync(fs.realpathSync(nm), path.join(S, 'node_modules'), 'junction'); } catch { /* none */ } }
  gitIn(S, 'init', '-q', '-b', 'main'); gitIn(S, 'config', 'core.autocrlf', 'false'); gitIn(S, 'config', 'core.eol', 'lf');
  gitIn(S, 'add', '-A'); gitIn(S, 'commit', '-qm', 'fixture', '--no-verify');

  const treeDigest = () => {
    const h = crypto.createHash('sha256');
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
        if (/^(\.git|node_modules|\.studio|reports)$/.test(e.name)) continue;
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p); else h.update(`${path.relative(S, p)}\0`).update(fs.readFileSync(p));
      }
    };
    for (const sub of ['cartridges', 'qa/golden', 'qa/regressions', 'studio', 'scripts', 'harness']) if (fs.existsSync(path.join(S, sub))) walk(path.join(S, sub));
    return h.digest('hex');
  };
  const before = treeDigest();
  const mod = await import(pathToFileURL(path.join(S, 'qa', 'mutants.mjs')).href);
  const scratchRoot = path.join(tmpRoot, `278e-scratch-${process.pid}`);
  const common = { root: S, cartridge: 'example-sim', seed: 278, scratchRoot };
  const gatesJson = path.join(S, 'studio', 'gates.json');
  let normal = null;

  // ---- a: the report (through the command line) ----
  if (want('a')) await guard('2.78.0 (PU-57): node qa/mutants.mjs on example-sim lists the mutants, each gate\'s kill rate and the survivors, writes qa/reports JSON, exits 0 (fails on 2.77.1: no mutation report)', async () => {
    const file = path.join(tmpRoot, `278e-report-${process.pid}.json`);
    const r = run(S, `node qa/mutants.mjs --cartridge example-sim --max 6 --out "${file}"`, baseEnv);
    let rep = null;
    try { rep = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* checked below */ }
    if (!rep) return [false, `no report: status ${r.status} ${out(r).slice(-1500)}`];
    normal = rep;
    const text = out(r);
    const rates = Object.entries(rep.gateRates || {});
    const ok = r.status === 0 && rep.mutants.length === 6 && rates.length >= 4 && rates.every(([, v]) => v.ran === 6 && v.killed <= v.ran)
      && rep.gateRates.golden?.killed > 0 && Array.isArray(rep.survivors) && rep.mutants.every((m) => m.file && m.line && m.operator && m.desc)
      && /Kill rate per gate/.test(text) && /golden\s+\d+ \/ 6/.test(text) && rep.ms > 0
      && rep.survivors.every((s) => text.includes(`${s.file}:${s.line}`));
    return [ok, JSON.stringify({ status: r.status, mutants: rep.mutants.length, rates: rep.gateRates, survivors: rep.survivors.length, text: text.slice(-1800) })];
  });

  // ---- b: a weakened gate scores lower ----
  if (want('b')) await guard('2.78.0 (PU-57): a golden gate weakened to always pass has a lower kill rate than the normal one on the same mutants, and --compare says it dropped (fails on 2.77.1: no mutation report)', async () => {
    if (!normal) {
      normal = await mod.runMutants({ ...common, max: 6 });
    }
    const weak = await mod.runMutants({
      ...common, max: 6,
      prepare: (scratch) => {
        const f = path.join(scratch, 'studio', 'gates.json');
        const cfg = JSON.parse(fs.readFileSync(f, 'utf8'));
        const g = cfg.gates.find((x) => x.id === 'golden');
        g.command = 'node -e "process.exit(0)"';
        fs.writeFileSync(f, `${JSON.stringify(cfg, null, 2)}\n`);
      },
    });
    const lines = mod.compareLines(normal, weak);
    const n = normal.gateRates.golden; const w = weak.gateRates.golden;
    const ok = n && w && n.killed > 0 && w.killed === 0 && w.rate < n.rate
      && weak.mutants.map((m) => `${m.file}:${m.line}:${m.operator}`).join() === normal.mutants.map((m) => `${m.file}:${m.line}:${m.operator}`).join()
      && lines.some((l) => /golden\s/.test(l) && /DROPPED/.test(l));
    return [ok, JSON.stringify({ normal: n, weak: w, lines })];
  });

  // ---- c: a mutant that doesn't parse is discarded ----
  if (want('c')) await guard('2.78.0 (PU-57): a mutant that does not parse (node --check) is discarded and not counted in any rate (fails on 2.77.1: no mutation report)', async () => {
    const file = 'cartridges/example-sim/index.mjs';
    const src = fs.readFileSync(path.join(S, file), 'utf8').replace(/\r\n/g, '\n');
    const at = src.indexOf('export const unitCount');
    const rep = await mod.runMutants({
      ...common, max: 2, gates: ['golden', 'regressions'],
      extraCandidates: [{ file, start: at, end: at + 6, text: 'export const ((( broken', operator: 'broken-test', desc: 'does not parse' }],
    });
    const ok = rep.discarded.parse.length === 1 && rep.discarded.parse[0].operator === 'broken-test'
      && rep.mutants.length === 2 && !rep.mutants.some((m) => m.operator === 'broken-test')
      && Object.values(rep.gateRates).every((v) => v.ran === 2)
      && !rep.survivors.some((s) => s.operator === 'broken-test');
    return [ok, JSON.stringify({ discarded: rep.discarded, mutants: rep.mutants.map((m) => m.operator), rates: rep.gateRates })];
  });

  // ---- d: the fixture is untouched ----
  if (want('d')) await guard('2.78.0 (PU-57): mutants are applied in a scratch copy: the fixture\'s files are unchanged after the runs and the scratch copy is gone (fails on 2.77.1: no mutation report)', async () => {
    const after = treeDigest();
    const left = fs.existsSync(scratchRoot) ? fs.readdirSync(scratchRoot).filter((f) => f.startsWith('mutants-')) : [];
    const dirty = gitIn(S, 'status', '--porcelain', '--', 'cartridges', 'qa/golden', 'qa/regressions', 'studio', 'harness', 'scripts');
    return [after === before && !left.length && !String(dirty.stdout || '').trim(), JSON.stringify({ same: after === before, left, porcelain: String(dirty.stdout || '').slice(0, 300) })];
  });
  void gatesJson;
}
