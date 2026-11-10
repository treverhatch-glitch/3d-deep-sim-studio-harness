// 2.81 (b3), ported from the R2 trial (B4, P3; the cause classification only): every train verify gets a structured
// exitCause (the 37 live reds with no gate id were "exit N", "wrote no verify record" or "tested tree X, not Y" text).
// The trial's toolchain-keyed proof reuse is not part of this release.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function selftest281B3({ dir, report }) {
  const V = await import(pathToFileURL(path.join(dir, 'harness', 'verify-cause.mjs')).href);
  const rec = { tree: 'abc', scoped: false };
  const cases = [
    ['green', V.exitCause({ ok: true })],
    ['busy', V.exitCause({ busy: 'another heavy job holds the slot', noCheck: true, r: { status: 1 } })],
    ['no-check', V.exitCause({ noCheck: true, r: { status: 1 } })],
    ['fail', V.exitCause({ r: { status: 1 }, gates: ['golden'] })],
    ['exit', V.exitCause({ r: { status: 1 }, gates: [] })],
    ['signal', V.exitCause({ r: { status: null, signal: 'SIGKILL' } })],
    ['timeout', V.exitCause({ r: { status: null, error: { code: 'ETIMEDOUT' } } })],
    ['timeout', V.exitCause({ r: { status: 1 }, gates: [], text: 'ok 1\n[verify] timed out waiting for the gates' })],
    ['no-record', V.exitCause({ r: { status: 0 }, rec: null })],
    ['tree-mismatch', V.exitCause({ r: { status: 0 }, rec, tree: 'def' })],
    ['not-clean', V.exitCause({ r: { status: 0 }, rec: { ...rec, scoped: true }, tree: 'abc', all: true })],
  ];
  const wrong = cases.filter(([want, got]) => want !== got);
  report('exitCause: green, busy, no-check, fail (gate ids), exit (red with no gate id), signal, timeout, no-record, tree-mismatch and not-clean are each told apart from the run, the record and the tree', !wrong.length && cases.every(([want]) => V.EXIT_CAUSES.includes(want)), JSON.stringify(cases));
  const named = V.exitCause({ r: { status: 1 }, gates: ['game'], text: 'FAIL game\n[gates] a test timeout in gate game' });
  report('exitCause: a red that names its failing gate is a fail even when its last lines mention a timeout (the text guess is only for reds with no gate id)', named === 'fail', named);
  const train = fs.readFileSync(path.join(dir, 'harness', 'train.mjs'), 'utf8');
  report('train.mjs: task.train.verify meta and the verify result carry exitCause (fails on 2.80: no exitCause)', /const cause = exitCause\(\{ ok, r, rec, tree, gates, busy, noCheck, text \}\)/.test(train) && /meta: \{ train: id, tree, ok, gates, exitCause: cause/.test(train) && /const res = \{ ok, rec, gates, detail, why, exitCause: cause/.test(train), '');
}
