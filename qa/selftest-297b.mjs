/**
 * qa/selftest-297b.mjs — 2.97 (b): the union merge (engines.<x>.merge.union) also takes a line both lanes only lengthen
 * (one quoted list each lane appends to), and a refusal says why, naming the file and the base line.
 * Real git repositories in a temp folder; chainOnTarget is called directly.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { gEnvOf, gitUserCrlfOf, guardCap3000Of, writeIn as write } from './kit.mjs';

export async function selftest297B({ dir, report, tmpRoot }) {
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const g = gitUserCrlfOf(gEnvOf(ident));
  const guard = guardCap3000Of(report);
  const T = path.join(tmpRoot, `s297b-${process.pid}`);
  fs.mkdirSync(T, { recursive: true });
  const { chainOnTarget } = await import(pathToFileURL(path.join(dir, 'harness', 'unity-train.mjs')).href);
  const { unionWhy } = await import(pathToFileURL(path.join(dir, 'harness', 'merge-union.mjs')).href);
  let n = 0;
  // A repo with `files` on port/main and one branch per entry of `lanes` ({ name: { file: text } }); returns the lanes.
  const make = (files, lanes) => {
    const R = path.join(T, `r${++n}`);
    fs.mkdirSync(R, { recursive: true });
    g(R, 'init', '-q', '-b', 'port/main');
    for (const [f, t] of Object.entries(files)) write(R, f, t);
    g(R, 'add', '-A'); g(R, 'commit', '-qm', 'start');
    const out = [];
    for (const [name, edits] of Object.entries(lanes)) {
      g(R, 'checkout', '-q', '-b', name, 'port/main');
      for (const [f, t] of Object.entries(edits)) write(R, f, t);
      g(R, 'add', '-A'); g(R, 'commit', '-qm', name);
      out.push({ task: name, branch: name, head: g(R, 'rev-parse', name).stdout.trim() });
    }
    g(R, 'checkout', '-q', 'port/main');
    return { R, lanes: out, base: g(R, 'rev-parse', 'port/main').stdout.trim() };
  };
  const show = (R, ref, f) => g(R, 'show', `${ref}:${f}`).stdout;
  const L = 'Game/List.cs';
  const TT = 'tools/SimTests/Names.cs';
  const both = [L, TT];
  const list = (...x) => `items:\n${x.map((y) => `  ${y}\n`).join('')}end\n`;
  const names = (s) => `Assert.AreEqual("${s}", Names());\n`;

  try {
    {
      const E = make({ [L]: list('a', 'b'), [TT]: names('a,b,c') }, {
        x: { [L]: list('a', 'x1', 'x2', 'b'), [TT]: names('a,b,c,d') },
        y: { [L]: list('a', 'y1', 'y2', 'b'), [TT]: names('a,b,c,e') },
      });
      const c = chainOnTarget(E.R, E.base, E.lanes, 't', 'unity', { union: both });
      await guard('2.97 (b1) two lanes that each append to one quoted line and add lines to a list file both ride one chain: the line holds ours\' names then theirs\', both files are listed (fails before: the second lane was deferred)', () => [
        c.included?.length === 2 && !c.deferred?.length && show(E.R, c.head, TT) === names('a,b,c,d,e') && show(E.R, c.head, L) === list('a', 'x1', 'x2', 'y1', 'y2', 'b') && c.union?.[0]?.files.slice().sort().join() === both.slice().sort().join(), JSON.stringify(c)]);
    }
    {
      const E = make({ [TT]: names('a,b,c') }, { x: { [TT]: names('a,b,c,d') }, y: { [TT]: names('a,b,c,d') } });
      const c = chainOnTarget(E.R, E.base, E.lanes, 't', 'unity', { union: both });
      await guard('2.97 (b2) the same insertion by both sides is kept once (fails before: the second lane was deferred)', () => [
        c.included?.length === 2 && show(E.R, c.head, TT) === names('a,b,c,d'), JSON.stringify(c)]);
    }
    {
      const E = make({ [TT]: names('b,c') }, { x: { [TT]: names('a,b,c') }, y: { [TT]: names('b,c,d') } });
      const c = chainOnTarget(E.R, E.base, E.lanes, 't', 'unity', { union: both });
      await guard('2.97 (b3) insertions at two places of one line are both applied (fails before: the second lane was deferred)', () => [
        c.included?.length === 2 && show(E.R, c.head, TT) === names('a,b,c,d'), JSON.stringify(c)]);
    }
    {
      const E = make({ [L]: list('a', 'b', 'c') }, { x: { [L]: list('a', 'b', 'zz') }, y: { [L]: list('a', 'b', 'qq') } });
      const c = chainOnTarget(E.R, E.base, E.lanes, 't', 'unity', { union: both });
      const w = unionWhy(E.R, E.lanes[0].head, E.lanes[1].head, both);
      await guard('2.97 (b4) a rewritten line stays a conflict and the reason names the file and the base line, also in the lane\'s why (fails before: no reason)', () => [
        c.deferred?.length === 1 && w === `${L} line 4 was rewritten, not only lengthened` && c.deferred[0].why.includes(`merge.union did not apply: ${w}`), JSON.stringify({ w, c })]);
    }
    {
      const crlf = (s) => s.replace(/\n/g, '\r\n');
      const E = make({ [L]: crlf(list('a', 'b')), [TT]: crlf(names('a,b,c')) }, {
        x: { [L]: crlf(list('a', 'x1', 'b')), [TT]: crlf(names('a,b,c,d')) },
        y: { [L]: crlf(list('a', 'y1', 'b')), [TT]: crlf(names('a,b,c,e')) },
      });
      const c = chainOnTarget(E.R, E.base, E.lanes, 't', 'unity', { union: both });
      await guard('2.97 (b5) a CRLF file comes back with CRLF on every line, the grown line too (fails before: the second lane was deferred)', () => [
        c.included?.length === 2 && show(E.R, c.head, TT) === crlf(names('a,b,c,d,e')) && show(E.R, c.head, L) === crlf(list('a', 'x1', 'y1', 'b')), JSON.stringify(c)]);
    }
    {
      const E = make({ [L]: list('a'), 'Other.cs': 'one\n' }, { x: { [L]: list('a', 'x'), 'Other.cs': 'two\n' }, y: { [L]: list('a', 'y'), 'Other.cs': 'three\n' } });
      const c = chainOnTarget(E.R, E.base, E.lanes, 't', 'unity', { union: [L] });
      const w = unionWhy(E.R, E.lanes[0].head, E.lanes[1].head, [L]);
      await guard('2.97 (b6) a conflicted file outside merge.union is named in the reason; with no setting the reason is empty (fails before: no reason)', () => [
        c.deferred?.length === 1 && w.includes('Other.cs') && w.includes('not listed in merge.union') && c.deferred[0].why.includes(w) && unionWhy(E.R, E.lanes[0].head, E.lanes[1].head, []) === '', JSON.stringify({ w, c })]);
    }
    {
      const E = make({ [L]: list('a', 'b') }, { x: { [L]: list('a', 'x', 'b') }, y: { [L]: list('a', 'y', 'b') }, z: { [L]: list('a', 'z', 'b') } });
      const c = chainOnTarget(E.R, E.base, E.lanes, 't', 'unity', { union: both });
      await guard('2.96 behaviour kept (b7) lanes that only add lines still ride one chain in order, with no reason added', () => [
        c.included?.length === 3 && show(E.R, c.head, L) === list('a', 'x', 'y', 'z', 'b') && !c.deferred?.length, JSON.stringify(c)]);
    }
  } finally {
    try { fs.rmSync(T, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 }); } catch { /* the sweep */ }
  }
}
