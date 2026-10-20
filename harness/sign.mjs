#!/usr/bin/env node
/**
 * harness/sign.mjs — signed results: who produced a verified result, and exactly what it was.
 *
 *   npm run sign -- keygen [--force]          make this studio's Ed25519 key pair
 *   npm run sign -- result --by <name> [--note "…"] [--allow-red]   sign the current results
 *   npm run sign -- verify <file> [--replay]  check a signed result (and, with --replay, re-run it)
 *   npm run sign -- fingerprint               print this studio's key fingerprint to publish
 *
 * A SHA-256 proves two states match; a signature proves who vouched for them. A signed result is a
 * manifest of the studio's verified state (every golden and regression's SHA-256, the last gate run,
 * the version and commit, the Game Bible's and asset manifest's SHA-256, who signed and when), signed
 * with Ed25519 from Node's built-in crypto. The private key stays in .studio/keys/ (never committed);
 * the public key goes in studio/keys/ so anyone with the repo can check. Publish the fingerprint
 * somewhere you control so others know the key is yours.
 *
 * `verify --replay` re-runs every golden: the strongest check, because it proves the code in hand
 * still produces the signed results, not only that someone signed them.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, STUDIO_STATE_DIR, emitEvent } from './event.mjs';
import { canonicalBytes } from './hash.mjs';

const PRIVATE = path.join(STUDIO_STATE_DIR, 'keys', 'studio-ed25519.pem');
const PUBLIC = path.join(REPO_ROOT, 'studio', 'keys', 'studio-ed25519.pub.pem');
const SIGNED_DIR = path.join(REPO_ROOT, 'studio', 'signed');
const rel = (p) => path.relative(REPO_ROOT, p).split(path.sep).join('/');
const fileSha = (p) => (fs.existsSync(p) ? crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') : null);

export function fingerprint(publicPem) {
  const der = crypto.createPublicKey(publicPem).export({ type: 'spki', format: 'der' });
  return crypto.createHash('sha256').update(der).digest('hex').slice(0, 32);
}

export function keygen({ force = false } = {}) {
  if (fs.existsSync(PRIVATE) && !force) return { ok: false, message: `A key already exists (${rel(PRIVATE)}). Replacing it means old signatures name a key you no longer hold; pass --force if you mean it.` };
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  fs.mkdirSync(path.dirname(PRIVATE), { recursive: true });
  fs.writeFileSync(PRIVATE, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  fs.mkdirSync(path.dirname(PUBLIC), { recursive: true });
  const pub = publicKey.export({ type: 'spki', format: 'pem' });
  fs.writeFileSync(PUBLIC, pub);
  emitEvent({ type: 'sign.keygen', agent: 'producer', msg: `Studio signing key made; fingerprint ${fingerprint(pub)}` });
  return { ok: true, fingerprint: fingerprint(pub), privateFile: rel(PRIVATE), publicFile: rel(PUBLIC) };
}

function pinned(dir) {
  const full = path.join(REPO_ROOT, dir);
  if (!fs.existsSync(full)) return [];
  return fs.readdirSync(full).filter((f) => f.endsWith('.json')).sort().map((f) => {
    const j = JSON.parse(fs.readFileSync(path.join(full, f), 'utf8'));
    return { file: `${dir}/${f}`, cartridge: j.cartridge || null, sha256: j.sha256 || null };
  });
}

export function buildManifest({ by, note = '' }) {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).stdout.trim() || null;
  const dirty = spawnSync('git', ['status', '--porcelain', '--', 'cartridges', 'src', 'qa/golden', 'qa/regressions'], { cwd: REPO_ROOT, encoding: 'utf8' }).stdout.trim();
  let gates = null;
  try {
    const g = JSON.parse(fs.readFileSync(path.join(STUDIO_STATE_DIR, 'gates-last.json'), 'utf8'));
    const req = (g.rows || []).filter((r) => r.required);
    gates = { at: g.at, requiredPassed: req.filter((r) => r.ok).length, required: req.length, failed: req.filter((r) => !r.ok).map((r) => r.id), partial: Boolean(g.partial) };
  } catch {
    gates = null;
  }
  return {
    kind: 'studio.result',
    harness: pkg.version,
    commit: head,
    uncommittedGameChanges: Boolean(dirty),
    goldens: pinned('qa/golden'),
    regressions: pinned('qa/regressions'),
    gates,
    bibleSha256: fileSha(path.join(REPO_ROOT, 'studio', 'bible', 'bible.json')),
    assetsSha256: fileSha(path.join(REPO_ROOT, 'studio', 'assets', 'manifest.json')),
    signedBy: by,
    note,
    at: new Date().toISOString(),
  };
}

export function signResult({ by, note = '', allowRed = false }) {
  if (!by) return { ok: false, message: 'Say who signs: --by <name>. A signature is a person or studio vouching for the result.' };
  if (!fs.existsSync(PRIVATE)) return { ok: false, message: 'No signing key yet: npm run sign -- keygen' };
  const manifest = buildManifest({ by, note });
  if (!manifest.gates) return { ok: false, message: 'No gate run recorded. Run npm run verify first, so the result is checked before it is signed.' };
  if ((manifest.gates.failed.length || manifest.gates.partial) && !allowRed) return { ok: false, message: `The last verify wasn't fully green (${manifest.gates.failed.join(', ') || 'partial run'}). Fix it and run npm run verify, or pass --allow-red to sign it as it is (the manifest records the failures).` };
  if (manifest.goldens.some((g) => !g.sha256)) return { ok: false, message: 'A golden has no sha256. Run npm run golden -- --update first.' };
  const privateKey = crypto.createPrivateKey(fs.readFileSync(PRIVATE));
  const publicPem = fs.readFileSync(PUBLIC, 'utf8');
  const signature = crypto.sign(null, Buffer.from(canonicalBytes(manifest)), privateKey).toString('base64');
  const doc = { manifest, manifestSha256: crypto.createHash('sha256').update(canonicalBytes(manifest)).digest('hex'), signature, algorithm: 'ed25519', publicKey: publicPem, fingerprint: fingerprint(publicPem) };
  fs.mkdirSync(SIGNED_DIR, { recursive: true });
  const file = path.join(SIGNED_DIR, `${manifest.at.slice(0, 16).replace(/[:T]/g, '-')}-${doc.manifestSha256.slice(0, 8)}.json`);
  fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
  emitEvent({ type: 'sign.result', agent: by, to: 'producer', msg: `Signed result ${rel(file)} (${manifest.goldens.length} goldens, gates ${manifest.gates.requiredPassed}/${manifest.gates.required}, key ${doc.fingerprint})` });
  return { ok: true, file: rel(file), doc };
}

export function verifyResult(file, { replay = false } = {}) {
  const full = path.resolve(file || '');
  if (!file || !fs.existsSync(full)) return { ok: false, problems: [`No signed result at ${file}`] };
  const doc = JSON.parse(fs.readFileSync(full, 'utf8'));
  const problems = [];
  const notes = [];
  let validSig = false;
  try {
    validSig = crypto.verify(null, Buffer.from(canonicalBytes(doc.manifest)), crypto.createPublicKey(doc.publicKey), Buffer.from(doc.signature, 'base64'));
  } catch (err) {
    problems.push(`signature can't be checked: ${err.message}`);
  }
  if (!validSig) problems.push('the signature does not match the manifest: it was changed after signing, or signed with another key');
  if (fingerprint(doc.publicKey) !== doc.fingerprint) problems.push('the fingerprint does not belong to the public key in the file');
  if (fs.existsSync(PUBLIC)) {
    if (fingerprint(fs.readFileSync(PUBLIC, 'utf8')) === doc.fingerprint) notes.push(`signed with this studio's key (${doc.fingerprint})`);
    else notes.push(`signed with another key (${doc.fingerprint}); check it against the fingerprint the signer published`);
  } else notes.push(`signer's fingerprint: ${doc.fingerprint}; check it against the one they published`);
  if (replay && validSig) {
    for (const g of [...doc.manifest.goldens, ...doc.manifest.regressions]) {
      const cur = fs.existsSync(path.join(REPO_ROOT, g.file)) ? JSON.parse(fs.readFileSync(path.join(REPO_ROOT, g.file), 'utf8')).sha256 : null;
      if (cur !== g.sha256) problems.push(`${g.file}: the repo pins ${cur || 'nothing'}, the signed result says ${g.sha256}`);
    }
    const rerun = [spawnSync(process.execPath, [path.join(REPO_ROOT, 'qa', 'check-golden.mjs')], { cwd: REPO_ROOT, encoding: 'utf8' }), spawnSync(process.execPath, [path.join(REPO_ROOT, 'qa', 'check-regressions.mjs')], { cwd: REPO_ROOT, encoding: 'utf8' })];
    rerun.forEach((r, i) => {
      if (r.status !== 0) problems.push(`re-running the ${i ? 'regressions' : 'goldens'} failed:\n${(r.stdout + r.stderr).trim().split('\n').slice(-4).join('\n')}`);
    });
    if (!problems.length) notes.push('re-ran every golden and regression: this code produces the signed results');
  }
  return { ok: problems.length === 0, problems, notes, manifest: doc.manifest };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const flag = (k) => {
    const i = argv.indexOf(`--${k}`);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
  };
  const cmd = argv[0];
  if (cmd === 'keygen') {
    const r = keygen({ force: argv.includes('--force') });
    if (!r.ok) {
      console.error(r.message);
      process.exit(1);
    }
    console.log(`Key made. Private: ${r.privateFile} (never commit or share it). Public: ${r.publicFile}.\nFingerprint: ${r.fingerprint}\nPublish the fingerprint somewhere you control, so others can tell your signatures from anyone else's.`);
  } else if (cmd === 'fingerprint') {
    if (!fs.existsSync(PUBLIC)) {
      console.error('No key yet: npm run sign -- keygen');
      process.exit(1);
    }
    console.log(fingerprint(fs.readFileSync(PUBLIC, 'utf8')));
  } else if (cmd === 'result') {
    const r = signResult({ by: flag('by'), note: flag('note') || '', allowRed: argv.includes('--allow-red') });
    if (!r.ok) {
      console.error(r.message);
      process.exit(1);
    }
    console.log(`Signed: ${r.file}\n${r.doc.manifest.goldens.length} goldens, ${r.doc.manifest.regressions.length} regressions, gates ${r.doc.manifest.gates.requiredPassed}/${r.doc.manifest.gates.required}, commit ${String(r.doc.manifest.commit).slice(0, 7)}, key ${r.doc.fingerprint}`);
  } else if (cmd === 'verify') {
    const r = verifyResult(argv[1], { replay: argv.includes('--replay') });
    for (const n of r.notes) console.log(`  ${n}`);
    for (const p of r.problems) console.error(`  FAIL ${p}`);
    console.log(r.ok ? 'Valid.' : 'Not valid.');
    process.exit(r.ok ? 0 : 1);
  } else {
    console.log('Usage: npm run sign -- keygen | fingerprint | result --by <name> [--note "…"] [--allow-red] | verify <file> [--replay]');
    process.exit(1);
  }
}
