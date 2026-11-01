/**
 * qa/selftest-2583p.mjs — 2.58.3 (P-069): the profile check before a launch.
 *
 * In a crew run the Producer and Director were refused 62 times: `claude -p --permission-mode …` was read as profile
 * "--permission-mode" (claude's -p is --print), and with no profiles set up every builder "used" the one account, so
 * a planning role was never allowed to start while any builder ran.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function selftest2583P({ dir, run, report, tmpRoot }) {
  const u = (rel) => JSON.stringify(pathToFileURL(path.join(dir, rel)).href);
  let n = 0;
  const probe = (code, env = {}) => {
    const file = path.join(tmpRoot, `probe-2583p-${process.pid}-${n += 1}.mjs`);
    fs.writeFileSync(file, code);
    const r = run(dir, `node "${file}"`, env);
    try { return JSON.parse(String(r.stdout).trim().split('\n').pop()); } catch { return { _raw: `${r.stdout}${r.stderr}`.slice(-1500) }; }
  };
  const p = probe(`import { profileOf, profileGuard } from ${u('harness/profile-guard.mjs')};
const builder = [{ agent: 'builder-1', role: 'builder', profile: 'default' }];
console.log(JSON.stringify({
  claude: profileOf('producer', 'claude -p --permission-mode acceptEdits --allowedTools Bash(node *)', {}),
  claudeCmd: profileOf('director', 'C:\\\\tools\\\\claude.cmd -p --model m', {}),
  agy: profileOf('builder', 'agy -p "do the task" --print-timeout 900s', {}),
  claudeProfile: profileOf('builder', 'claude --profile p2 -p', {}),
  hermes: profileOf('director', 'hermes -p gemini-b chat', {}),
  flag: profileOf('director', 'tool -p --model x', {}),
  single: profileGuard({ role: 'producer', profile: 'default', running: builder, env: {} }),
  singleDir: profileGuard({ role: 'director', profile: 'default', running: builder, env: {} }),
  configured: profileGuard({ role: 'producer', profile: 'b2', running: [{ agent: 'builder-3', role: 'builder', profile: 'b2' }], env: { STUDIO_SHARED_PROFILES: 'shared' } }),
  ownSet: profileGuard({ role: 'producer', profile: 'default', running: builder, env: { STUDIO_BUILDER_PROFILE: 'default' } }),
  shared: profileGuard({ role: 'director', profile: 'pool', running: [], env: { STUDIO_SHARED_PROFILES: 'pool' } }),
}));`);
  report('2.58.3 (P-069): claude\'s and agy\'s -p is --print, not a profile: `claude -p --permission-mode …` (also claude.cmd with a path) is the default profile; --profile still names one; another tool\'s -p <name> still does; a flag is never a profile',
    p.claude === 'default' && p.claudeCmd === 'default' && p.agy === 'default' && p.claudeProfile === 'p2' && p.hermes === 'gemini-b' && p.flag === 'default', JSON.stringify(p));
  report('2.58.3 (P-069): with no profiles set up (one account), a Producer or Director starts while a builder runs; once profiles are set up, a builder\'s profile and a shared one still refuse it',
    p.single?.ok === true && p.singleDir?.ok === true && p.configured?.ok === false && p.ownSet?.ok === false && p.shared?.ok === false, JSON.stringify(p));
}
