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
 * The manifest binds code, inputs and outputs: a SHA-256 over each cartridge's files, each golden and
 * regression file's own SHA-256 (seed, tick, actions) and the state SHA-256 it pins. Signing refuses a
 * gate run that is red, partial, missing a required gate, or older than the last game change.
 *
 * `verify --replay` checks the code in hand is the signed code, then re-runs the goldens,
 * regressions, purity and isolation checks and the vertical slice: proof the code still produces
 * the signed results, not only that someone signed them.
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
    // fileSha256 binds the inputs too (seed, tick, actions, scenario), not only the end state.
    return { file: `${dir}/${f}`, cartridge: j.cartridge || null, sha256: j.sha256 || null, actionsSha256: j.actionsSha256 || null, fileSha256: fileSha(path.join(full, f)) };
  });
}

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === 'node_modules' || ent.name === '__pycache__' || ent.name.startsWith('.')) continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/** One SHA-256 over a folder: every file's path and SHA-256, sorted. Changes if any file is added, removed or edited. */
export function treeSha(dir) {
  const files = walk(dir).map((f) => `${rel(f)}\u0000${fileSha(f)}`).sort();
  return files.length ? crypto.createHash('sha256').update(files.join('\n')).digest('hex') : null;
}

/** The code that produces results: each cartridge, plus the harness files that run and hash it. */
export function codeHashes() {
  const cdir = path.join(REPO_ROOT, 'cartridges');
  const names = fs.existsSync(cdir) ? fs.readdirSync(cdir, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('_')).map((d) => d.name).sort() : [];
  return {
    cartridges: names.map((name) => ({ name, sha256: treeSha(path.join(cdir, name)) })),
    harnessSha256: crypto.createHash('sha256').update(['harness/cartridge.mjs', 'harness/hash.mjs'].map((f) => `${f}\u0000${fileSha(path.join(REPO_ROOT, f))}`).join('\n')).digest('hex'),
  };
}

/** Newest edit to game code or pinned results, so a gate run older than it describes another build. */
function lastResultChange() {
  return ['cartridges', 'src', 'qa/golden', 'qa/regressions'].flatMap((d) => walk(path.join(REPO_ROOT, d))).reduce((m, f) => Math.max(m, fs.statSync(f).mtimeMs), 0);
}

export function buildManifest({ by, note = '' }) {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).stdout.trim() || null;
  const dirty = spawnSync('git', ['status', '--porcelain', '--', 'cartridges', 'src', 'qa/golden', 'qa/regressions'], { cwd: REPO_ROOT, encoding: 'utf8' }).stdout.trim();
  let gates = null;
  try {
    const g = JSON.parse(fs.readFileSync(path.join(STUDIO_STATE_DIR, 'gates-last.json'), 'utf8'));
    const req = (g.rows || []).filter((r) => r.required);
    let expected = [];
    try {
      expected = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'studio', 'gates.json'), 'utf8')).gates.filter((x) => x.required).map((x) => x.id);
    } catch {
      expected = [];
    }
    const ran = new Set((g.rows || []).map((r) => r.id));
    gates = {
      at: g.at,
      requiredPassed: req.filter((r) => r.ok).length,
      required: req.length,
      failed: req.filter((r) => !r.ok).map((r) => r.id),
      missing: expected.filter((id) => !ran.has(id)),
      fresh: (Date.parse(g.at) || 0) >= lastResultChange(),
      partial: Boolean(g.partial),
    };
  } catch {
    gates = null;
  }
  return {
    kind: 'studio.result',
    gameId: (() => {
      try {
        const g = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'studio', 'game.json'), 'utf8')).cartridge;
        return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'cartridges', g, 'cartridge.json'), 'utf8')).id || null;
      } catch {
        return null;
      }
    })(),
    harness: pkg.version,
    commit: head,
    uncommittedGameChanges: Boolean(dirty),
    goldens: pinned('qa/golden'),
    regressions: pinned('qa/regressions'),
    code: codeHashes(),
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
  const g = manifest.gates;
  const red = [g.failed.length ? `failed: ${g.failed.join(', ')}` : '', g.missing.length ? `required gates that never ran: ${g.missing.join(', ')}` : '', g.partial ? 'a partial run (--only)' : '', g.fresh ? '' : 'older than the last change to the game or its goldens'].filter(Boolean);
  if (red.length && !allowRed) return { ok: false, message: `The last verify can't vouch for this build (${red.join('; ')}). Run npm run verify, or pass --allow-red to sign it as it is (the manifest records why).` };
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
    for (const g of [...doc.manifest.goldens, ...doc.manifest.regressions].filter((x) => x.fileSha256)) {
      const cur = fileSha(path.join(REPO_ROOT, g.file));
      if (cur && cur !== g.fileSha256) problems.push(`${g.file}: its inputs changed since signing (seed, tick, actions or scenario)`);
    }
    if (doc.manifest.code) {
      const now = codeHashes();
      for (const c of doc.manifest.code.cartridges) {
        const cur = now.cartridges.find((x) => x.name === c.name)?.sha256;
        if (cur !== c.sha256) problems.push(`cartridges/${c.name}: the code differs from the signed code`);
      }
      if (now.harnessSha256 !== doc.manifest.code.harnessSha256) notes.push('the harness runner or hash files differ from the signed ones (results still re-checked below)');
    }
    const checks = [
      ['goldens', 'qa/check-golden.mjs'],
      ['regressions', 'qa/check-regressions.mjs'],
      ['purity check', 'scripts/check-sim-purity.mjs'],
      ['isolation check', 'scripts/check-sim-isolation.mjs'],
      ['vertical slice', 'qa/vertical-slice.mjs'],
    ];
    for (const [label, script] of checks) {
      const r = spawnSync(process.execPath, [path.join(REPO_ROOT, script)], { cwd: REPO_ROOT, encoding: 'utf8' });
      if (r.status !== 0) problems.push(`re-running the ${label} failed:\n${(r.stdout + r.stderr).trim().split('\n').slice(-4).join('\n')}`);
    }
    if (!problems.length) notes.push('re-ran every golden and regression, the purity and isolation checks and the vertical slice on the signed code: this code produces the signed results');
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
