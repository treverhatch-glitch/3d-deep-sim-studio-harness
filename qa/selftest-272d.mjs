/**
 * qa/selftest-272d.mjs — 2.72.0 (helper d): the self-test's CI shards (the gameplay logic library it also tested was cut in 2.80.0).
 *   shards     `qa/selftest.mjs --list-shards N`: every unit in exactly one shard, every shard non-empty, the same split
 *              twice, the owner-key group together, no check outside a unit, every top-level block guarded; a bad
 *              --shard is refused; a one-unit shard runs only its unit; an empty shard fails.
 *   except     `run-gates --except <ids>` leaves those gates out (named as skipped), the run is partial; an unknown id
 *              is refused.
 *   ci         the release-gate and windows jobs run everything but the self-test, the self-test runs in N shard jobs
 *              (--shard i/N, i = 1..N) on each, and a summary job fails when any of them did not pass.
 * Made-up modules and games; no network.
 */
import fs from 'node:fs';
import path from 'node:path';

export async function selftest272D({ dir, run, report, tmpRoot }) {
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const guard = async (name, fn) => { try { const [ok, detail] = await fn(); report(name, Boolean(ok), detail); } catch (e) { report(name, false, e.stack || String(e)); } };
  const base = {
    STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_MAIN_ROOT: '', STUDIO_LOCK_OWNER: '', STUDIO_ROLE: '', STUDIO_AGENT: '',
    STUDIO_VERIFY_DETACH: 'off', STUDIO_GAME: '', CLAUDECODE: '', AI_AGENT: '', CODEX_SANDBOX: '', GEMINI_CLI: '', npm_lifecycle_event: '',
    STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-272d-${process.pid}.pem`), ...ident,
  };
  // ---- shards ----
  const selftestSrc = (() => { try { return fs.readFileSync(path.join(dir, 'qa', 'selftest.mjs'), 'utf8'); } catch { return ''; } })();
  const hasShards = /function inShard\(/.test(selftestSrc);
  // Without the shard code an unknown flag would run the whole self-test: only ask a self-test that has it.
  const listOf = (n) => {
    if (!hasShards) return { status: 1, json: null, text: 'qa/selftest.mjs has no shards (no inShard)' };
    const r = run(dir, `node qa/selftest.mjs --list-shards ${n}`, base);
    let json = null;
    try { json = JSON.parse(String(r.stdout).trim().split('\n').pop()); } catch {}
    return { status: r.status, json, text: out(r).slice(-1500) };
  };
  await guard('2.72.0 (d shards): `qa/selftest.mjs --list-shards 4` puts every unit (each top-level block, each gate\'s sabotage) in exactly one shard, every shard has units, the split is the same twice, the owner-key group (267g, 270v) shares a shard, no check runs outside a unit, every top-level block starts with the guard; 1 shard holds all and 3 shards hold the same units (fails on 2.71.1: no shards)', () => {
    const a = listOf(4);
    const b = listOf(4);
    const one = listOf(1);
    const three = listOf(3);
    const units = a.json?.units || [];
    const labels = units.map((u) => u.label);
    const per = [1, 2, 3, 4].map((i) => units.filter((u) => u.shard === i).length);
    const owner = units.filter((u) => u.group === 'owner-key');
    const bare = selftestSrc.split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => /^\{\s*$/.test(l));
    const sab = units.filter((u) => /^sabotage:/.test(u.label)).length;
    return [a.status === 0 && units.length > 150 && new Set(labels).size === labels.length && units.every((u) => [1, 2, 3, 4].includes(u.shard)) && per.every((c) => c > 0)
      && JSON.stringify(a.json) === JSON.stringify(b.json) && owner.length === 2 && owner[0].shard === owner[1].shard && (a.json.strays || []).length === 0 && bare.length === 0 && sab >= 10
      && labels.includes('control') && labels.includes('selftest-272d') && one.json?.units.every((u) => u.shard === 1) && JSON.stringify(three.json?.units.map((u) => u.label)) === JSON.stringify(labels),
    `${a.text.slice(0, 600)}\nper shard ${per}\nbare blocks ${JSON.stringify(bare.slice(0, 5))}\nowner ${JSON.stringify(owner)}`];
  });

  await guard('2.72.0 (d shard run): `--shard 0/4`, `--shard 5/4` and `--list-shards 0` are refused (exit 2); a shard holding only the hash unit runs that unit\'s checks and no other, and says so; a shard past the last unit fails as empty (fails on 2.71.1: no shards)', () => {
    if (!hasShards) return [false, 'qa/selftest.mjs has no shards (no inShard)'];
    const bad = ['--shard 0/4', '--shard 5/4', '--shard x', '--list-shards 0'].map((f) => run(dir, `node qa/selftest.mjs ${f}`, base));
    const keys = listOf(1).json?.units || [];
    const n = new Set(keys.map((u) => (u.group ? `g:${u.group}` : u.label))).size;
    const k = listOf(n).json?.units.find((u) => u.label === 'hashes')?.shard;
    const one = run(dir, `node qa/selftest.mjs --shard ${k}/${n}`, base);
    const empty = run(dir, `node qa/selftest.mjs --shard ${n + 1}/${n + 1}`, base);
    const passes = (out(one).match(/^\[selftest\] PASS /gm) || []).length;
    return [bad.every((r) => r.status === 2) && one.status === 0 && passes >= 3 && /PASS the display hash is standard FNV-1a 64-bit/.test(out(one)) && !/control: gate/.test(out(one)) && new RegExp(`shard ${k}/${n}: ran 1 of ${keys.length} unit\\(s\\)`).test(out(one))
      && empty.status !== 0 && /has no unit: it checked nothing/.test(out(empty)), `${bad.map((r) => r.status)}\n${out(one).slice(-800)}\n---\n${out(empty).slice(-400)}`];
  });

  // ---- run-gates --except ----
  await guard('2.72.0 (d except): `run-gates --except <ids>` leaves those gates out and names them as skipped (--except); the run is partial (its record says so); an id that isn\'t a gate is refused (fails on 2.71.1: --except was ignored and every gate ran)', () => {
    // Two cheap gates stand for the studio's list, so the run without --only stays short; put back after.
    const gf = path.join(dir, 'studio', 'gates.json');
    const kept = fs.readFileSync(gf, 'utf8');
    const two = JSON.parse(kept).gates.filter((x) => ['secrets', 'docs'].includes(x.id));
    let r; let rec; let full; let typo;
    try {
      fs.writeFileSync(gf, JSON.stringify({ gates: two }, null, 2));
      for (const f of ['gates-last.json', 'gates-last-full.json']) fs.rmSync(path.join(dir, '.studio', f), { force: true });
      r = run(dir, 'node scripts/run-gates.mjs --required-only --deep --except docs', base);
      rec = (() => { try { return JSON.parse(fs.readFileSync(path.join(dir, '.studio/gates-last.json'), 'utf8')); } catch { return null; } })();
      full = fs.existsSync(path.join(dir, '.studio', 'gates-last-full.json'));
      typo = run(dir, 'node scripts/run-gates.mjs --required-only --except selftst', base);
    } finally { fs.writeFileSync(gf, kept); }
    return [two.length === 2 && r.status === 0 && /skipped docs \(--except\)/.test(out(r)) && /PASS\s+secrets/.test(out(r)) && !/PASS\s+docs/.test(out(r)) && rec?.partial === true && !full && typo.status === 2 && /not a gate: selftst/.test(out(typo)), `${out(r).slice(-1200)}\n${JSON.stringify(rec)?.slice(0, 300)} full=${full}\n---\n${out(typo).slice(-300)}`];
  });

  // ---- CI ----
  await guard('2.72.0 (d ci): CI runs the release checks without the self-test (release.mjs / run-gates --except selftest, Linux and Windows), the self-test in N parallel shard jobs on each (node qa/selftest.mjs --shard ${{ matrix.shard }}/N, shards 1..N, both Node versions on Linux), and a summary job that needs all of them and fails unless each succeeded (fails on 2.71.1: one serial self-test)', () => {
    const ci = fs.readFileSync(path.join(dir, '.github/workflows/ci.yml'), 'utf8').replace(/\r\n/g, '\n');
    const jobs = Object.fromEntries([...(ci.split(/^jobs:\n/m)[1] || '').matchAll(/^ {2}([a-z0-9-]+):\n((?: {4}.*\n|\n)*)/gm)].map((m) => [m[1], m[2]]));
    const shardJob = (name) => {
      const b = jobs[name] || '';
      const N = Number((b.match(/node qa\/selftest\.mjs --shard \$\{\{ matrix\.shard \}\}\/(\d+)/) || [])[1]);
      const list = ((b.match(/shard: \[([\d, ]+)\]/) || [])[1] || '').split(',').map((x) => Number(x.trim()));
      return N >= 2 && JSON.stringify(list) === JSON.stringify(Array.from({ length: N }, (_, i) => i + 1)) && /fail-fast: false/.test(b);
    };
    const sum = jobs['release-gate-summary'] || '';
    return [/node scripts\/release\.mjs --except selftest/.test(jobs['release-gate'] || '') && /run-gates\.mjs --required-only --deep --except selftest/.test(jobs.windows || '')
      && shardJob('release-gate-selftest') && /node: \['22', '24'\]/.test(jobs['release-gate-selftest'] || '') && shardJob('windows-selftest') && /runs-on: windows-latest/.test(jobs['windows-selftest'] || '')
      && /needs: \[release-gate, release-gate-selftest, windows, windows-selftest\]/.test(sum) && /if: always\(\)/.test(sum) && /!= "success"/.test(sum) && /exit 1/.test(sum),
    Object.keys(jobs).join(', ')];
  });
}
