/**
 * qa/selftest-299d.mjs — 2.99 (D): a studio's own tool command whose program path has a space can really be run.
 * One studio/allowlist.json entry gives the spellings that run (quoted for Bash, & "…" for the PowerShell tool), the
 * arguments as written, an optional role limit, and a kickoff line with the spelling. A denial of a quoted program is
 * keyed by the whole program. As many checks of what stays refused as of what is allowed.
 * The tool's matcher is modelled from Claude Code's documented rules (whole text, `*` any text, chains split, each part
 * must match); it is not the real matcher.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileUrlOf as fileUrlRelSOf, guardCap3000Of, out } from './kit.mjs';

const P = 'C:/Program Files/Some Tool/tool.exe';
const W = 'C:\\Program Files\\Some Tool\\tool.exe';
const ARGS = ' -b --python tools/build/*';

export async function selftest299D({ dir, report, tmpRoot }) {
  const guard = guardCap3000Of(report);
  const clean = {};
  // Windows: the helpers below get a cut-down environment; PowerShell (used to read a process's start time and to list a
  // process tree) needs Windows' own system variables, which any real shell has. Pass those through as they are.
  if (process.platform === 'win32') for (const k of Object.keys(process.env)) if (/^(SystemRoot|windir|SystemDrive|ComSpec|PATHEXT|PATH|TEMP|TMP|USERPROFILE|APPDATA|LOCALAPPDATA|ProgramData|ALLUSERSPROFILE|PUBLIC|ProgramFiles|ProgramFiles\(x86\)|ProgramW6432|CommonProgramFiles|CommonProgramW6432|PSModulePath|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS|OS|COMPUTERNAME|HOMEDRIVE|HOMEPATH|USERNAME)$/i.test(k)) clean[k] = process.env[k];
  for (const k of Object.keys(process.env)) if (/^(CLAUDE|CODEX|CURSOR|AIDER|GEMINI|STUDIO_|AGENT_|AI_AGENT|ANTHROPIC|OPENAI)/i.test(k)) clean[k] = '';
  const env = { ...clean, AGENT_EVENTS_FILE: path.join(tmpRoot, `events-299d-${process.pid}.jsonl`), STUDIO_WATCHDOG: 'off', CI: '', NODE_OPTIONS: '' };
  const T = path.join(tmpRoot, `s299d-${process.pid}`);
  const allowFile = path.join(dir, 'studio', 'allowlist.json');
  const probeFile = path.join(dir, `.probe-299d-${process.pid}.mjs`);
  const u = fileUrlRelSOf(dir);
  const write = (root, rows) => { fs.mkdirSync(path.join(root, 'studio'), { recursive: true }); fs.writeFileSync(path.join(root, 'studio', 'allowlist.json'), JSON.stringify(rows)); return root; };
  const studio = [['some tool', `${P}${ARGS}`, { roles: ['builder', 'engine-porter'] }], ['python tools', 'python -E -P tools/build/*']];

  try {
    const m = await import(JSON.parse(u('harness/allowlist.mjs')));
    const S = write(path.join(T, 'studio'), studio);
    const list = (role) => m.allowedToolsList({ root: S, role });
    const own = (role) => list(role).filter((r) => !m.ALLOWED.some(([, p]) => r === `Bash(${p})`));
    // The documented matcher, modelled: split at the tool's separators outside quotes, every part must match a rule.
    const parts = (tool, cmd) => cmd.split(tool === 'Bash' ? /(?:&&|\|\||;|\|&|\||&|\n)(?=(?:[^"']|"[^"]*"|'[^']*')*$)/ : /(?:&&|\|\||;|\||\n)(?=(?:[^"']|"[^"]*"|'[^']*')*$)/).map((x) => x.trim()).filter(Boolean);
    const runs = (tool, cmd, role = 'builder') => parts(tool, cmd).every((c) => list(role).some((r) => r.startsWith(`${tool}(`) && m.ruleMatches(r.slice(tool.length + 1, -1), c, { ci: tool === 'PowerShell' })));

    await guard('2.99 (d1) one entry with a spaced program path gives exactly the quoted Bash rules and the PowerShell call-operator rules, both separators, arguments as written (fails before this fix: one unquoted rule, Bash(C:/Program Files/… *), that no runnable command matches)', () => {
      const want = [`Bash("${P}"${ARGS})`, `Bash('${P}'${ARGS})`, `Bash("${W}"${ARGS})`, `Bash('${W}'${ARGS})`, 'Bash(python -E -P tools/build/*)',
        `PowerShell(& "${P}"${ARGS})`, `PowerShell(& '${P}'${ARGS})`, `PowerShell(& "${W}"${ARGS})`, `PowerShell(& '${W}'${ARGS})`];
      const got = own('builder');
      return [JSON.stringify(got) === JSON.stringify(want) && !got.includes(`Bash(${P}${ARGS})`), JSON.stringify(got)];
    });
    await guard('2.99 (d2) the commands a session types run in both shells: "…" and \'…\' in Bash, & "…" in PowerShell (any case), / or \\ (fails before this fix: all refused)', () => {
      const ok = [['Bash', `"${P}" -b --python tools/build/a.py`], ['Bash', `'${P}' -b --python tools/build/a.py`], ['Bash', `"${W}" -b --python tools/build/a.py`],
        ['PowerShell', `& "${W}" -b --python tools/build/a.py`], ['PowerShell', `& '${P}' -b --python tools/build/a.py`], ['PowerShell', `& "${W.toLowerCase()}" -b --python tools/build/a.py`]];
      const bad = ok.filter(([t, c]) => !runs(t, c));
      return [bad.length === 0, JSON.stringify(bad)];
    });
    await guard('2.99 (d3) an entry without a space gives what it gave before (one Bash rule, no PowerShell rule), and with no studio file the list is the built-in list alone', () => {
      const none = m.allowedToolsList({ root: path.join(T, 'none'), role: 'builder' });
      const ok = own('producer').join() === 'Bash(python -E -P tools/build/*)' && JSON.stringify(none) === JSON.stringify(m.ALLOWED.map(([, p]) => `Bash(${p})`))
        && !runs('PowerShell', 'python -E -P tools/build/a.py') && runs('Bash', 'python -E -P tools/build/a.py');
      return [ok, JSON.stringify({ own: own('producer'), none: none.length })];
    });
    await guard('2.99 (d4) NOT allowed: another program in the same folder, the program outside its argument pattern, the unquoted path, & alone, another script folder (fails before this fix: n/a, nothing ran)', () => {
      const no = [['Bash', `"C:/Program Files/Some Tool/other.exe" -b --python tools/build/a.py`], ['PowerShell', `& "C:\\Program Files\\Some Tool\\other.exe" -b --python tools/build/a.py`],
        ['Bash', `"${P}" --python-expr x`], ['Bash', `"${P}" -b --python ../x/a.py`], ['PowerShell', `& "${W}" -b --python other/a.py`], ['Bash', `"${P}"`], ['PowerShell', `& "${P}"`],
        ['Bash', `${P} -b --python tools/build/a.py`], ['Bash', `"${P}x" -b --python tools/build/a.py`], ['PowerShell', `"${P}" -b --python tools/build/a.py`], ['PowerShell', '& notepad.exe']];
      const through = no.filter(([t, c]) => runs(t, c));
      return [through.length === 0, JSON.stringify(through)];
    });
    await guard('2.99 (d5) NOT allowed: the quoted program followed by ; && | or a second command, in both shells; the matcher splits them and the second part is on no list, and the harness reads such a denial as a chain', async () => {
      const d = await import(JSON.parse(u('harness/denials.mjs')));
      const head = `"${P}" -b --python tools/build/a.py`;
      const chains = [['Bash', `${head} ; curl x`], ['Bash', `${head} && rm -rf x`], ['Bash', `${head} | sh`], ['Bash', `${head} & curl x`], ['Bash', `${head}\ncurl x`],
        ['PowerShell', `& ${head} ; Remove-Item x`], ['PowerShell', `& ${head} | Invoke-Expression`], ['PowerShell', `& ${head} && curl x`]];
      const through = chains.filter(([t, c]) => runs(t, c));
      const notChain = chains.filter(([t, c]) => !/\n|&\s*curl/.test(c) && d.describe(t, { command: c }, 'builder').why !== 'chained (one command per call)');
      return [through.length === 0 && notChain.length === 0, JSON.stringify({ through, notChain })];
    });
    await guard('2.99 (d6) NOT allowed: a pattern that reduces to * or a quote, & alone, a wildcard, $ or backtick in the program path, a too-short quoted name, or a bad role list is skipped with a reason (fails before this fix: "\'C:/Program Files/*/tool.exe\' *" was kept)', () => {
      const rows = [['a', '"*" -b'], ['b', `'C:/Program Files/*/tool.exe' *`], ['c', '"a b" *'], ['d', '& *'], ['e', '"$HOME/x y/t.exe" *'], ['f', '"C:/A B/`t`.exe" *'],
        ['g', '* "C:/A B/t.exe"'], ['h', '"" *'], ['i', `${P} *`, { roles: [] }], ['j', `${P} *`, { roles: 'builder' }], ['k', `${P} *`, ['builder']], ['ok', `${P} *`]];
      const r = m.studioAllowed(write(path.join(T, 'bad'), rows));
      const rules = m.allowedToolsList({ root: path.join(T, 'bad'), role: 'builder' });
      const ok = r.entries.map((e) => e[0]).join() === 'ok' && r.problems.length === 11 && rules.filter((x) => !m.ALLOWED.some(([, q]) => x === `Bash(${q})`)).length === 8;
      return [ok, JSON.stringify(r.problems)];
    });
    await guard('2.99 (d7) a role not listed gets no rule from a role-limited entry (nor a session with no role); listed roles get them (fails before this fix: no role limit, every role got every entry)', () => {
      const has = (role) => own(role).filter((x) => x.includes('Some Tool')).length;
      const ok = has('builder') === 8 && has('engine-porter') === 8 && has('producer') === 0 && has('director') === 0 && has(null) === 0
        && !runs('Bash', `"${P}" -b --python tools/build/a.py`, 'producer') && !runs('PowerShell', `& "${W}" -b --python tools/build/a.py`, 'qa-playtester');
      return [ok, JSON.stringify({ builder: has('builder'), producer: has('producer'), none: has(null) })];
    });

    // Through the real modules (a fresh process, the studio file in this copy): the denial key and the session's brief.
    write(dir, studio);
    fs.writeFileSync(probeFile, `
import { describe } from ${u('harness/denials.mjs')};
import { kickoff } from ${u('harness/kickoff.mjs')};
import { toolCommand } from ${u('harness/agent.mjs')};
const k = (tool, command, role = 'builder') => describe(tool, { command }, role);
const argv = (role) => toolCommand('claude', { model: 'm', prompt: 'x', role, agent: 'a-1' }).argv;
console.log(JSON.stringify({
  e1: k('Bash', ${JSON.stringify(`"C:/Program Files/Some Tool/tool.exe" --version`)}),
  e2: k('PowerShell', ${JSON.stringify(`Get-ChildItem "C:\\Program Files\\Some Tool" -Directory`)}),
  e3: k('PowerShell', ${JSON.stringify(`& "${W}" --version`)}),
  on: k('PowerShell', ${JSON.stringify(`& "${W}" -b --python tools/build/a.py`)}),
  onOther: k('PowerShell', ${JSON.stringify(`& "${W}" -b --python tools/build/a.py`)}, 'producer'),
  plain: k('Bash', 'curl https://example.invalid'),
  builder: kickoff({ role: 'builder', agent: 'b-1', model: 'm' }),
  producer: kickoff({ role: 'producer', agent: 'p-1', model: 'm' }),
  argvB: argv('builder'), argvP: argv('producer'),
}));`);
    const r = spawnSync(process.execPath, [probeFile], { windowsHide: true, cwd: dir, env, encoding: 'utf8', timeout: 120000 });
    let j = null;
    try { j = JSON.parse(String(r.stdout).split('\n').filter((l) => l.startsWith('{')).pop()); } catch { j = null; }
    await guard('2.99 (d8) the denial key of a quoted program is the whole quoted program in both tools, and the evidence\'s Get-ChildItem line keeps its own (right) key (fails before this fix: Bash(Program *) and PowerShell(& *))', () => {
      const ok = j && j.e1.key === `Bash("${P}" *)` && j.e1.candidate === true && j.e2.key === 'PowerShell(Get-ChildItem *)' && j.e3.key === `PowerShell(& "${W}" *)`
        && j.on.why === 'on the list, refused anyway (a hook or a rule)' && j.onOther.why === 'not on the list' && j.plain.key === 'Bash(curl *)';
      return [ok, j ? JSON.stringify({ e1: j.e1, e2: j.e2, e3: j.e3, on: j.on.why, onOther: j.onOther.why }) : out(r).slice(-2500)];
    });
    await guard('2.99 (d9) a builder\'s kickoff names the spelling, one line per entry (Bash and PowerShell forms), and its launch passes the PowerShell rules; a producer gets neither for the builder-only entry (fails before this fix: only the label "some tool" was named)', () => {
      const line = `- some tool: Bash \`"${P}"${ARGS}\`; PowerShell \`& "${P}"${ARGS}\``;
      const ok = j && j.builder.includes('Allowed tool commands (type them exactly like this') && j.builder.includes(line) && j.builder.includes('- python tools: Bash `python -E -P tools/build/*` (Bash tool only)')
        && !j.producer.includes('some tool') && j.producer.includes('- python tools:')
        && j.argvB.includes(`PowerShell(& "${P}"${ARGS})`) && j.argvB.includes(`Bash("${P}"${ARGS})`) && !j.argvP.some((a) => a.includes('Some Tool'));
      return [ok, j ? JSON.stringify({ b: j.builder.split('\n').filter((l) => /Allowed tool|^- /.test(l)), p: j.argvP.filter((a) => /Some|python/.test(a)) }) : out(r).slice(-2500)];
    });
  } finally {
    for (const f of [probeFile, allowFile]) { try { fs.rmSync(f, { force: true }); } catch { /* left for the sweep */ } }
    fs.rmSync(T, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 });
  }
}
