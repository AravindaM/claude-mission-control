import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { createGh } from '../src/gh.js';

// Spawn is injected so nothing shells out: the tests stay fast and hermetic,
// the same seam briefer.test.js relies on.
function fakeSpawn({ viewer = 'demo-user', prs = {}, viewerDelayMs = 5 } = {}) {
  const calls = [];
  const spawn = (cmd, args) => {
    calls.push(args);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    const isViewer = args[0] === 'api';
    const url = args[2];
    const number = url && url.match(/\/pull\/(\d+)/)?.[1];
    const payload = isViewer ? viewer : JSON.stringify(prs[number] ?? {});
    const code = isViewer && viewer == null ? 1 : 0;
    // The viewer call is deliberately slower, which is what lets a stampede
    // show up: several PR lookups are in flight before it resolves.
    setTimeout(() => {
      if (code === 0) child.stdout.emit('data', payload);
      child.emit('close', code);
    }, isViewer ? viewerDelayMs : 0);
    return child;
  };
  return { spawn, calls };
}

const PR = (over = {}) => ({
  number: 1, title: 'A change', author: { login: 'other-dev' },
  state: 'OPEN', isDraft: false, reviewDecision: null, mergedAt: null, ...over,
});

describe('gh', () => {
  it('maps a pr into the shape the store records', async () => {
    const { spawn } = fakeSpawn({ prs: { 212: PR({ number: 212, reviewDecision: 'APPROVED' }) } });
    const gh = createGh({ config: { ghBin: 'gh' }, spawn });
    const res = await gh.fetchPr('https://github.com/example/api/pull/212');
    expect(res).toMatchObject({
      title: 'A change', authorLogin: 'other-dev', isMe: false,
      state: 'open', reviewDecision: 'APPROVED', isDraft: false,
    });
  });

  it('recognises your own pr', async () => {
    const { spawn } = fakeSpawn({ prs: { 1: PR({ author: { login: 'demo-user' } }) } });
    const gh = createGh({ config: {}, spawn });
    expect((await gh.fetchPr('https://github.com/example/api/pull/1')).isMe).toBe(true);
  });

  // Regression: the viewer lookup used to set a `checked` flag BEFORE its await
  // resolved, so concurrent callers read an undefined login and every PR added
  // in one breath came back unclassified. POST /api/prs does not await its
  // lookup, so concurrency here is the normal path.
  it('resolves the viewer once even when lookups overlap', async () => {
    const { spawn, calls } = fakeSpawn({
      prs: { 1: PR({ author: { login: 'demo-user' } }), 2: PR(), 3: PR() },
      viewerDelayMs: 20,
    });
    const gh = createGh({ config: {}, spawn });
    const [a, b, c] = await Promise.all([
      gh.fetchPr('https://github.com/example/api/pull/1'),
      gh.fetchPr('https://github.com/example/api/pull/2'),
      gh.fetchPr('https://github.com/example/api/pull/3'),
    ]);
    expect([a.isMe, b.isMe, c.isMe]).toEqual([true, false, false]);
    expect(calls.filter((args) => args[0] === 'api').length).toBe(1);
  });

  it('reports isMe as null when the viewer cannot be resolved', async () => {
    // null, never false: filing your own PR under someone else's looks
    // entirely plausible and is wrong.
    const { spawn } = fakeSpawn({ viewer: null, prs: { 1: PR() } });
    const gh = createGh({ config: {}, spawn });
    expect((await gh.fetchPr('https://github.com/example/api/pull/1')).isMe).toBeNull();
  });

  it('turns a failure into a value rather than throwing', async () => {
    const spawn = () => { throw new Error('spawn ENOENT gh'); };
    const gh = createGh({ config: {}, spawn });
    const res = await gh.fetchPr('https://github.com/example/api/pull/1');
    expect(res.error).toMatch(/ENOENT/);
  });

  it('reports unparseable output instead of crashing the sweep', async () => {
    const spawn = () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      setTimeout(() => { child.stdout.emit('data', 'not json'); child.emit('close', 0); }, 0);
      return child;
    };
    const gh = createGh({ config: {}, spawn });
    expect((await gh.fetchPr('https://github.com/example/api/pull/1')).error).toMatch(/unparseable/);
  });

  it('parses mergedAt into a timestamp', async () => {
    const { spawn } = fakeSpawn({
      prs: { 1: PR({ state: 'MERGED', mergedAt: '2026-09-09T10:00:00Z' }) },
    });
    const gh = createGh({ config: {}, spawn });
    const res = await gh.fetchPr('https://github.com/example/api/pull/1');
    expect(res.state).toBe('merged');
    expect(res.mergedAt).toBe(Date.parse('2026-09-09T10:00:00Z'));
  });
});
