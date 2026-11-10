/**
 * qa/selftest-280d.mjs — 2.80 (d): small fixes from the crew's trials (aider start with no task, ask subcommands, BOM in
 * studio/game.json, landing build of an adopted game, board-only paths, dry-run status, godot-unit N/A, telemetry noise).
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export async function selftest280D({ dir, report, tmpRoot }) {
  const u = (rel) => pathToFileURL(path.join(dir, rel)).href;
  const guard = async (name, fn) => {
    try { const [ok, detail] = await fn(); report(name, Boolean(ok), ok ? '' : String(detail || '').slice(0, 2500)); }
    catch (e) { report(name, false, String(e?.stack || e).slice(0, 2500)); }
  };
  const node = (args, { env = {}, cwd = dir, input } = {}) => {
    const r = spawnSync(process.execPath, args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 120000, input, env: { ...process.env, ...env } });
    return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}`.replace(/\r\n/g, '\n') };
  };
  const probe = (code, env) => {
    const f = path.join(tmpRoot, `p280d-${process.pid}-${Math.random().toString(36).slice(2)}.mjs`);
    fs.writeFileSync(f, code);
    const r = node([f], { env });
    try { fs.rmSync(f, { force: true }); } catch {}
    return r;
  };

  await guard('2.80 (d) #1: a builder on an aider-run tool (vertex, nim, aider) with no --task is refused before anything starts, saying to pass --task (fails on 2.79.2: the launch went ahead and aider ran with its whole repo map)', async () => {
    const src = (tool, task) => `import { startAgent } from ${JSON.stringify(u('harness/agent.mjs'))};
const r = startAgent({ role: 'builder', agent: 'builder-t280d', tool: ${JSON.stringify(tool)}, model: 'm'${task ? `, task: ${JSON.stringify(task)}` : ''} });
console.log('R ' + JSON.stringify({ ok: r.ok, message: r.message }));`;
    const rows = ['vertex', 'nim', 'aider'].map((t) => {
      const r = probe(src(t, null));
      const j = JSON.parse((r.out.split('\n').find((l) => l.startsWith('R ')) || 'R {}').slice(2));
      return { t, ok: j.ok, msg: j.message };
    });
    return [rows.every((x) => x.ok === false && /--task/.test(x.msg || '') && /no task/.test(x.msg || '')), JSON.stringify(rows)];
  });

  await guard('2.80 (d) #2: `ask show <id>` and `ask help` / --help / -h are read-only, and a lone lowercase word prints the usage and exits non-zero instead of filing an ask (fails on 2.79.2: they each filed an ask titled "show"/"help")', async () => {
    const asks = path.join(dir, 'studio', 'asks');
    const count = () => (fs.existsSync(asks) ? fs.readdirSync(asks).length : 0);
    const before = count();
    const r = (...a) => node(['harness/ask.mjs', ...a]);
    const filed = r('Is the sky blue?', '--by', 'qa-t');
    const id = (filed.out.match(/A-\d+/) || [''])[0];
    const mid = count();
    const show = r('show', id), help = r('help'), h1 = r('--help'), h2 = r('-h'), junk = r('foo'), none = r('show', 'A-9999');
    const after = count();
    try { if (id) fs.rmSync(path.join(asks, `${id}.json`), { force: true }); } catch {}
    return [Boolean(id) && mid === before + 1 && after === mid && show.code === 0 && /Is the sky blue/.test(show.out) && [help, h1, h2].every((x) => x.code === 0 && /Usage:/.test(x.out))
      && junk.code !== 0 && /Usage:/.test(junk.out) && none.code !== 0, JSON.stringify({ id, before, mid, after, show: show.code, help: help.code, junk: junk.code, none: none.code, junkOut: junk.out.slice(0, 120) })];
  });

  await guard('2.80 (d) #4: the landing build of a studio whose game.json adopts a game builds that game\'s declared tester build (dist), says so honestly when it declares none, and never calls it the template (fails on 2.79.2: "the game is the template cartridge (example-sim)")', async () => {
    const gf = path.join(dir, 'studio', 'game.json');
    const had = fs.existsSync(gf) ? fs.readFileSync(gf, 'utf8') : null;
    const gdir = path.join(dir, 'game', 't280d');
    const madeGame = !fs.existsSync(gdir);
    fs.mkdirSync(path.join(gdir, 'dist'), { recursive: true });
    try {
      const run = (doc) => {
        fs.mkdirSync(path.dirname(gf), { recursive: true });
        fs.writeFileSync(gf, JSON.stringify(doc));
        const r = probe(`import { gameBrowserBuild } from ${JSON.stringify(u('harness/landing-build.mjs'))};
const g = await gameBrowserBuild(${JSON.stringify(dir)}, { env: {} });
console.log('R ' + JSON.stringify({ ok: g.ok, why: g.why, name: g.name, browser: g.cart?.browser }));`, { STUDIO_CARTRIDGE: '', STUDIO_GAME: '' });
        return JSON.parse((r.out.split('\n').find((l) => l.startsWith('R ')) || 'R {"why":"no output"}').slice(2));
      };
      const withBuild = run({ game: 't280d', tester: { build: 'npm run build', dist: 'game/t280d/dist' } });
      const none = run({ game: 't280d' });
      return [withBuild.ok === true && withBuild.name === 't280d' && withBuild.browser?.dist === 'game/t280d/dist' && withBuild.browser?.build === 'npm run build'
        && none.ok === false && /declares no build/.test(none.why) && !/template/.test(none.why), JSON.stringify({ withBuild, none })];
    } finally {
      if (had === null) fs.rmSync(gf, { force: true }); else fs.writeFileSync(gf, had);
      if (madeGame) fs.rmSync(gdir, { recursive: true, force: true });
      try { fs.rmdirSync(path.join(dir, 'game')); } catch {}
    }
  });

  await guard('2.80 (d) #6: a dry-run train writes no "build" status (it ends before a verify and never writes "done", so the watcher called it died); a real train still does (fails on 2.79.2: the build status was written for a dry run too)', async () => {
    const src = fs.readFileSync(path.join(dir, 'harness', 'train.mjs'), 'utf8').replace(/\r\n/g, '\n');
    const line = src.split('\n').find((l) => l.includes("writeTrainStatus(root, id, { step: 'build'")) || '';
    const dry = src.indexOf('if (dryRun) {\n        res.message = `Dry run:');
    return [/^\s*if \(!dryRun\) writeTrainStatus\(/.test(line) && dry > 0 && src.indexOf(line) < dry, line.slice(0, 200)];
  });

  await guard('2.80 (d) #7: the godot-unit gate of a studio with no Godot project prints "N/A: no Godot project in this studio" and passes even when the config is enabled and no Godot binary exists; a project that exists is still judged by the config (fails on 2.79.2: an enabled config with no project said "project path ... not found" and one that got further failed on the missing binary)', async () => {
    const gu = await import(u('harness/godot-unit.mjs'));
    const none = gu.shouldRun({ enabled: true, project: 'game/t280d-none', godot: '4.7.2' }, null);
    const bare = gu.shouldRun({ enabled: true }, null);
    const r = node(['harness/godot-unit.mjs', '--changed'], { env: { GODOT_BIN: '' } });
    const hasProject = fs.existsSync(path.join(dir, 'game', 'godot', 'project.godot'));
    const pd = path.join(dir, 'game', 't280d-gd');
    fs.mkdirSync(pd, { recursive: true });
    fs.writeFileSync(path.join(pd, 'project.godot'), '');
    let disabled;
    try { disabled = gu.shouldRun({ enabled: false, project: 'game/t280d-gd' }, null); } finally { fs.rmSync(pd, { recursive: true, force: true }); try { fs.rmdirSync(path.join(dir, 'game')); } catch {} }
    return [none.run === false && /^N\/A: no Godot project in this studio$/.test(none.reason) && bare.run === false && /^N\/A/.test(bare.reason) && /disabled/.test(disabled.reason)
      && (hasProject || (r.code === 0 && /N\/A: no Godot project in this studio/.test(r.out))), JSON.stringify({ none, bare, disabled, code: r.code, out: r.out.slice(0, 200) })];
  });

  await guard('2.80 (d) #8a: threads have no shadow mode: a source that is not live, and a "shadow" mode (STUDIO_THREADS or the table), route nothing and write no would_route / would_drop event; live sources still route; the shadow report is gone (fails on 2.79.2: both events were emitted for every event)', async () => {
    const th = await import(u('harness/threads.mjs'));
    const e = { id: 'e1', ts: new Date().toISOString(), type: 'ci.failed', msg: 'CI red on abc', meta: { sha: 'abcdef1' } };
    const d = { id: 'e2', ts: e.ts, type: 'inbound.message', msg: 'x', meta: { source: 'discord', thread: 'task:T-1' } };
    const base = { idx: { keys: {} }, board: null, triggers: th.readTriggers() };
    const sh = th.routeEvent(e, { ...base, mode: 'shadow' });
    const notLive = th.routeEvent(d, { ...base, mode: 'on', triggers: { ...base.triggers, live: ['ci', 'train'] } });
    const src = fs.readFileSync(path.join(dir, 'harness', 'threads.mjs'), 'utf8');
    return [sh.action === 'none' && notLive.action === 'none' && th.threadsMode({ STUDIO_THREADS: 'shadow' }, { mode: 'on' }) === 'off' && th.threadsMode({}, { mode: 'shadow' }) === 'off' && th.threadsMode({ STUDIO_THREADS: 'on' }, { mode: 'off' }) === 'on'
      && !/would_route|would_drop/.test(src.replace(/\/\/.*|\/\*[\s\S]*?\*\//g, '')) && th.shadowReport === undefined, JSON.stringify({ sh, notLive })];
  });

  await guard('2.80 (d) #8b: hotspot.overlap is one event per file and set of lanes, not one per line the overlap moved to; another lane set writes again (fails on 2.79.2: one event per line)', async () => {
    const root = fs.mkdtempSync(path.join(tmpRoot, 'hs280d-'));
    const evf = path.join(root, 'events.jsonl');
    const r = probe(`import { postOverlaps } from ${JSON.stringify(u('harness/hotspots.mjs'))};
const o = (line, lanes) => [{ file: 'src/a-' + ${JSON.stringify(path.basename(root))} + '.ts', line, lanes }];
postOverlaps(${JSON.stringify(root)}, o(10, ['T-1', 'T-2']));
postOverlaps(${JSON.stringify(root)}, o(40, ['T-2', 'T-1']));
postOverlaps(${JSON.stringify(root)}, o(40, ['T-1', 'T-3']));
console.log('done');`, { AGENT_EVENTS_FILE: evf, STUDIO_TELEMETRY: '' });
    const n = fs.existsSync(evf) ? fs.readFileSync(evf, 'utf8').split('\n').filter((l) => /"hotspot\.overlap"/.test(l)).length : -1;
    return [/done/.test(r.out) && n === 2, JSON.stringify({ n, out: r.out.slice(-300) })];
  });

  await guard('2.80 (d) #8c: a watch.report that says the same again goes through emitOnChange (hourly at most; digits in the words do not make it new), so a standing finding is not one event per pass (fails on 2.79.2: emitEvent on every pass)', async () => {
    const src = fs.readFileSync(path.join(dir, 'harness', 'watch.mjs'), 'utf8').replace(/\r\n/g, '\n');
    return [/emitOnChange\(\{ type: 'watch\.report'[^\n]*repeatMin: 60/.test(src) && !/emitEvent\(\{ type: 'watch\.report'/.test(src), 'watch.mjs'];
  });
}
