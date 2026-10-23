/**
 * qa/selftest-230i.mjs — the 2.30i checks, run by qa/selftest.mjs on a copy of the repo.
 * The launcher's foreground verify after a session ends without task done, .env loading for
 * `agent start`, one NIM session at a time, and a 429 inside the stream json.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function selftest230i({ dir, run, report, tmpRoot }) {
  let n = 0;
  const u = (rel) => JSON.stringify(pathToFileURL(path.join(dir, rel)).href);
  const probe = (code, env = {}) => {
    const f = path.join(tmpRoot, `p230i-${++n}-${process.pid}.mjs`);
    fs.writeFileSync(f, code);
    const r = run(dir, `node "${f}"`, env);
    try {
      return JSON.parse(r.stdout.trim().split('\n').pop());
    } catch {
      return { error: r.stdout + r.stderr };
    }
  };

  // 1. Which ended sessions get the launcher's foreground verify.
  const cf = probe(`import { crashFinishable as f } from ${u('harness/agent.mjs')};
console.log(JSON.stringify([
  f({ code: 1, hasCommit: true }), f({ code: 0, hasCommit: true }), f({ code: 1, hasCommit: false }), f({ code: 0, hasCommit: false }),
  f({ code: 1, hasCommit: true, trouble: '429' }), f({ code: 0, hasCommit: true, reasoningOnly: true }), f({ code: 0, hasCommit: true, capped: true }),
]));`);
  report('2.30i: a crash after a commit, or a clean exit with a commit, gets the launcher verify; no commit, provider trouble, reasoning-only or a refresh do not',
    JSON.stringify(cf) === JSON.stringify([true, true, false, false, false, false, false]), JSON.stringify(cf));

  // 2. A 429 the provider put in the stream json is a rate limit; text an agent wrote about 429 is not.
  const pt = probe(`import { providerTrouble as p } from ${u('harness/agent.mjs')};
const said = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'the API returned 429 too many requests earlier' }] } });
console.log(JSON.stringify({
  err: p('{"type":"system"}\\n{"error":{"code":429,"message":"Too Many Requests"}}', 1)?.kind,
  status: p('{"type":"error","error":{"status":429}}', 1)?.kind,
  api: p('{"type":"result","is_error":true,"api_error_status":429,"result":"x"}', 1)?.kind,
  top: p('{"status":429,"detail":"rate"}', 1)?.kind,
  said: p(said + '\\n' + said, 0)?.kind ?? null,
}));`);
  report('2.30i: HTTP 429 inside the stream json counts as a rate limit; an agent mentioning 429 does not',
    pt.err === 'quota' && pt.status === 'quota' && pt.api === 'quota' && pt.top === 'quota' && pt.said === null, JSON.stringify(pt));

  // 3. .env loading: fills what is missing, never overrides the shell, returns names only.
  const envFile = path.join(tmpRoot, `env230i-${process.pid}`);
  fs.writeFileSync(envFile, '# keys\nANTHROPIC_API_KEY="sk-test-not-real"\nexport STUDIO_X230I=one\nALREADY_SET=fromfile\n\nBAD LINE\nQUOTED=\'two\'\r\n');
  const de = probe(`import { loadDotEnv } from ${u('harness/dotenv.mjs')};
const env = { ALREADY_SET: 'shell' };
const names = loadDotEnv(${JSON.stringify(envFile)}, env);
console.log(JSON.stringify({ names, a: env.ANTHROPIC_API_KEY === 'sk-test-not-real', x: env.STUDIO_X230I, kept: env.ALREADY_SET, q: env.QUOTED, missing: loadDotEnv(${JSON.stringify(envFile + '-none')}, {}) }));`);
  report('2.30i: .env is loaded for agent start without overriding the shell, and only key names come back',
    de.a === true && de.x === 'one' && de.kept === 'shell' && de.q === 'two' && Array.isArray(de.names) && !de.names.includes('ALREADY_SET') && !JSON.stringify(de.names).includes('sk-') && Array.isArray(de.missing) && de.missing.length === 0, JSON.stringify(de));
  const agentSrc = fs.readFileSync(path.join(dir, 'harness', 'agent.mjs'), 'utf8');
  report('2.30i: the agent CLI loads .env before reading its commands', /loadDotEnv\(path\.join\(REPO_ROOT, '\.env'\)\)/.test(agentSrc));

  // 4. NIM: one session at a time by default.
  const nim = probe(`import { isNim, providerConcurrency as c } from ${u('harness/families.mjs')};
console.log(JSON.stringify({ a: isNim('nvidia/llama-3.3-nemotron-super-49b-v1.5', 'custom'), b: isNim('glm-5.3-flash', 'nim'), c: isNim('claude-sonnet-5', 'claude'), d: c('nim', 'nim', {}), e: c('nim', 'nim', { STUDIO_NIM_MAX_SESSIONS: '2' }), f: c('nim', 'nim', { STUDIO_NIM_MAX_SESSIONS: '' }), g: c('gpt-6', 'codex', {}) === Infinity }));`);
  report('2.30i: NIM models are recognised and default to one session at a time (STUDIO_NIM_MAX_SESSIONS raises it)',
    nim.a === true && nim.b === true && nim.c === false && nim.d === 1 && nim.e === 2 && nim.f === 1 && nim.g === true, JSON.stringify(nim));
  report('2.30i: startAgent refuses a second NIM session, and a NIM 429 can fail over via STUDIO_NIM_FALLBACK',
    /NIM allows \$\{limit\} session\(s\) at a time/.test(agentSrc) && /STUDIO_NIM_FALLBACK/.test(agentSrc));

  // 5. Builders are told never to send verify or checks to the background.
  const kick = fs.readFileSync(path.join(dir, 'harness', 'kickoff.mjs'), 'utf8');
  report('2.30i: the builder loop forbids backgrounding verify, checks and tests', /never run verify\/check\/test commands in the background: no &, no run_in_background, no nohup/.test(kick));
}
