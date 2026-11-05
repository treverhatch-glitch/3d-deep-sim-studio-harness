/**
 * qa/selftest-279a.mjs — 2.79 (a): the cleanup release's measuring tools (PU-64 settings census, PU-68 size report).
 *   census-known   a known setting is listed with its reader module and its default, and the CLI prints the summary line
 *   census-dead    a setting planted in a temp copy that no module reads (only a selftest names it) is dead; a read one
 *                  is not, and carries its default, its reader and the release whose CHANGELOG section names it
 *   census-env     --env marks a setting a studio's .env sets
 *   size-count     the size report's modules and lines match a direct count (the real tree and a planted one)
 * Measurement only: nothing here changes a harness path.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

export async function selftest279A({ dir, report, tmpRoot, root }) {
  const guard = async (name, fn) => { try { const [ok, detail] = await fn(); report(name, Boolean(ok), detail); } catch (e) { report(name, false, e.stack || String(e)); } };
  const imp = (rel) => import(pathToFileURL(path.join(dir, rel)).href);
  const put = (S, rel, text) => { fs.mkdirSync(path.dirname(path.join(S, rel)), { recursive: true }); fs.writeFileSync(path.join(S, rel), text); };
  const direct = (base) => { // an independent count: every code file under base, its lines
    const files = fs.readdirSync(base, { recursive: true, withFileTypes: true }).filter((e) => e.isFile() && /\.(mjs|cjs|js|ts|tsx|jsx|mts)$/.test(e.name) && !/(^|[\\/])(node_modules|dist|build|coverage|\.vite|\.git)([\\/]|$)/.test(path.relative(base, path.join(e.parentPath, e.name))));
    let lines = 0;
    for (const e of files) { const t = fs.readFileSync(path.join(e.parentPath, e.name), 'utf8'); lines += t ? t.split('\n').length - (t.endsWith('\n') ? 1 : 0) : 0; }
    return { modules: files.length, lines };
  };
  const LIVE = 'STUDIO' + '_PLANT_LIVE'; // built, so the settings scan doesn't count them as real names
  const DEAD = 'STUDIO' + '_PLANT_DEAD';
  const planted = path.join(tmpRoot, `279a-plant-${process.pid}`);
  fs.rmSync(planted, { recursive: true, force: true });
  put(planted, 'harness/alpha.mjs', `const n = Number(process.env.${LIVE} ?? 7);\nexport default n;\n`);
  put(planted, 'harness/sub/beta.mjs', 'export const b = 1;\n// two\n// three');
  put(planted, 'scripts/gamma.mjs', 'export const g = 1;\n');
  put(planted, 'qa/selftest-zzz.mjs', `export const x = '${DEAD} ${LIVE}';\n`);
  put(planted, 'docs/PLANT.md', `${LIVE} (7) is read by alpha. ${DEAD} is read by nobody.\n`);
  put(planted, 'CHANGELOG.md', `# Changelog\n\n## [1.2.0] — 2026-01-02\n- Added ${LIVE}.\n\n## [1.1.0] — 2026-01-01\n- first\n`);

  await guard('census-known', async () => {
    const { census } = await imp('scripts/settings-census.mjs');
    const c = census(dir);
    const hud = c.items.find((i) => i.name === 'STUDIO_PLANNING_ROOM');
    const def = c.items.find((i) => i.name === 'STUDIO_TEMP_SWEEP_MIN');
    const r = spawnSync(process.execPath, ['scripts/settings-census.mjs'], { windowsHide: true, cwd: dir, encoding: 'utf8' });
    const last = String(r.stdout || '').trim().split('\n').pop();
    const ok = hud?.readers.includes('harness/hud.mjs') && hud.modules === hud.readers.length && def?.default === '5' && def.modules >= 1 && c.total > 400
      && c.families.some((f) => f.suffix === '_WAIT_MIN') && new RegExp(`^SUMMARY: ${c.total} settings, ${c.dead.length} dead, ${c.offSwitches.length} off-switch candidates, ${c.families.length} duplicate families`).test(last);
    return [ok, `hud ${JSON.stringify(hud?.readers)} temp-sweep default ${def?.default} total ${c.total} | ${last} | ${String(r.stderr).slice(-300)}`];
  });

  await guard('census-dead', async () => {
    const { census } = await imp('scripts/settings-census.mjs');
    const c = census(planted);
    const live = c.items.find((i) => i.name === LIVE);
    const dead = c.items.find((i) => i.name === DEAD);
    const ok = c.total === 2 && c.dead.map((i) => i.name).join() === DEAD && dead.modules === 0 && live.modules === 1 && live.readers[0] === 'harness/alpha.mjs' && live.default === '7' && live.added === '1.2.0' && live.releasesAgo === 0;
    return [ok, JSON.stringify({ total: c.total, dead: c.dead.map((i) => i.name), live, dead1: dead })];
  });

  await guard('census-env', async () => {
    const { census } = await imp('scripts/settings-census.mjs');
    const env = path.join(tmpRoot, `279a-${process.pid}.env`);
    fs.writeFileSync(env, `${LIVE}=9\r\n# ${DEAD}=1\r\n`);
    const c = census(planted, { env });
    const live = c.items.find((i) => i.name === LIVE);
    const dead = c.items.find((i) => i.name === DEAD);
    return [live.setBy === 'env' && !dead.setBy && c.studio.set === 1 && c.studio.never === 1, JSON.stringify({ live: live.setBy, dead: dead.setBy, studio: c.studio })];
  });

  await guard('size-count', async () => {
    const { measure } = await imp('scripts/size-report.mjs');
    const m = measure(dir);
    const dh = direct(path.join(dir, 'harness'));
    const ds = direct(path.join(dir, 'scripts'));
    const dq = fs.readdirSync(path.join(dir, 'qa')).filter((n) => /^selftest.*\.mjs$/.test(n)).length;
    const shards = spawnSync(process.execPath, ['qa/selftest.mjs', '--list-shards', '1000'], { windowsHide: true, cwd: dir, encoding: 'utf8' });
    const units = JSON.parse(String(shards.stdout).trim().split('\n').pop()).units.length;
    const p = measure(planted);
    const ok = m.harness.modules === dh.modules && m.harness.lines === dh.lines && m.scripts.modules === ds.modules && m.scripts.lines === ds.lines && m.qa.selftestFiles === dq && m.testUnits === units && m.harness.largest.length === 15
      && m.harness.largest.every((f, i, a) => i === 0 || a[i - 1].lines >= f.lines)
      && p.harness.modules === 2 && p.harness.lines === 5 && p.scripts.lines === 1 && p.settings === 2 && p.hub.modules === 0;
    return [ok, JSON.stringify({ harness: [m.harness.modules, m.harness.lines, dh], scripts: [m.scripts.modules, m.scripts.lines, ds], qa: [m.qa.selftestFiles, dq], units: [m.testUnits, units], planted: { h: p.harness.modules, hl: p.harness.lines, sl: p.scripts.lines, s: p.settings } })];
  });

  try { fs.rmSync(planted, { recursive: true, force: true }); } catch {}
}
