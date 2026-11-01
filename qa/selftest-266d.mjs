/**
 * qa/selftest-266d.mjs — 2.66.0 (d): a "Fix:" line under every gate failure, and a generated settings map.
 *   Fix line: harness/gate-fix.mjs has an entry for every gate in studio/gates.json and every game check kind in
 *             harness/game-gates.mjs (a made-up gate or kind without one fails --check); run-gates prints
 *             `[gates] Fix: …` right after a failing gate, compact or not; safety gates never tell an agent to approve.
 *   Settings: scripts/settings-map.mjs writes docs/SETTINGS.md (a known setting with its default); --check (run by the
 *             docs gate) fails on a new undocumented STUDIO_* name until a docs/ page mentions it; the baseline only shrinks.
 * The made-up setting's name is put together at run time, so this file doesn't add it to the map.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function selftest266D({ dir, run, report }) {
  const u = (p) => JSON.stringify(pathToFileURL(path.join(dir, p)).href);
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const env = { STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_VERIFY_DETACH: 'off' };
  const probe = (name, code) => {
    const f = path.join(dir, `.probe-266d-${name}.mjs`);
    fs.writeFileSync(f, code);
    const r = run(dir, `node ${path.basename(f)}`, env);
    const line = String(r.stdout || '').trim().split('\n').filter((l) => l.startsWith('{')).pop();
    try { return { ...JSON.parse(line), _err: r.stderr }; } catch { return { _raw: out(r).slice(-1500) }; }
  };
  const gatesFile = path.join(dir, 'studio', 'gates.json');
  const gatesText = fs.readFileSync(gatesFile, 'utf8');
  const ggFile = path.join(dir, 'harness', 'game-gates.mjs');
  const ggText = fs.readFileSync(ggFile, 'utf8');

  // 1. Every gate has its own entry; a made-up gate without one fails the check, naming it.
  const ok1 = run(dir, 'node harness/gate-fix.mjs --check', env);
  const cfg = JSON.parse(gatesText);
  cfg.gates.push({ id: 'made-up-gate', command: 'node -e "process.exit(1)"', required: false });
  fs.writeFileSync(gatesFile, JSON.stringify(cfg, null, 2));
  const bad1 = run(dir, 'node harness/gate-fix.mjs --check', env);
  fs.writeFileSync(gatesFile, gatesText);
  report('2.66.0 (d): every gate in studio/gates.json has a Fix entry; a made-up gate without one fails gate-fix --check, named',
    ok1.status === 0 && bad1.status === 1 && /made-up-gate/.test(out(bad1)), `${out(ok1).slice(-400)}\n---\n${out(bad1).slice(-400)}`);

  // 2. A new game check kind in harness/game-gates.mjs without an entry fails the check too.
  fs.writeFileSync(ggFile, ggText.replace("rows.push({ id: 'game:none'", "rows.push({ id: 'game:made-up-kind', ok: true, required: false }); rows.push({ id: 'game:none'"));
  const bad2 = run(dir, 'node harness/gate-fix.mjs --check', env);
  fs.writeFileSync(ggFile, ggText);
  report('2.66.0 (d): every game check kind (read from harness/game-gates.mjs) has a Fix entry; a new kind without one fails, named',
    ok1.status === 0 && bad2.status === 1 && /game:made-up-kind/.test(out(bad2)), out(bad2).slice(-400));

  // 3. Which text: a gate's own "fix", a failing game check's kind, the fallback naming the log; safety gates never
  //    tell an agent to approve.
  const t = probe('text', `import { gateFix, gateFixLine } from ${u('harness/gate-fix.mjs')};
const own = gateFixLine({ id: 'studio-lint', fix: 'run the linter on the files it names' });
const sub = gateFix({ id: 'game' }, { output: '[game-gates] PASS game:qa\\n[game-gates] FAIL game:layout: pier p1 not in water\\n' });
const eng = gateFix({ id: 'game' }, { output: '[game-gates] FAIL engine:web/demo: SCRIPT ERROR\\n' });
const fb = gateFixLine({ id: 'no-such-gate' }, { compact: true });
const safety = ['protected', 'weakened-tests', 'hooks', 'secrets', 'regressions', 'controls'].map((id) => gateFixLine({ id }));
console.log(JSON.stringify({ own, sub, eng, fb, safety }));`);
  report('2.66.0 (d): a gate\'s own "fix" wins; a failing game check picks its kind; the fallback names the log and the rerun; safety gates say hand back, never approve',
    /^Fix: run the linter on the files it names; .*--only studio-lint$/.test(t.own || '') && t.sub?.source === 'game-check' && /^game:layout: .*studio\.layout\.json/.test(t.sub.text) && /^engine:web\/demo: .*Godot/.test(t.eng?.text || '')
    && /^Fix: read \.studio\/gates\/out\/no-such-gate\.log .*npm run verify -- --only no-such-gate$/.test(t.fb || '')
    && Array.isArray(t.safety) && t.safety.every((l) => /^Fix: /.test(l) && !/npm run approve/.test(l)) && t.safety.slice(0, 2).every((l) => /hand the task back/.test(l)), JSON.stringify(t).slice(0, 1500));

  // 4. run-gates prints the Fix line right after a failing gate, in compact and in normal output.
  const broken = path.join(dir, 'docs', 'ZZ-266D-BROKEN.md');
  fs.writeFileSync(broken, '# x\n\nRun `npm run no-such-script-266d` first.\n');
  const full = run(dir, 'node scripts/run-gates.mjs --only docs --no-detach', { ...env, STUDIO_COMPACT_OUTPUT: 'off' });
  const comp = run(dir, 'node scripts/run-gates.mjs --only docs --no-detach', { ...env, STUDIO_COMPACT_OUTPUT: 'on' });
  fs.rmSync(broken, { force: true });
  const fixAfter = (r) => { const ls = String(r.stdout || '').split(/\r?\n/); const i = ls.findIndex((l) => /^\[gates\] FAIL docs$/.test(l)); return i >= 0 && /^\[gates\] Fix: .*npm run verify -- --only docs/.test(ls[i + 1] || ''); };
  report('2.66.0 (d): a failing gate in npm run verify is followed by one [gates] Fix: line (normal and compact output)',
    full.status === 1 && comp.status === 1 && fixAfter(full) && fixAfter(comp) && /full log: \.studio\/gates\/out\/docs\.log/.test(comp.stdout), `${out(full).slice(-900)}\n---\n${out(comp).slice(-900)}`);

  // 5. The map lists a known setting with its default and its file.
  const gen = run(dir, 'node scripts/settings-map.mjs', env);
  const map = (() => { try { return fs.readFileSync(path.join(dir, 'docs', 'SETTINGS.md'), 'utf8'); } catch { return ''; } })();
  report('2.66.0 (d): node scripts/settings-map.mjs writes docs/SETTINGS.md, grouped, with a known setting\'s default and file',
    gen.status === 0 && /^<!-- Generated by `node scripts\/settings-map\.mjs`/.test(map) && /^## COMPACT_\* \(/m.test(map)
    && /^- `STUDIO_COMPACT_FAIL_LINES` · default `40` · scripts\/run-gates\.mjs/m.test(map), `${out(gen).slice(-300)}\n${map.slice(0, 600)}`);

  // 6. A new STUDIO_* name in the code fails --check and the docs gate until a docs/ page mentions it; then the map
  //    shows its default and its page.
  const name = ['STUDIO', 'FOO', 'BAR', '266D'].join('_');
  const codeFile = path.join(dir, 'harness', 'zz-266d-setting.mjs');
  const docFile = path.join(dir, 'docs', 'ZZ-266D-SETTING.md');
  const pass0 = run(dir, 'node scripts/settings-map.mjs --check', env);
  fs.writeFileSync(codeFile, `export const n = Number(process.env.${name} || 7);\n`);
  const chk1 = run(dir, 'node scripts/settings-map.mjs --check', env);
  const docs1 = run(dir, 'node scripts/check-docs.mjs', env);
  fs.writeFileSync(docFile, `# A setting\n\n\`${name}\` (default 7) sets how many.\n`);
  const chk2 = run(dir, 'node scripts/settings-map.mjs --check', env);
  const docs2 = run(dir, 'node scripts/check-docs.mjs', env);
  run(dir, 'node scripts/settings-map.mjs', env);
  const map2 = (() => { try { return fs.readFileSync(path.join(dir, 'docs', 'SETTINGS.md'), 'utf8'); } catch { return ''; } })();
  fs.rmSync(codeFile, { force: true });
  fs.rmSync(docFile, { force: true });
  report('2.66.0 (d): a new undocumented STUDIO_* name fails settings-map --check and the docs gate, named; documented in docs/ it passes and the map links the page',
    pass0.status === 0 && chk1.status === 1 && out(chk1).includes(name) && docs1.status === 1 && out(docs1).includes(name)
    && chk2.status === 0 && docs2.status === 0 && map2.includes(`- \`${name}\` · default \`7\` · harness/zz-266d-setting.mjs · [ZZ-266D-SETTING.md:3](ZZ-266D-SETTING.md)`),
    `${out(pass0).slice(-300)}\n---\n${out(chk1).slice(-300)}\n---\n${out(docs1).slice(-300)}\n---\n${out(chk2).slice(-300)}\n---\n${out(docs2).slice(-300)}`);

  // 7. The baseline only shrinks: --init-baseline refuses when one exists; --prune-baseline drops a name once documented.
  const blFile = path.join(dir, 'docs', 'settings-baseline.json');
  const blText = (() => { try { return fs.readFileSync(blFile, 'utf8'); } catch { return ''; } })();
  const init = run(dir, 'node scripts/settings-map.mjs --init-baseline', env);
  const known = 'STUDIO_COMPACT_FAIL_LINES';
  const before = (() => { try { return JSON.parse(blText).undocumented; } catch { return []; } })();
  fs.writeFileSync(docFile, `# A setting\n\n\`${known}\`: how many lines of a failing gate's log compact output shows (default 40).\n`);
  const prune = run(dir, 'node scripts/settings-map.mjs --prune-baseline', env);
  const after = (() => { try { return JSON.parse(fs.readFileSync(blFile, 'utf8')).undocumented; } catch { return null; } })();
  fs.rmSync(docFile, { force: true });
  if (blText) fs.writeFileSync(blFile, blText);
  report('2.66.0 (d): the settings baseline only shrinks (init refuses over an existing one; prune drops a newly documented name)',
    before.includes(known) && init.status === 1 && prune.status === 0 && Array.isArray(after) && !after.includes(known) && after.length === before.length - 1,
    `${out(init).slice(-300)}\n---\n${out(prune).slice(-300)}`);
}
