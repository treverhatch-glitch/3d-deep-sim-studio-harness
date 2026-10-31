/**
 * qa/selftest-258c.mjs — 2.58.0 (PU-33, P-046): a token can no longer reach a commit, or sit in one, unseen.
 *   1. The pre-commit hook scans what is staged (the index), not the file on disk: staged, then cleaned only in
 *      the file, still fails.
 *   2. Verify's secrets gate reads the commits not on the base branch yet (lines added and messages), so a token
 *      committed and then cleaned still fails; once the base has moved past it, it passes.
 *   3. A UTF-16 file with a BOM (what Windows PowerShell 5's `>` writes) or a UTF-8 BOM file is read, not skipped.
 *   4. The skip list is tied to real paths: harness/secrets.mjs and the root package-lock.json are skipped, any
 *      other secrets.mjs or *.lock is scanned.
 *   5. scrub() (trajectory exports, reviews) removes every PU-18 kind: it shares the scan's list.
 *   6. The owner's allowlist (studio/secrets-allow.json, protected): a finding shows the sha256 of its value, and an
 *      entry (path, kind, fingerprint, commit) allows that one false alarm and nothing else.
 * Every token is built at run time from random characters, so this file holds none and the scan over the repo
 * stays clean. No output may hold a token's value.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export async function selftest258C({ dir, run, report, tmpRoot }) {
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const AZ = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const D = '0123456789';
  const B62 = `${AZ}${AZ.toLowerCase()}${D}`;
  const URL64 = `${B62}-_`;
  const B64 = `${B62}+/`;
  const HEX = '0123456789abcdef';
  const pick = (n, a = B62) => {
    const bytes = crypto.randomBytes(n * 2);
    let s = '';
    for (let i = 0; s.length < n; i += 1) s += a[bytes[i % bytes.length] % a.length];
    return s;
  };
  // Random, with lower, upper and digits, and none of the words or runs the scan treats as a placeholder.
  const rand = (n, a = B62) => {
    for (;;) {
      const s = pick(n, a);
      if (/[a-z]/.test(s) && /[A-Z]/.test(s) && /\d/.test(s) && !/(.)\1\1|x{3}|your|test|fake|here|none|null|todo|tbd|exam|samp|dumm|redact|change|insert|replace/i.test(s)) return s;
    }
  };
  const values = []; // every token made here: no output may hold one
  const keep = (v) => (values.push(v), v);
  const github = () => keep(['g', 'h', 'p', '_'].join('') + rand(36));
  const outputs = [];
  const seen = (r) => (outputs.push(out(r)), r);
  const leaks = (text) => values.filter((v) => text.includes(v)).length;

  // A clean environment: nothing from an outer hook (GIT_INDEX_FILE) or the shell (agent names) leaks in.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(GIT_|STUDIO_|AGENT_)/.test(k)));
  Object.assign(env, { STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off' });
  delete env.NODE_PATH;
  const g = path.join(tmpRoot, `repo-258c-${process.pid}`);
  const git = (...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], { cwd: g, encoding: 'utf8', env });
  const node = (cwd, ...a) => seen(spawnSync(process.execPath, a, { cwd, encoding: 'utf8', env }));
  const w = (root, rel, data) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), data);
  };
  const scanDir = (name, files) => {
    const d = path.join(tmpRoot, `secrets-258c-${process.pid}-${name}`);
    fs.rmSync(d, { recursive: true, force: true });
    for (const [rel, data] of Object.entries(files)) w(d, rel, data);
    return node(dir, 'scripts/secret-scan.mjs', d);
  };

  // A git repo of the harness: the hook installed, everything committed once (the history scan's control).
  fs.rmSync(g, { recursive: true, force: true });
  fs.cpSync(dir, g, { recursive: true, filter: (src) => !/[\\/](node_modules|\.git)$/.test(src) });
  git('init', '-q', '-b', 'main');
  git('config', 'core.hooksPath', 'scripts/hooks');
  git('add', '-A');
  git('commit', '-qm', 'base', '--no-verify');
  const short = () => git('rev-parse', '--short=7', 'HEAD').stdout.trim();
  const gate = () => node(g, 'scripts/run-gates.mjs', '--only', 'secrets');

  // 1. Staged, then cleaned only in the file: the commit would hold the token, so the hook refuses it.
  {
    const before = short();
    w(g, 'game/x/cfg.json', `{\n  "token": "${github()}"\n}\n`);
    git('add', 'game/x/cfg.json');
    w(g, 'game/x/cfg.json', '{\n  "token": "your-token-here"\n}\n');
    const c = seen(git('commit', '-m', 'cfg'));
    const refused = c.status !== 0 && short() === before;
    git('add', 'game/x/cfg.json'); // the cleaned file staged: now the commit is clean
    const ok = seen(git('commit', '-m', 'cfg (clean)'));
    report('PU-33 (P-046): the pre-commit hook scans the staged blob: a token staged and then cleaned only in the file fails ([secrets] FAIL game/x/cfg.json:2), the re-staged clean file commits',
      refused && /\[secrets\] FAIL/.test(out(c)) && /game\/x\/cfg\.json:2 {2}github-token/.test(out(c)) && ok.status === 0 && short() !== before && !leaks(out(c)), `${out(c)}\n---\n${out(ok)}`);
  }

  // 2. A token committed two commits back fails verify's secrets gate; with the base past it, it passes.
  {
    const control = gate();
    w(g, 'game/y/keys.env', `API=${github()}\n`);
    git('add', '-A');
    git('commit', '-qm', 'keys', '--no-verify');
    const planted = short();
    w(g, 'game/y/keys.env', 'API=\n');
    git('add', '-A');
    git('commit', '-qm', 'keys cleaned', '--no-verify');
    w(g, 'readme-258c.txt', 'unrelated\n');
    git('add', '-A');
    git('commit', '-qm', 'unrelated', '--no-verify');
    const failed = gate();
    git('update-ref', 'refs/remotes/origin/main', 'HEAD'); // pushed: the base branch now holds it
    const pushed = gate();
    report('PU-33 (P-046): verify\'s secrets gate reads the commits since the base: a token committed two commits back and cleaned since fails (commit, file, line, kind); the whole harness as history passes; with origin/main past it, it passes',
      control.status === 0 && /commit\(s\) in the last 50/.test(out(control)) && failed.status !== 0 && new RegExp(`${planted} game/y/keys\\.env:1 {2}github-token`).test(out(failed))
        && pushed.status === 0 && /0 commit\(s\) since origin\/main/.test(out(pushed)) && !leaks(out(failed)),
      `${out(control).slice(-600)}\n---\n${out(failed).slice(-1500)}\n---\n${out(pushed).slice(-600)}`);
  }

  // 3. A token in a commit message.
  {
    w(g, 'readme-258c.txt', 'unrelated, again\n');
    git('add', '-A');
    git('commit', '-q', '--no-verify', '-m', 'fix the login', '-m', `tried it with ${github()} first`);
    const sha = short();
    const r = node(g, 'scripts/secret-scan.mjs');
    const since = node(g, 'scripts/secret-scan.mjs', '--since', 'origin/main');
    report('PU-33 (P-046): a token in a commit message fails the scan (commit, "(commit message)", line, kind), also with --since <ref>',
      r.status === 1 && new RegExp(`${sha} \\(commit message\\):3 {2}github-token`).test(out(r)) && since.status === 1 && /1 commit|commit message/.test(out(since)) && !leaks(out(r)), `${out(r)}\n---\n${out(since)}`);
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  }

  // 4. UTF-16 (LE and BE, with a BOM) and UTF-8 with a BOM: in the folder, staged, and in history.
  {
    const le = (s) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(s, 'utf16le')]);
    const be = (s) => Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(s, 'utf16le').swap16()]);
    const files = {
      'out/ps.txt': le(`written by PowerShell 5\r\nKEY ${github()}\r\n`),
      'out/be.txt': be(`one\ntwo\n${github()}\n`),
      'out/bom.env': Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(`JWT_SECRET=${keep(rand(48))}\n`)]),
    };
    const folder = scanDir('utf16', files);
    for (const [rel, data] of Object.entries(files)) w(g, rel, data);
    git('add', 'out');
    const staged = node(g, 'scripts/secret-scan.mjs', '--staged');
    git('commit', '-qm', 'out', '--no-verify');
    const sha = short();
    fs.rmSync(path.join(g, 'out'), { recursive: true });
    git('add', '-A');
    git('commit', '-qm', 'out removed', '--no-verify');
    const hist = node(g, 'scripts/secret-scan.mjs');
    const all = (r, pre = '') => [`${pre}out/ps.txt:2 {2}github-token`, `${pre}out/be.txt:3 {2}github-token`, `${pre}out/bom.env:1 {2}named-secret \\(JWT_SECRET\\)`].every((p) => new RegExp(p).test(out(r)));
    report('PU-33 (P-046): a UTF-16LE file with a BOM (PowerShell 5\'s >), a UTF-16BE one and a UTF-8 BOM one are read, not skipped: the folder scan, --staged and the history scan all fail on their tokens',
      folder.status === 1 && all(folder) && staged.status === 1 && all(staged) && hist.status === 1 && all(hist, `${sha} `) && !leaks(out(folder) + out(staged) + out(hist)),
      `${out(folder)}\n---\n${out(staged)}\n---\n${out(hist)}`);
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  }

  // 5. The skip list is tied to real paths.
  {
    const quiet = scanDir('skip-ok', {
      'harness/secrets.mjs': `export const k = "${github()}";\n`,
      'package-lock.json': `{ "token": "${github()}" }\n`,
      '.studio/locks/task_T-1.lock': `${github()}\n`,
      'readme.md': 'nothing here\n',
    });
    const loud = scanDir('skip-bad', {
      'harness/secrets.mjs': `export const k = "${github()}";\n`,
      'package-lock.json': `{ "token": "${github()}" }\n`,
      'game/x/secrets.mjs': `export const k = "${github()}";\n`,
      'x.lock': `${github()}\n`,
      'web/package-lock.json': `{ "token": "${github()}" }\n`,
    });
    report('PU-33 (P-046): harness/secrets.mjs, the root package-lock.json and .studio/locks/ are still skipped; game/x/secrets.mjs, x.lock and a nested package-lock.json are scanned and fail',
      quiet.status === 0 && loud.status === 1 && /game\/x\/secrets\.mjs:1 {2}github-token/.test(out(loud)) && /x\.lock:1 {2}github-token/.test(out(loud)) && /web\/package-lock\.json:1/.test(out(loud))
        && !/harness\/secrets\.mjs|^ {2}package-lock\.json/m.test(out(loud)) && !leaks(out(quiet) + out(loud)), `${out(quiet)}\n---\n${out(loud)}`);
  }

  // 6. scrub() removes every PU-18 kind (and keeps the names in front of the values).
  {
    const { scrub } = await import(pathToFileURL(path.join(dir, 'harness', 'secrets.mjs')).href);
    const kinds = {
      'discord-bot-token': keep(`${Buffer.from(`1${pick(18, D)}`).toString('base64url')}.${rand(6, URL64)}.${rand(38, URL64)}`),
      'discord-webhook-url': keep(`https://discord.com/api/webhooks/${pick(18, D)}/${rand(68, URL64)}`),
      'slack-webhook-url': keep(['https://hooks.slack.com/services', `T${pick(8, AZ + D)}`, `B${pick(8, AZ + D)}`, rand(24)].join('/')),
      'slack-app-token': keep(['xa', 'pp-1-A', pick(10, AZ + D), '-', pick(13, D), '-', pick(64, HEX)].join('')),
      'slack-token': keep(['xo', 'xe-1-', rand(40)].join('')),
      'telegram-bot-token': keep(`${pick(10, D)}:${'A'}${'A'}${rand(33, URL64)}`),
      'aws-secret-access-key': keep(`${rand(36, B64)}/${rand(3)}`),
      'aws-session-token': keep(rand(320, B64)),
      'named-secret': keep(rand(48)),
      'base64-wrapped': keep(Buffer.from(github()).toString('base64')),
    };
    const text = [
      `bot ${kinds['discord-bot-token']}`,
      `alerts: ${kinds['discord-webhook-url']}`,
      `curl -X POST ${kinds['slack-webhook-url']}`,
      `app ${kinds['slack-app-token']}`,
      `refresh ${kinds['slack-token']}`,
      `https://api.telegram.org/bot${kinds['telegram-bot-token']}/sendMessage`,
      `aws_secret_access_key = ${kinds['aws-secret-access-key']}`,
      `AWS_SESSION_TOKEN=${kinds['aws-session-token']}`,
      `JWT_SECRET=${kinds['named-secret']}`,
      `{"blob": "${kinds['base64-wrapped']}"}`,
    ].join('\n');
    const s = scrub(text);
    const left = Object.entries(kinds).filter(([, v]) => s.text.includes(v)).map(([k]) => k);
    report('PU-33: scrub() (trajectory exports, reviews) removes every PU-18 kind, named secrets and base64-wrapped tokens, and keeps the names (aws_secret_access_key = [removed])',
      left.length === 0 && s.hits >= Object.keys(kinds).length && /aws_secret_access_key = \[removed\]/.test(s.text) && /JWT_SECRET=\[removed\]/.test(s.text), `left: ${left.join(', ')}; hits ${s.hits}`);
  }

  // 7. The owner's allowlist (studio/secrets-allow.json): one false alarm, by path, kind, fingerprint and commit.
  {
    const fp = (v) => crypto.createHash('sha256').update(v).digest('hex');
    const ownerKey = path.join(tmpRoot, `owner-258c-${process.pid}.pem`);
    const owner = { ...env, STUDIO_OWNER_KEY: ownerKey };
    const protectedCheck = () => seen(spawnSync(process.execPath, ['qa/protected-check.mjs'], { cwd: g, encoding: 'utf8', env: owner }));
    git('config', 'core.autocrlf', 'false');
    fs.rmSync(ownerKey, { force: true });
    const kg = spawnSync(process.execPath, ['harness/approve.mjs', 'keygen'], { cwd: g, encoding: 'utf8', env: owner });
    git('add', 'studio/keys');
    git('commit', '-qm', 'owner key', '--no-verify');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD'); // the base holds the owner key
    const commitFile = (rel, text, msg) => {
      w(g, rel, text);
      git('add', '-A');
      git('commit', '-qm', msg, '--no-verify');
      return short();
    };
    // A value that only looks like a token, committed and removed again: a history false alarm.
    const lookalike = github();
    const c1 = commitFile('game/z/fixture.txt', `id: ${lookalike}\n`, 'fixture');
    fs.rmSync(path.join(g, 'game/z/fixture.txt'));
    git('add', '-A');
    git('commit', '-qm', 'fixture removed', '--no-verify');
    const before = node(g, 'scripts/secret-scan.mjs');
    const hint = (/e\.g\. (\{.*\})\s*$/m.exec(out(before)) || [])[1];
    let entry = null;
    try { entry = { ...JSON.parse(hint), reason: 'a fixture id that only looks like a token', by: 'owner' }; } catch {}
    report('PU-33: each finding shows the sha256 of its value (never the value) and a one-line hint with a ready entry for studio/secrets-allow.json',
      before.status === 1 && new RegExp(`${c1} game/z/fixture\\.txt:1 {2}github-token {2}sha256:${fp(lookalike)}`).test(out(before)) && entry?.fingerprint === fp(lookalike) && entry?.commit === c1
        && entry?.path === 'game/z/fixture.txt' && !leaks(out(before)), out(before));

    w(g, 'studio/secrets-allow.json', `${JSON.stringify({ allow: [entry] }, null, 2)}\n`);
    const allowed = node(g, 'scripts/secret-scan.mjs');
    const unsigned = protectedCheck();
    const signed = spawnSync(process.execPath, ['harness/approve.mjs', 'protected', '--note', 'the owner allows one fixture false alarm'], { cwd: g, encoding: 'utf8', env: owner });
    git('add', '-A');
    git('commit', '-qm', 'allow the fixture false alarm', '--no-verify');
    const approved = protectedCheck();
    const after = node(g, 'scripts/secret-scan.mjs');
    report('PU-33: an entry in studio/secrets-allow.json allows that history false alarm ("allowed (reason)", the scan passes); the file is protected: unsigned it fails the protected check, the owner\'s approval passes it',
      kg.status === 0 && allowed.status === 0 && /game\/z\/fixture\.txt:1 {2}github-token {2}sha256:[0-9a-f]{64} {2}allowed \(a fixture id that only looks like a token\)/.test(out(allowed))
        && unsigned.status !== 0 && /studio\/secrets-allow\.json/.test(out(unsigned)) && signed.status === 0 && approved.status === 0 && after.status === 0,
      `${out(allowed)}\n---\n${out(unsigned)}\n---\n${out(signed)}\n---\n${out(approved)}\n---\n${out(after)}`);

    // The same value at another path is a new finding; a different value at the same path and kind too.
    const c3 = commitFile('game/z/copy.txt', `id: ${lookalike}\n`, 'copy');
    const elsewhere = node(g, 'scripts/secret-scan.mjs');
    git('reset', '-q', '--hard', 'HEAD~1');
    const real = github();
    const c4 = commitFile('game/z/fixture.txt', `id: ${real}\n`, 'a real one where the fixture was');
    const other = node(g, 'scripts/secret-scan.mjs');
    report('PU-33: an allow entry is that one finding only: the same fingerprint at another path still fails, and a real token at the allowed path and kind (another fingerprint) still fails',
      elsewhere.status === 1 && new RegExp(`${c3} game/z/copy\\.txt:1 {2}github-token {2}sha256:${fp(lookalike)}\\n`).test(out(elsewhere)) && /allowed \(a fixture id/.test(out(elsewhere))
        && other.status === 1 && new RegExp(`${c4} game/z/fixture\\.txt:1 {2}github-token {2}sha256:${fp(real)}\\n`).test(out(other)) && !leaks(out(elsewhere) + out(other)),
      `${out(elsewhere)}\n---\n${out(other)}`);
  }

  // 8. No output above holds a value.
  {
    const all = outputs.join('\n');
    report('PU-33: no scan, hook or gate output above holds a token value (file, line, kind and commit only)', values.length >= 20 && leaks(all) === 0, `${leaks(all)} of ${values.length} values printed`);
  }
  try { fs.rmSync(g, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 }); } catch {}
}
