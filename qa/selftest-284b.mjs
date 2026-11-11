/**
 * qa/selftest-284b.mjs — 2.84 (b): the same-family review fallback reads the studio's files, not the session's environment.
 *
 * 2.83 let a review from the implementer's own family through, on the header `same-family: no other family available`,
 * while no other family was configured. "Configured" came from the calling process's environment, which a launched
 * session controls: unsetting the model variables made "no other family" true in a studio that has one. Now the
 * families are the union of the main checkout's .env (model/tool settings only), its studio/models.json and the
 * environment; the environment can add a family, never remove one (harness/review-family.mjs).
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export async function selftest284B({ dir, report, tmpRoot }) {
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const guard = async (name, fn) => { try { const [ok, detail] = await fn(); report(name, Boolean(ok), ok ? '' : String(detail || '').slice(0, 3000)); } catch (e) { report(name, false, String(e?.stack || e).slice(0, 3000)); } };
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const git = (cwd, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'core.autocrlf=false', ...a], { windowsHide: true, cwd, encoding: 'utf8', env: { ...process.env, ...ident } });
  const clean = {};
  for (const k of Object.keys(process.env)) if (/^(CLAUDE|CODEX|CURSOR|AIDER|GEMINI|STUDIO_|AGENT_|AI_AGENT|ANTHROPIC|OPENAI)/i.test(k)) clean[k] = '';
  const base = {
    ...clean, ...ident, STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_VERIFY_DETACH: 'off', STUDIO_HOOKS_CHECK: 'off', STUDIO_MACHINE_SCAN: 'off',
    STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-284b-${process.pid}.pem`), CI: '', GITHUB_ACTIONS: '', NODE_OPTIONS: '', npm_lifecycle_event: '',
  };
  const S = path.join(tmpRoot, `284b-studio-${process.pid}`);
  fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
  for (const x of ['.studio', '.env', 'studio/models.json', 'studio/task-holds.json']) fs.rmSync(path.join(S, x), { recursive: true, force: true });
  const ev = path.join(S, '.studio', 'events-284b.jsonl');
  fs.mkdirSync(path.dirname(ev), { recursive: true });
  fs.writeFileSync(ev, '');
  const env = { ...base, AGENT_EVENTS_FILE: ev };
  const cli = (e, cmd) => spawnSync(process.execPath, cmd, { windowsHide: true, cwd: S, env: { ...process.env, ...env, ...e }, encoding: 'utf8', timeout: 180000 });
  const u = (rel) => JSON.stringify(pathToFileURL(path.join(S, rel)).href);
  const SECRET = 'sk-test-284b-not-a-real-secret-value';
  const ENVF = path.join(S, '.env');
  const MODELS = path.join(S, 'studio', 'models.json');
  const setFiles = ({ dotenv = null, models = null } = {}) => {
    fs.rmSync(ENVF, { force: true }); fs.rmSync(MODELS, { force: true });
    if (dotenv !== null) fs.writeFileSync(ENVF, `PROVIDER_API_KEY=${SECRET}\nOTHER_SERVICE_TOKEN=${SECRET}\n${dotenv}\n`);
    if (models !== null) fs.writeFileSync(MODELS, JSON.stringify(models));
  };
  const TWO = 'STUDIO_AGENT_MODEL=claude-opus-5-5\nSTUDIO_RESCUE_MODELS=gpt-5-codex';
  const ONE = 'STUDIO_AGENT_MODEL=claude-opus-5-5\nSTUDIO_REVIEWER_MODEL=claude-sonnet-5-5';
  // Everything the session could set: all model settings blank, or only the implementer's own family.
  const blank = { STUDIO_AGENT_MODEL: '', STUDIO_REVIEWER_MODEL: '', STUDIO_RESCUE_MODELS: '', STUDIO_REVIEW_TOOLS: '', STUDIO_REVIEWER_TOOL: '' };
  const oneFam = { ...blank, STUDIO_AGENT_MODEL: 'claude-opus-5-5' };

  // A studio with its own git, one system task built on opus and one tagged commit.
  git(S, 'init', '-q');
  git(S, 'add', '-A');
  git(S, 'commit', '-q', '-m', 'init', '--no-verify');
  const add = cli({}, ['harness/task.mjs', 'add', 'Rates', '--type', 'system']);
  const id = (out(add).match(/"id":\s*"(T-\d+)"/) || [])[1];
  if (id) {
    cli({ STUDIO_LOCK_OWNER: 'builder-b1' }, ['harness/task.mjs', 'start', id, '--agent', 'builder-b1', '--model', 'claude-opus-5-5']);
    fs.writeFileSync(path.join(S, 'GUIDE.md'), 'rates\n');
    git(S, 'add', '-A');
    git(S, 'commit', '-q', '-m', 'rates', '--no-verify', '--trailer', `Studio-Task: ${id}`);
  }
  const REVIEW = path.join(tmpRoot, `284b-review-${process.pid}.md`);
  fs.writeFileSync(REVIEW, `model-family: anthropic\nimplementer-family: anthropic\nsame-family: no other family available\n\nReview of ${id}: rates look right.\nVerdict: approve\n`);
  const record = (e) => cli({ ...e, STUDIO_LOCK_OWNER: 'producer-1' }, ['harness/review.mjs', 'record', id, '--by', 'opus-reviewer', '--family', 'anthropic', '--file', REVIEW, '--implementer', 'claude-opus-5-5', '--no-commit']);
  const clearReviews = () => { const d = path.join(S, 'studio', 'reviews'); try { for (const f of fs.readdirSync(d)) if (f !== 'README.md') fs.rmSync(path.join(d, f), { force: true }); } catch { /* none yet */ } };
  const approvedLine = (e) => (out(cli({ ...e, STUDIO_PRODUCER_NAME: 'prod-1' }, ['harness/done-check.mjs', id])).split('\n').find((l) => /Approved by a reviewer from another model family/.test(l)) || '(no such line)');
  const writeDoneReview = () => { fs.mkdirSync(path.join(S, 'studio', 'reviews'), { recursive: true }); fs.writeFileSync(path.join(S, 'studio', 'reviews', '2026-11-01-rates-284b.md'), fs.readFileSync(REVIEW, 'utf8')); };
  if (!id) report('setup: a system task in the studio copy', false, out(add));

  await guard('record, two families in the main .env: a same-family review with the header is refused when the session blanks every model setting, and the refusal names the family and the file (fails before this fix: recorded, because the blanked environment named no other family)', () => {
    setFiles({ dotenv: TWO });
    const r = record(blank);
    return [r.status !== 0 && /Refused/.test(out(r)) && /openai is configured \(found in \.env\)/.test(out(r)), out(r)];
  });
  await guard('record, two families in the main .env: still refused when the session names only the implementer\'s own family (fails before this fix: recorded)', () => {
    setFiles({ dotenv: TWO });
    const r = record(oneFam);
    return [r.status !== 0 && /Refused/.test(out(r)) && /openai is configured/.test(out(r)), out(r)];
  });
  await guard('done-check, two families in the main .env: a same-family approval with the header does not count when the session blanks every model setting, and the line says why (fails before this fix: the approval counted)', () => {
    setFiles({ dotenv: TWO }); clearReviews(); writeDoneReview();
    const l = approvedLine(blank);
    return [/^\s*\[ \]/.test(l) && /openai is configured \(found in \.env\)/.test(l), l];
  });
  await guard('one family only, in files and environment: the header is accepted by review record and counted by done-check (the 2.83 behaviour stays)', () => {
    setFiles({ dotenv: ONE }); clearReviews();
    const r = record(oneFam);
    const body = (() => { try { return fs.readdirSync(path.join(S, 'studio', 'reviews')).filter((f) => /outside/.test(f)); } catch { return []; } })();
    clearReviews(); writeDoneReview();
    const l = approvedLine(oneFam);
    return [r.status === 0 && body.length === 1 && /^\s*\[x\]/.test(l), `${out(r)} | ${body} | ${l}`];
  });
  await guard('no .env and no models.json, and a blank environment: the header is accepted (the studio truly has no other family on record)', () => {
    setFiles({}); clearReviews();
    const r = record(blank);
    clearReviews();
    return [r.status === 0, out(r)];
  });
  await guard('studio/models.json naming a model of a second family counts: the header is refused (fails before this fix: models.json was never read)', () => {
    setFiles({ dotenv: ONE, models: { pools: { a: { tool: 'claude', model: 'claude-opus-5-5' }, b: { tool: 'codex', model: 'gpt-5-codex' } } } }); clearReviews();
    const r = record(oneFam);
    return [r.status !== 0 && /openai is configured \(found in studio\/models\.json\)/.test(out(r)), out(r)];
  });
  await guard('the environment can add a family: the files name one, the environment names another, the header is refused', () => {
    setFiles({ dotenv: ONE }); clearReviews();
    const r = record({ ...oneFam, STUDIO_RESCUE_MODELS: 'gpt-5-codex' });
    return [r.status !== 0 && /openai is configured \(found in environment\)/.test(out(r)), out(r)];
  });
  await guard('a session cannot hide the files by pointing STUDIO_MAIN_ROOT at another folder: the main checkout is found by git (fails before this fix: recorded)', () => {
    setFiles({ dotenv: TWO }); clearReviews();
    const decoy = path.join(tmpRoot, `284b-decoy-${process.pid}`);
    fs.mkdirSync(decoy, { recursive: true });
    const r = record({ ...blank, STUDIO_MAIN_ROOT: decoy });
    return [r.status !== 0 && /openai is configured/.test(out(r)), out(r)];
  });

  await guard('configuredFamilies: the sorted families and where each came from; nothing of the .env but the model settings is read (a made-up secret line appears nowhere in the result, the refusal or any event)', () => {
    setFiles({ dotenv: TWO, models: { pools: { b: { tool: 'agy', model: 'gemini-4-argon-high' } } } });
    const probeFile = path.join(tmpRoot, `probe-284b-${process.pid}.mjs`);
    fs.writeFileSync(probeFile, `import { configuredFamilies, configuredSources, sameFamilyRefusal } from ${u('harness/review-family.mjs')};
const root = ${JSON.stringify(S)};
const env = { STUDIO_RESCUE_MODEL: 'grok-4' };
const c = configuredFamilies({ root, env });
console.log(JSON.stringify({ c, s: configuredSources({ root, env }), why: sameFamilyRefusal('claude-opus-5-5', env, { root }) }));`);
    const r = cli(blank, [probeFile]);
    try { fs.rmSync(probeFile, { force: true }); } catch { /* swept later */ }
    const line = String(r.stdout || '').split('\n').filter((l) => l.startsWith('{')).pop();
    const j = JSON.parse(line);
    const events = fs.readFileSync(ev, 'utf8');
    const f = j.c.families;
    const ok = JSON.stringify(f) === JSON.stringify([...f].sort()) && ['anthropic', 'google', 'openai', 'xai'].every((x) => f.includes(x))
      && j.c.sources.openai.includes('.env') && j.c.sources.google.includes('studio/models.json') && j.c.sources.xai.includes('environment');
    const leaked = line.includes(SECRET) || out(r).includes(SECRET) || events.includes(SECRET) || out(record(blank)).includes(SECRET);
    return [ok && !leaked && /found in/.test(j.why), `${line} leaked=${leaked}`];
  });

  await guard('launch agrees with the check: a review of work built on opus, with the main .env naming a GPT model and the session blanking every setting, goes to the GPT model with no same-family note (fails before this fix: planned as same-family)', () => {
    setFiles({ dotenv: TWO });
    const probeFile = path.join(tmpRoot, `probe-284b-l-${process.pid}.mjs`);
    fs.writeFileSync(probeFile, `import { reviewLaunch } from ${u('harness/review-family.mjs')};
const events = [{ type: 'task.start', agent: 'b1', task: 'T-9', model: 'claude-opus-5-5' }];
console.log(JSON.stringify(reviewLaunch({ taskId: 'T-10', title: 'Review T-9', events, current: 'claude-opus-5-5', env: {}, root: ${JSON.stringify(S)} })));`);
    const r = cli(blank, [probeFile]);
    try { fs.rmSync(probeFile, { force: true }); } catch { /* swept later */ }
    const j = JSON.parse(String(r.stdout || '').split('\n').filter((l) => l.startsWith('{')).pop() || '{}');
    return [j.kind === 'other' && j.model === 'gpt-5-codex' && !j.note, out(r).slice(-600)];
  });

  setFiles({});
}
