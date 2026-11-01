/**
 * qa/selftest-259i.mjs — P-067 (crew P-037): an owner-approved step writes agy's headless allow-rules.
 *   Antigravity CLI (agy) soft-denies shell commands in headless mode unless its settings.json allows them; Claude
 *   gets the harness list on its command line, agy got nothing. `npm run agent -- allow agy` translates the list
 *   (harness/allowlist.mjs) into agy rules and merges them into agy's user-level settings file, with the owner's OK.
 *   Every check runs with a fake HOME and USERPROFILE (no real agy, no real settings touched):
 *   - --dry-run prints the target file and every rule and writes nothing;
 *   - the user-level file is written only with --scope user (agy has no project-level file), only with --by, and
 *     never with an agent's name or from inside a launched session;
 *   - a real run keeps the user's other keys and rules, backs the file up, and adds only the harness rules;
 *   - a second run adds nothing (no write, no second backup); a file that isn't plain JSON is left alone;
 *   - no skip-all setting is ever written; the Windows (regex) rule refuses chained commands;
 *   - `npm run agent -- start … --tool agy` prints one line naming the command while nothing is enrolled, and
 *     still starts; once enrolled it doesn't.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Spelled out here so this file also runs (and fails) against the code before P-067.
const HINT = 'agy has no allow-rules: run npm run agent -- allow agy --by <owner> (dry-run first)';
const REL = ['.gemini', 'antigravity-cli', 'settings.json'];

export async function selftest259I({ dir, run, report, tmpRoot }) {
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const u = (p) => JSON.stringify(pathToFileURL(path.join(dir, p)).href);
  const read = (rel) => { try { return fs.readFileSync(path.join(dir, rel), 'utf8'); } catch { return ''; } };
  const events = () => read('.studio/events.jsonl').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } });
  let n = 0;
  const home = (settings = null) => {
    const h = path.join(tmpRoot, `home-259i-${n++}`);
    fs.mkdirSync(h, { recursive: true });
    if (settings !== null) {
      fs.mkdirSync(path.join(h, ...REL.slice(0, -1)), { recursive: true });
      fs.writeFileSync(path.join(h, ...REL), settings);
    }
    return h;
  };
  const fileOf = (h) => path.join(h, ...REL);
  const backups = (h) => { try { return fs.readdirSync(path.dirname(fileOf(h))).filter((f) => f.startsWith('settings.json.bak-')); } catch { return []; } };
  const bytes = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
  // A person's shell: no launched-session variables.
  const as = (h, extra = {}) => ({ HOME: h, USERPROFILE: h, STUDIO_ROLE: '', STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', ...extra });
  const allow = (h, args, extra) => run(dir, `node harness/agent.mjs allow agy ${args}`, as(h, extra));
  const { ALLOWED } = await import(pathToFileURL(path.join(dir, 'harness', 'allowlist.mjs')).href);
  const prefixes = ALLOWED.map(([, p]) => p.replace(/\s*\*$/, '').trim());
  const hasAll = (allowList) => prefixes.every((p) => allowList.includes(`command(${p})`) && allowList.some((r) => r.startsWith(`command(regex:^${p}`)));
  const userSettings = '{\n    "colorScheme": "dark",\n    "toolPermission": "request-review",\n    "trustedWorkspaces": ["/work/a"],\n    "permissions": {\n        "allow": ["command(Get-ChildItem)"],\n        "deny": ["command(rm -rf)"],\n        "ask": ["execute_url(example.com)"]\n    }\n}\n';

  // ---------- --dry-run: the target and the rules, nothing written ----------
  {
    const h1 = home();
    const d1 = allow(h1, '--dry-run');
    const h2 = home(userSettings);
    const d2 = allow(h2, '--dry-run --scope user');
    const o1 = out(d1);
    const listed = prefixes.filter((p) => !(o1.includes(`command(${p})`) && o1.includes(`command(regex:^${p}`)));
    report('P-067 (crew P-037): npm run agent -- allow agy --dry-run prints agy\'s settings file (the user-level one) and an agy rule for every entry of the harness allowlist (a word-prefix rule and a regex rule), and writes nothing, with or without a settings file there',
      d1.status === 0 && d2.status === 0 && o1.includes(fileOf(h1)) && out(d2).includes(fileOf(h2)) && !listed.length && !fs.existsSync(path.join(h1, '.gemini')) && bytes(fileOf(h2)) === userSettings && !backups(h2).length,
      `missing rules: ${listed.join(', ')}\n${o1.slice(-1500)}\n--- with a file ---\n${out(d2).slice(-600)}`);
  }

  // ---------- the user-level file needs --scope user, --by, and a person ----------
  // 2.58.3 (M3): without --scope the rules go to the studio's own .studio/agy-settings.json (agy --settings), so
  // that case now succeeds there, and the user file is still untouched.
  {
    const h = home(userSettings);
    const studioFile = path.join(dir, '.studio', 'agy-settings.json');
    const noScope = allow(h, '--by owner-ana');
    const toStudio = noScope.status === 0 && fs.existsSync(studioFile);
    fs.rmSync(studioFile, { force: true });
    const tries = {
      ...(toStudio ? {} : { noScope }),
      project: allow(h, '--by owner-ana --scope project'),
      noBy: allow(h, '--scope user'),
      agentName: allow(h, '--by builder-1 --scope user'),
      launched: allow(h, '--by owner-ana --scope user', { STUDIO_ROLE: 'builder' }),
    };
    const bad = Object.entries(tries).filter(([, r]) => r.status === 0).map(([k]) => k);
    const scopeSaid = toStudio && /--scope user/.test(out(tries.project));
    report('P-067: agy\'s user-level settings are written only with --scope user said out loud (agy has no project-level file: --scope project writes nothing and says so; since 2.58.3 the default writes the studio\'s .studio/agy-settings.json instead), only with --by <owner>, and never under an agent\'s name or from inside a launched session',
      !bad.length && scopeSaid && bytes(fileOf(h)) === userSettings && !backups(h).length,
      `not refused: ${bad.join(', ') || 'none'}; default to the studio file: ${toStudio}; scope named: ${scopeSaid}\n${out(noScope).slice(-300)}\n${Object.entries(tries).map(([k, r]) => `${k} (${r.status}): ${out(r).slice(-300)}`).join('\n')}`);
  }

  // ---------- a real run merges, keeps everything else, backs up; a second run adds nothing ----------
  const enrolledHome = home(userSettings);
  {
    const h = enrolledHome;
    const r = allow(h, '--by owner-ana --scope user');
    let s = {};
    try { s = JSON.parse(bytes(fileOf(h))); } catch {}
    const a = s.permissions?.allow || [];
    const baks = backups(h);
    const ev = events().filter((e) => e.type === 'agy.allow_enrolled').pop();
    const kept = s.colorScheme === 'dark' && s.toolPermission === 'request-review' && JSON.stringify(s.trustedWorkspaces) === '["/work/a"]' && a[0] === 'command(Get-ChildItem)' && JSON.stringify(s.permissions?.deny) === '["command(rm -rf)"]' && JSON.stringify(s.permissions?.ask) === '["execute_url(example.com)"]';
    report('P-067: a real run (--by <owner> --scope user) merges the harness rules into an existing settings.json: the user\'s other keys and their allow, ask and deny rules stay as they were, the old file is kept as settings.json.bak-<time>, and an event names who approved it',
      r.status === 0 && kept && hasAll(a) && baks.length === 1 && bytes(path.join(path.dirname(fileOf(h)), baks[0] || 'x')) === userSettings && ev?.agent === 'owner-ana' && ev?.meta?.by === 'owner-ana',
      `kept: ${kept}; all rules: ${hasAll(a)}; backups: ${baks.join(', ')}; event: ${JSON.stringify(ev || null).slice(0, 300)}\n${out(r).slice(-600)}\n${bytes(fileOf(h))?.slice(0, 800)}`);
    const before = bytes(fileOf(h));
    const again = allow(h, '--by owner-ana --scope user');
    report('P-067: enrolling agy twice adds nothing: the second run says so, leaves the file byte for byte, and makes no second backup',
      r.status === 0 && again.status === 0 && /nothing added/i.test(out(again)) && bytes(fileOf(h)) === before && backups(h).length === 1 && hasAll(a),
      `${out(again).slice(-400)}\nbackups: ${backups(h).join(', ')}`);
  }

  // ---------- no skip-all setting, ever; a file that isn't plain JSON is left alone ----------
  {
    const h = home();
    const r = allow(h, '--by owner-ana --scope user');
    const text = bytes(fileOf(h)) || '';
    let s = {};
    try { s = JSON.parse(text); } catch {}
    const merged = bytes(fileOf(enrolledHome)) || '';
    const skip = /always-proceed|dangerously|command\(\*\)|regex:\.\*|"agentMode"/.test(text + merged) || /"toolPermission"\s*:\s*"(?!request-review)/.test(merged);
    const onlyAllow = JSON.stringify(Object.keys(s)) === '["permissions"]' && JSON.stringify(Object.keys(s.permissions || {})) === '["allow"]' && hasAll(s.permissions?.allow || []);
    const jsonc = '{\n  // my agy settings\n  "colorScheme": "light"\n}\n';
    const hc = home(jsonc);
    const c = allow(hc, '--by owner-ana --scope user');
    report('P-067: enrolment never writes a skip-all setting (no always-proceed, --dangerously-skip-permissions, command(*) or toolPermission change): a fresh settings file holds only permissions.allow with the harness rules; a file that isn\'t plain JSON is left untouched (no backup) and the rules are printed to add by hand',
      r.status === 0 && !skip && onlyAllow && c.status !== 0 && bytes(fileOf(hc)) === jsonc && !backups(hc).length && out(c).includes('command(npm)'),
      `skip-all text: ${skip}; only allow: ${onlyAllow}\n${text.slice(0, 500)}\n--- jsonc (${c.status}) ---\n${out(c).slice(-500)}`);
  }

  // ---------- the regex rule (for Windows, where a line can't be split into words) refuses chains ----------
  {
    const f = path.join(dir, '.probe-259i-regex.mjs');
    fs.writeFileSync(f, `import { agyRules } from ${u('harness/agy-allow.mjs')};
const re = (p) => new RegExp(agyRules().find((r) => r.startsWith('command(regex:^' + p + '(')).slice('command(regex:'.length, -1));
const t = (p, line) => re(p).test(line);
console.log(JSON.stringify({
  yes: [t('npm', 'npm run verify'), t('npm', 'npm test 2>&1'), t('npm', 'npm'), t('git status', 'git status --short'), t('node', 'node harness/task.mjs list')],
  no: [t('npm', 'npm run x && rm -rf y'), t('npm', 'npm run x; del y'), t('npm', 'npm run a | tail'), t('npm', 'npm $(whoami)'), t('npm', 'npm \`id\`'), t('npm', 'npmx'), t('git status', 'git push')],
}));`);
    const r = run(dir, `node ${path.basename(f)}`);
    let v = {};
    try { v = JSON.parse(String(r.stdout).trim().split('\n').pop()); } catch {}
    report('P-067: the regex form of each rule (agy\'s docs ask for regex: on Windows) matches the allowed command with any arguments, a redirect such as 2>&1 included, and refuses a chained, piped or substituted second command and other programs',
      Array.isArray(v.yes) && v.yes.every(Boolean) && Array.isArray(v.no) && v.no.every((x) => !x), `${JSON.stringify(v)}\n${out(r).slice(-500)}`);
  }

  // ---------- the launcher says what's missing, once, and still starts ----------
  {
    const env = { STUDIO_BUILDER_CMD: 'node -e 0', STUDIO_HEARTBEAT_SEC: '1' };
    const bare = home();
    const s1 = run(dir, 'node harness/agent.mjs start --role builder --agent agy-hint-1 --tool agy --model m-1', as(bare, env));
    const s2 = run(dir, 'node harness/agent.mjs start --role builder --agent agy-hint-2 --tool agy --model m-1', as(enrolledHome, env));
    const lines1 = String(s1.stdout).split(/\r?\n/).filter((l) => l === HINT);
    const started = events().some((e) => e.type === 'agent.session.start' && e.agent === 'agy-hint-1');
    report('P-067: npm run agent -- start … --tool agy prints one line, "agy has no allow-rules: run npm run agent -- allow agy --by <owner> (dry-run first)", while nothing is enrolled, and starts the agent anyway; with the rules enrolled it prints nothing',
      s1.status === 0 && lines1.length === 1 && started && s2.status === 0 && !out(s2).includes('allow-rules'),
      `hint lines: ${lines1.length}; started: ${started}\n${out(s1).slice(-600)}\n--- enrolled ---\n${out(s2).slice(-400)}`);
  }
}
