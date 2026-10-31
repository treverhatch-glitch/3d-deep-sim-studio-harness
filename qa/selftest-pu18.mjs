/**
 * qa/selftest-pu18.mjs — PU-18 (P-040): the secret scan catches Discord bot tokens and webhooks, Slack webhooks and
 * tokens, Telegram bot tokens, AWS secret keys and session tokens, long random values under secret-sounding names,
 * and token shapes wrapped in base64. Placeholders, docs samples, code and long base64 data still pass, and the
 * report never holds a value.
 * Every token-shaped fixture is put together at run time from alphabets and a seeded generator, so this file never
 * holds one itself and the scan over the repo stays clean.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export async function selftestPU18({ dir, run, report, tmpRoot }) {
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  let seed = 40218;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const AZ = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const az = AZ.toLowerCase();
  const D = '0123456789';
  const B62 = AZ + az + D;
  const URL64 = `${B62}-_`;
  const B64 = `${B62}+/`;
  const HEX = '0123456789abcdef';
  const pick = (n, a = B62) => {
    let s = '';
    while (s.length < n) s += a[Math.floor(rnd() * a.length)];
    return s;
  };
  // Random, with lower, upper and digits, and none of the words or runs the scan treats as a placeholder.
  const rand = (n, a = B62) => {
    for (;;) {
      const s = pick(n, a);
      if (/[a-z]/.test(s) && /[A-Z]/.test(s) && /\d/.test(s) && !/(.)\1\1|x{3}|your|test|fake|here|none|null|todo|tbd/i.test(s)) return s;
    }
  };
  const b64 = (s) => Buffer.from(s).toString('base64');
  const scanDir = (name, files) => {
    const d = path.join(tmpRoot, `secrets-pu18-${process.pid}-${name}`);
    fs.rmSync(d, { recursive: true, force: true });
    for (const [rel, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(d, rel)), { recursive: true });
      fs.writeFileSync(path.join(d, rel), text);
    }
    return run(dir, `node scripts/secret-scan.mjs "${d}"`);
  };

  // The shapes.
  const discordBot = `${Buffer.from(`1${pick(18, D)}`).toString('base64url')}.${rand(6, URL64)}.${rand(38, URL64)}`;
  const discordShaped = `N${rand(23, URL64)}.${rand(6, URL64)}.${rand(27, URL64)}`; // the P-040 report's fake shape
  const hook = (host) => `https://${host}/api/webhooks/${pick(18, D)}/${rand(68, URL64)}`;
  const slackHook = ['https://hooks.slack.com/services', `T${pick(8, AZ + D)}`, `B${pick(8, AZ + D)}`, rand(24)].join('/');
  const slackBot = ['xo', 'xb-', pick(12, D), '-', pick(13, D), '-', rand(24)].join('');
  const slackApp = ['xa', 'pp-1-A', pick(10, AZ + D), '-', pick(13, D), '-', pick(64, HEX)].join('');
  const telegram = `${pick(10, D)}:${'A'}${'A'}${rand(33, URL64)}`;
  const awsSecret = `${rand(36, B64)}/${rand(3)}`;
  const awsSession = rand(320, B64);
  const github = ['g', 'hp_', rand(36)].join('');

  // One folder per kind: the scan fails, names the file, line and kind, and never prints the value.
  const cases = [
    ['discord-bot-token', 'a Discord bot token in an env file', { 'bot.env': `# bot\nDISCORD_TOKEN=${discordBot}\n` }, 'bot.env:2', discordBot],
    ['discord-bot-token', 'a Discord bot token inside JSON', { 'config.json': `{\n  "token": "${discordBot}"\n}\n` }, 'config.json:2', discordBot],
    ['discord-bot-token', 'a Discord-token-shaped string (three dot-separated parts)', { 'notes.txt': `token ${discordShaped}\n` }, 'notes.txt:1', discordShaped],
    ...['discord.com', 'discordapp.com', 'canary.discord.com', 'ptb.discord.com'].map((h, i) => {
      const u = hook(h);
      return ['discord-webhook-url', `a Discord webhook URL (${h})`, { [`hook${i}.yml`]: `alerts:\n  url: ${u}\n` }, `hook${i}.yml:2`, u.split('/').pop()];
    }),
    ['slack-webhook-url', 'a Slack webhook URL', { 'notify.sh': `curl -X POST ${slackHook} -d @msg.json\n` }, 'notify.sh:1', slackHook.split('/').pop()],
    ['slack-token', 'a Slack bot token', { 'slack.txt': `${slackBot}\n` }, 'slack.txt:1', slackBot],
    ['slack-app-token', 'a Slack app-level token', { 'slack.json': `{"appToken":"${slackApp}"}\n` }, 'slack.json:1', slackApp],
    ['telegram-bot-token', 'a Telegram bot token', { 'tg.env': `TELEGRAM_BOT_TOKEN=${telegram}\n` }, 'tg.env:1', telegram],
    ['telegram-bot-token', 'a Telegram bot token in the Bot API address', { 'send.sh': `curl -s https://api.telegram.org/bot${telegram}/sendMessage\n` }, 'send.sh:1', telegram],
    ['aws-secret-access-key', 'an AWS secret access key in a credentials file', { 'credentials': `[default]\naws_access_key_id = ${'AK'}IA${pick(16, AZ + D)}\naws_secret_access_key = ${awsSecret}\n` }, 'credentials:3', awsSecret],
    ['aws-secret-access-key', 'an AWS secret access key in an env file', { 'aws.env': `AWS_SECRET_ACCESS_KEY="${awsSecret}"\n` }, 'aws.env:1', awsSecret],
    ['aws-secret-access-key', 'an AWS secret access key in JSON (SecretAccessKey)', { 'creds.json': `{"Credentials": {"SecretAccessKey": "${awsSecret}"}}\n` }, 'creds.json:1', awsSecret],
    ['aws-session-token', 'an AWS session token', { 'aws2.env': `AWS_SESSION_TOKEN=${awsSession}\n` }, 'aws2.env:1', awsSession],
  ];
  const named = [
    ['JWT_SECRET', 'an env value', { 'app.env': `PORT=8080\nJWT_SECRET=${rand(48)}\n` }, 'app.env:2'],
    ['apiKey', 'a JSON value', { 'settings.json': `{\n  "region": "eu",\n  "apiKey": "${rand(32)}"\n}\n` }, 'settings.json:3'],
    ['password', 'a YAML value', { 'db.yml': `db:\n  user: app\n  password: ${rand(28, `${B62}-_.`)}\n` }, 'db.yml:3'],
    ['api_key', 'a TOML value (hex)', { 'svc.toml': `[service]\napi_key = "${pick(40, HEX)}"\n` }, 'svc.toml:2'],
    ['SIGNING_PRIVATE_KEY', 'a code constant', { 'sign.mjs': `export const SIGNING_PRIVATE_KEY = '${rand(44, B64)}';\n` }, 'sign.mjs:1'],
    ['token', 'a command-line flag', { 'deploy.sh': `#!/bin/sh\nuploader --token=${rand(36)} ./dist\n` }, 'deploy.sh:2'],
    ['TEAM_WEBHOOK_URL', 'a webhook address with a random path', { 'team.env': `TEAM_WEBHOOK_URL=https://hooks.chat-relay.net/in/${rand(32)}\n` }, 'team.env:1'],
    ['SECRET_KEY', 'a commented-out env line', { 'old.env': `DEBUG=1\n# SECRET_KEY=${rand(50, `${B62}-_`)}\n` }, 'old.env:2'],
    ['RELAY_API_KEY', 'a Dockerfile ENV line', { 'Dockerfile': `FROM node:22\nENV RELAY_API_KEY=${rand(40)}\n` }, 'Dockerfile:2'],
  ];
  for (const [name, how, files, at] of named) {
    const value = Object.values(files)[0].match(/[A-Za-z0-9+/_.-]{24,}(?=["';\s]|$)/g).pop();
    cases.push([`named-secret (${name})`, `a long random value under a secret-sounding name, ${how}`, files, at, value]);
  }
  cases.push(
    ['discord-bot-token (base64)', 'a Discord bot token wrapped in a base64 JSON value', { 'wrapped.json': `{"blob": "${b64(`DISCORD_TOKEN=${discordBot}`)}"}\n` }, 'wrapped.json:1', discordBot],
    ['telegram-bot-token (base64)', 'a Telegram bot token wrapped in a base64 env value', { 'wrapped.env': `PAYLOAD=${b64(telegram)}\n` }, 'wrapped.env:1', telegram],
    ['github-token (base64)', 'a GitHub token (a shared shape) wrapped in a quoted base64 string', { 'wrapped.mjs': `export const cfg = '${b64(github)}';\n` }, 'wrapped.mjs:1', github],
  );
  const leaks = [];
  cases.forEach(([kind, how, files, at, value], i) => {
    const res = scanDir(`fail-${i}`, files);
    const o = out(res);
    const wrapped = Object.values(files).join('').match(/[A-Za-z0-9+/=]{40,}/g) || [];
    if (o.includes(value) || o.includes(value.slice(-16)) || wrapped.some((w) => o.includes(w))) leaks.push(how);
    report(`PU-18 (P-040): the secret scan fails on ${how}, naming ${at} and the kind "${kind}"`,
      res.status === 1 && o.includes(`${at}  ${kind}`) && /values hidden/.test(o), o);
  });
  report('PU-18 (P-040): the secret scan never prints a value, a piece of one, or its base64 (file, line and kind only)', leaks.length === 0, leaks.join('\n'));

  // Placeholders, docs samples and ordinary code pass.
  const slackSample = ['https://hooks.slack.com/services', `T${'0'.repeat(8)}`, `B${'0'.repeat(8)}`, 'X'.repeat(24)].join('/');
  const placeholders = {
    '.env.example': [
      'DISCORD_TOKEN=',
      'DISCORD_BOT_TOKEN=<your bot token>',
      'SLACK_WEBHOOK_URL=${SLACK_WEBHOOK_URL}',
      'TELEGRAM_BOT_TOKEN=$TELEGRAM_BOT_TOKEN',
      'GITHUB_TOKEN=your-token-here',
      'HUB_TOKEN=change-me-to-a-long-random-string',
      'API_KEY=changeme',
      `JWT_SECRET=${'x'.repeat(32)}`,
      'DB_PASSWORD=***',
      `SERVICE_API_KEY=REDACTED${'_'.repeat(3)}`,
      `SESSION_SECRET=${'a'.repeat(40)}`,
      `PAYMENT_API_KEY=example-${rand(24)}`,
      `SIGNING_SECRET=dummy${rand(24)}`,
      `BOT_TOKEN=fake_${rand(24)}`,
      `CI_TOKEN=test-${rand(30)}`,
      `ADMIN_PASSWORD=Correct-Horse-Battery-Staple-42`,
      `RELEASE_TOKEN=${'abcdef0123456789'.repeat(2)}`,
      `aws_secret_access_key = ${rand(30, B64)}EXAMPLEKEY`,
      '',
    ].join('\n'),
    'config.json': JSON.stringify({ token: '', apiKey: '<API_KEY>', password: '********', clientSecret: '{{ client_secret }}', webhookUrl: 'https://discord.com/api/webhooks/<id>/<token>', session_token: '${AWS_SESSION_TOKEN}' }, null, 2),
    'docs/SETUP.md': [
      '# Setup',
      'Put the bot token in `.env` as DISCORD_TOKEN=... and never commit it.',
      `Slack's own sample webhook looks like ${slackSample}.`,
      `A Telegram token looks like 123456789:AA${'x'.repeat(33)}.`,
      `A Discord token looks like M${'x'.repeat(25)}.${'x'.repeat(6)}.${'x'.repeat(38)}.`,
      'Set `token: process.env.DISCORD_TOKEN` in the bot config.',
      '',
    ].join('\n'),
    'src/auth.ts': [
      'const token = await getToken(process.env.TOKEN_FILE);',
      'if (token === expectedToken) refresh();',
      'export const apiKey = process.env.OPENAI_API_KEY;',
      'const password = hashPassword(input, saltRoundsForTheAdminUser2024);',
      'interface Auth { token: string; refreshToken?: string }',
      "headers['x-api-key'] = config.apiKey;",
      "const secret = crypto.randomBytes(32).toString('hex');",
      'const webhook = new URL(`https://discord.com/api/webhooks/${id}/${token}`);',
      'for (const token of tokens) count += token.length;',
      '',
    ].join('\n'),
    'src/keys.py': ['MLKEM768X25519PrivateKey = native_ffi.hpke.MLKEM768X25519PrivateKey', 'API_KEY = settings.SERVICE_API_KEY_V2_FROM_VAULT', ''].join('\n'),
    'ci.yml': ['env:', '  GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}', '  NPM_TOKEN: $NPM_TOKEN', '  password: !vault |', ''].join('\n'),
  };
  const ph = scanDir('placeholders', placeholders);
  report('PU-18 (P-040): placeholders, docs samples and ordinary code (bare identifiers in source files included) pass the secret scan (empty, <...>, ${...}, $VAR, process.env, your-token-here, changeme, xxx, ***, REDACTED, example/dummy/fake/test values, one character repeated, word-built and sequential values, the Slack docs sample)',
    ph.status === 0 && /\[secrets\] PASS/.test(out(ph)), out(ph));

  // Long base64 data: lookalike pieces glued inside it, a token-bearing run longer than the 400-character cap, and a
  // data: URI are not keys.
  const noise = (n) => Buffer.from(Array.from({ length: n }, () => Math.floor(rnd() * 256))).toString('base64').replace(/=+$/, '');
  const glued = `${noise(600)}${'AK'}IA${pick(16, AZ)}${noise(300)}${github}${noise(600)}`;
  const longWrapped = b64(`${'-'.repeat(400)}\nDISCORD_TOKEN=${discordBot}\n`);
  const blob = scanDir('blob', {
    'pack.json': `{"png": "${glued}==", "notes": "${longWrapped}"}\n`,
    'page.html': `<img src="data:text/plain;base64,${b64(`TOKEN=${telegram}`)}">\n`,
  });
  report('PU-18 (P-040): a long base64 data blob with lookalike pieces inside it passes; base64 runs past the 400-character cap and data: URIs are not decoded',
    blob.status === 0 && /\[secrets\] PASS/.test(out(blob)), out(blob));

  // --staged (the pre-commit hook) catches a new kind in a staged file and ignores an unstaged one.
  const g = path.join(tmpRoot, `secrets-pu18-${process.pid}-git`);
  fs.rmSync(g, { recursive: true, force: true });
  fs.mkdirSync(g, { recursive: true });
  const git = (...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: g, encoding: 'utf8' });
  git('init', '-q');
  fs.writeFileSync(path.join(g, 'readme.txt'), 'hello\n');
  git('add', '-A');
  git('commit', '-qm', 'start');
  fs.writeFileSync(path.join(g, 'staged.env'), `WEBHOOK=${hook('discord.com')}\n`);
  fs.writeFileSync(path.join(g, 'loose.env'), `TELEGRAM_BOT_TOKEN=${telegram}\n`);
  git('add', 'staged.env');
  const scan = JSON.stringify(path.join(dir, 'scripts', 'secret-scan.mjs'));
  const staged = run(g, `node ${scan} --staged`);
  git('reset', '-q');
  fs.rmSync(path.join(g, 'staged.env'));
  git('add', 'loose.env');
  git('commit', '-qm', 'loose', '--no-verify');
  fs.writeFileSync(path.join(g, 'readme.txt'), 'hello again\n');
  git('add', 'readme.txt');
  const clean = run(g, `node ${scan} --staged`);
  report('PU-18 (P-040): --staged (the pre-commit hook) fails on a staged Discord webhook and lists only staged files; a clean staged change passes',
    staged.status === 1 && /staged\.env:1  discord-webhook-url/.test(out(staged)) && !/loose\.env/.test(out(staged)) && clean.status === 0, `${out(staged)}\n---\n${out(clean)}`);

  // The repo itself, this file included, stays clean.
  const self = run(dir, 'node scripts/secret-scan.mjs');
  report('PU-18 (P-040): the secret scan over the harness itself (this test file included) passes', self.status === 0 && /\[secrets\] PASS/.test(out(self)), out(self));
}
