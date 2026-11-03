/**
 * qa/selftest-275h.mjs — 2.75.0 (helper h): the War Room's visual redo, the parts a script can check.
 *   tabs       every view (Control room, Studio floor, Game plan, Assets, Arcade, While you were away) carries the same tab
 *              bar in the same order, the current view marked aria-current, every tab a .switch with data-to
 *   tokens     one design system: the --ds-* tokens with a light set under prefers-color-scheme, the six status colors
 *              (go, wait, stop, hold, info, off), reduced motion honoured, and no web font or outside stylesheet/script
 *   plates     the Studio floor's name plates: a short name over the role, never a cut "builde…"; a bare number keeps
 *              the whole name; the full name stays on the plate's title
 *   floor      who is on the Studio floor (harness/hud.mjs onFloor): an agent whose session ended, or whose last step was
 *              task.done with nothing claimed, or idle past STUDIO_FLOOR_IDLE_MIN with nothing claimed, leaves the floor;
 *              one holding a claim, the Producer's seat and people stay; the Control room's list still has everyone
 *   key        each state badge has its entry in the floor's key, and the page removes a departing avatar (reduced
 *              motion: at once)
 * Each check fails on 2.74.0 (none of these exist there).
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import vm from 'node:vm';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export async function selftest275H({ dir, run, report, tmpRoot, root }) {
  const harnessRoot = root || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  if (!fs.existsSync(path.join(dir, 'node_modules', 'typescript')) && fs.existsSync(path.join(harnessRoot, 'node_modules', 'typescript'))) {
    try { fs.rmSync(path.join(dir, 'node_modules'), { force: true }); } catch {}
    try { fs.symlinkSync(path.join(harnessRoot, 'node_modules'), path.join(dir, 'node_modules'), 'junction'); } catch {}
  }
  void run;
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const gEnv = () => { const e = { ...process.env, ...ident }; for (const k of Object.keys(e)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|CONFIG.*|NO_REPLACE_OBJECTS)$/.test(k)) delete e[k]; return e; };
  const g = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8', env: gEnv(), windowsHide: true });
  const guard = async (name, fn) => { try { const [ok, detail] = await fn(); report(name, Boolean(ok), detail); } catch (e) { report(name, false, e.stack || String(e)); } };
  const base = {
    STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_WATCH_INTERVAL: '0', STUDIO_MAIN_ROOT: '', STUDIO_LOCK_OWNER: '', STUDIO_ROLE: '', STUDIO_AGENT: '',
    STUDIO_PRODUCER_NAME: '', STUDIO_FLOOR_IDLE_MIN: '', CLAUDECODE: '', AI_AGENT: '', CODEX_SANDBOX: '', GEMINI_CLI: '', NODE_OPTIONS: '', STUDIO_MACHINE_SCAN: 'off', HUB_TOKEN: '', HUB_HOST: '', ...ident,
  };
  const made = [];
  const kids = [];
  const nm = path.join(dir, 'node_modules');
  const studio = (name) => {
    const S = path.join(tmpRoot, `275h-${name}-${process.pid}`);
    fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
    if (fs.existsSync(nm)) { try { fs.symlinkSync(fs.realpathSync(nm), path.join(S, 'node_modules'), 'junction'); } catch {} }
    for (const x of ['.studio/agents', '.studio/locks', '.studio/train', '.studio/supervisor.json', 'studio/divisions.json']) fs.rmSync(path.join(S, x), { recursive: true, force: true });
    const ev = path.join(S, '.studio', 'events-275h.jsonl');
    fs.mkdirSync(path.dirname(ev), { recursive: true }); fs.writeFileSync(ev, '');
    g(S, ['init', '-q', '-b', 'main']); g(S, ['add', '-A']); g(S, ['commit', '-qm', 'studio', '--no-verify']);
    made.push(S);
    return { S, ev, env: { ...process.env, ...base, AGENT_EVENTS_FILE: ev } };
  };
  const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
  const get = (port, p) => new Promise((resolve) => { http.get({ host: '127.0.0.1', port, path: p }, (res) => { let t = ''; res.on('data', (d) => { t += d; }); res.on('end', () => resolve({ status: res.statusCode, text: t })); }).on('error', (e) => resolve({ status: 0, text: String(e) })); });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  try {
    const page = fs.readFileSync(path.join(dir, 'hub', 'v3', 'index.html'), 'utf8');
    const VIEWS = ['ops', 'tycoon', 'plan', 'assets', 'arcade', 'away'];
    const ORDER = 'ops,tycoon,plan,assets,arcade';
    await guard('275h tabs: every view has the same tab bar (Control room, Studio floor, Game plan, Assets, Arcade), the current view marked aria-current, each tab a .switch with data-to (fails on 2.74.0: each view had its own list of other views)', () => {
      const seen = VIEWS.map((v) => {
        const start = page.indexOf(`<div id="${v}" class="skin">`);
        const nav = /<nav class="tabs" aria-label="Views">([\s\S]*?)<\/nav>/.exec(page.slice(start, start + 4000));
        const tabs = nav ? [...nav[1].matchAll(/<button class="switch tab" type="button" data-to="([a-z]+)"( aria-current="page")?>([^<]+)</g)].map((m) => ({ to: m[1], cur: Boolean(m[2]), label: m[3] })) : [];
        return { v, order: tabs.map((t) => t.to).join(','), cur: tabs.filter((t) => t.cur).map((t) => t.to).join(','), labels: tabs.map((t) => t.label).join('|') };
      });
      const ok = seen.every((x) => x.order === ORDER && x.cur === (x.v === 'away' ? '' : x.v) && x.labels === 'Control room|Studio floor|Game plan|Assets|Arcade');
      return [ok && !/<button class="switch" data-to=/.test(page), JSON.stringify(seen)];
    });
    await guard('275h tokens: one design system: --ds-* tokens with a light set, six status colors used by the badges, reduced motion honoured, no web font or outside stylesheet or script (fails on 2.74.0: no tokens)', () => {
      const light = /@media \(prefers-color-scheme: light\) \{\s*:root \{[^}]*--ds-bg:/.test(page);
      const status = ['go', 'wait', 'stop', 'hold', 'info', 'off'].every((k) => new RegExp(`--ds-${k}: #[0-9a-f]{6}`).test(page));
      const outside = /<(link|script)\b[^>]*\b(href|src)="https?:/i.test(page) || /fonts\.(googleapis|gstatic)\.com/.test(page) || /@import\s+url\(\s*['"]?https?:/i.test(page);
      return [light && status && /@media \(prefers-reduced-motion: reduce\)/.test(page) && !outside && /--ds-display:[^;]*Bahnschrift/.test(page), JSON.stringify({ light, status, outside })];
    });
    await guard('275h plates: a short name over the role ("builder-s12" is s12 over builder), a bare number keeps the whole name (prod-1), nothing is cut into "builde…", the full name stays on the title (fails on 2.74.0: the plate was the name, cut by CSS)', () => {
      const m = /\/\*\* \{ short, role, full \} for a desk plate[\s\S]*?\n {2}function plate\(a\) \{[\s\S]*?\n {2}\}\n/.exec(page);
      if (!m) return [false, 'no plate() in the page'];
      const plate = vm.runInNewContext(`${m[0]}; plate`, {});
      const r = [plate({ name: 'builder-s12', role: 'builder' }), plate({ name: 'prod-1', role: 'producer' }), plate({ name: 'hatch', kind: 'human' }), plate({ name: 'qa-playtester', role: 'qa-playtester', room: 'qa' }), plate({ name: 'unknown', room: 'engineering' }), plate({ name: 'a-very-long-agent-name-x7', role: 'builder', task: 'T-9' })];
      const ok = r[0].short === 's12' && r[0].role === 'builder' && r[1].short === 'prod-1' && r[2].role === 'you' && r[3].short === 'qa-playtester' && r[3].role === 'qa' && r[4].short === 'unknown' && r[4].role === 'agent'
        && r.every((x) => x.short.length <= 13 && x.role.length <= 14 && !/…/.test(x.short)) && /a-very-long-agent-name-x7, builder, on T-9/.test(r[5].full);
      return [ok, JSON.stringify(r)];
    });
    await guard('275h key: every state badge has its entry in the Studio floor\'s key, and a departing avatar is removed (at once under reduced motion) (fails on 2.74.0: no badges, no key, departed agents stayed)', () => {
      const states = (/const STATE = \{([^\n]*)\};/.exec(page) || [])[1] || '';
      const keys = [...states.matchAll(/'?([a-z-]+)'?: \['/g)].map((x) => x[1]);
      const key = [...((/<ul class="statekey"[^>]*>([\s\S]*?)<\/ul>/.exec(page) || [])[1] || '').matchAll(/data-st="([a-z-]+)"/g)].map((x) => x[1]);
      const shown = ['working', 'verifying', 'on-train', 'needs-release', 'handed-back', 'stalled', 'ending', 'idle'];
      return [shown.every((k) => keys.includes(k) && key.includes(k)) && /p\.el\.classList\.add\('leaving'\)/.test(page) && /if \(g && !reduceMotion\) walkPath\(p, \[doorIn\(g\), doorOut\(g\)\]/.test(page) && /a\.onFloor !== false/.test(page),
        JSON.stringify({ keys, key })];
    });

    // ---- who is on the Studio floor ----
    {
      const { S, ev, env } = studio('floor');
      const now = Date.now();
      const iso = (ago) => new Date(now - ago).toISOString();
      const put = (list) => fs.appendFileSync(ev, list.map((e) => JSON.stringify({ id: `e${Math.random().toString(36).slice(2)}`, status: 'ok', ...e })).join('\n') + '\n');
      put([
        { ts: iso(20 * 60000), type: 'task.progress', agent: 'builder-done', task: 'T-901', msg: 'working' },
        { ts: iso(10 * 60000), type: 'task.done', agent: 'builder-done', task: 'T-901', msg: 'done' },
        { ts: iso(15 * 60000), type: 'task.progress', agent: 'builder-ended', task: 'T-902', msg: 'working' },
        { ts: iso(14 * 60000), type: 'agent.session.end', agent: 'builder-ended', msg: 'ended' },
        { ts: iso(50 * 60000), type: 'task.progress', agent: 'builder-quiet', msg: 'looked around' },
        { ts: iso(50 * 60000), type: 'task.progress', agent: 'builder-held', task: 'T-903', msg: 'long verify' },
        { ts: iso(2 * 60000), type: 'task.progress', agent: 'builder-busy', task: 'T-904', msg: 'editing' },
        { ts: iso(60 * 60000), type: 'task.done', agent: 'producer', msg: 'planned' },
      ]);
      const lock = spawnSync(process.execPath, ['harness/lock.mjs', 'claim', 'task:T-903', '--owner', 'builder-held'], { cwd: S, env, encoding: 'utf8', windowsHide: true });
      const probe = spawnSync(process.execPath, ['--input-type=module', '-e', "const { buildHudState } = await import('./harness/hud.mjs'); const s = buildHudState(); console.log(JSON.stringify(s.agents.map((a) => ({ name: a.name, onFloor: a.onFloor !== false, why: a.leftFloor || null, room: a.room }))));"], { cwd: S, env, encoding: 'utf8', windowsHide: true });
      let list = [];
      try { list = JSON.parse(String(probe.stdout).trim().split('\n').pop()); } catch {}
      const at = (n) => list.find((a) => a.name === n);
      await guard('275h floor: an agent whose session ended, or whose task is done with nothing claimed, or idle past STUDIO_FLOOR_IDLE_MIN (30) with nothing claimed, leaves the Studio floor; one holding a claim, one at work and the Producer\'s seat stay; the Control room still lists them all (fails on 2.74.0: no onFloor)', () => [
        lock.status === 0 && at('builder-done')?.onFloor === false && /task\.done/.test(at('builder-done').why) && at('builder-ended')?.onFloor === false && /agent\.session\.end/.test(at('builder-ended').why)
          && at('builder-quiet')?.onFloor === false && /idle \d+ min/.test(at('builder-quiet').why) && at('builder-held')?.onFloor === true && at('builder-busy')?.onFloor === true && at('producer')?.onFloor === true,
        `lock ${lock.status} ${lock.stderr}\n${probe.stderr.slice(-600)}\n${JSON.stringify(list)}`]);
      const probe2 = spawnSync(process.execPath, ['--input-type=module', '-e', "const { buildHudState } = await import('./harness/hud.mjs'); console.log(JSON.stringify(buildHudState().agents.filter((a) => a.name === 'builder-quiet').map((a) => a.onFloor !== false)));"], { cwd: S, env: { ...env, STUDIO_FLOOR_IDLE_MIN: '90' }, encoding: 'utf8', windowsHide: true });
      await guard('275h floor: STUDIO_FLOOR_IDLE_MIN sets how long an idle agent with nothing claimed stays on the floor: 50 min idle leaves at the default 30, stays at 90 (fails on 2.74.0)', () => [at('builder-quiet')?.onFloor === false && String(probe2.stdout).trim().split('\n').pop() === '[true]', `${probe2.stdout}${probe2.stderr}`]);
      // The served page: the same tabs and the badges' key reach the browser (the hub fills the page version in).
      const port = await freePort();
      const h = spawn(process.execPath, ['hub/server.mjs'], { cwd: S, env: { ...env, HUB_PORT: String(port) }, stdio: 'ignore', windowsHide: true });
      kids.push(h);
      let home = { status: 0, text: '' };
      for (let i = 0; i < 80; i++) { home = await get(port, '/'); if (home.status === 200) break; await sleep(150); }
      await guard('275h served page: the hub serves the redone page: the shared tabs, the floor\'s key, no web fonts (fails on 2.74.0)', () => [
        home.status === 200 && (home.text.match(/<nav class="tabs" aria-label="Views">/g) || []).length === 6 && /<ul class="statekey"/.test(home.text) && !/fonts\.googleapis/.test(home.text) && /Studio floor/.test(home.text),
        `${home.status} ${home.text.slice(0, 200)}`]);
      h.kill();
    }
  } finally {
    for (const k of kids) { try { k.kill(); } catch {} }
    await sleep(300);
    for (const S of made) { try { fs.rmSync(S, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {} }
  }
}
