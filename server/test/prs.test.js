import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import matter from 'gray-matter';
import { openDb } from '../src/db.js';
import { createPaths } from '../src/paths.js';
import { createTask, softDelete, archiveTask } from '../src/taskstore.js';
import {
  canonicalizePrUrl, addPr, listPrs, getPr, setPrOrder, setPrTask,
  deletePr, applyGhResult, reindexPrs, dueForRefresh, GH_FAILURE_CAP,
} from '../src/prs.js';

describe('canonicalizePrUrl', () => {
  // The whole dedup story rests on this. `.../pull/212` and `.../pull/212/files`
  // are different strings, so a UNIQUE index on the raw input would happily
  // store both — and a browser address bar is usually sitting on /files.
  it('collapses every form of the same PR to one url', () => {
    const same = [
      'https://github.com/example/api/pull/212',
      'https://github.com/example/api/pull/212/',
      'https://github.com/example/api/pull/212/files',
      'https://github.com/example/api/pull/212/commits/abc123',
      'https://github.com/example/api/pull/212#discussion_r99',
      'https://github.com/example/api/pull/212?w=1',
      'https://www.github.com/example/api/pull/212',
      '  https://github.com/example/api/pull/212  ',
    ].map((u) => canonicalizePrUrl(u).url);
    expect(new Set(same).size).toBe(1);
    expect(same[0]).toBe('https://github.com/example/api/pull/212');
  });

  it('keeps enterprise hosts distinct from github.com', () => {
    const a = canonicalizePrUrl('https://github.com/example/api/pull/1');
    const b = canonicalizePrUrl('https://git.example-corp.dev/example/api/pull/1');
    expect(a.url).not.toBe(b.url);
    expect(b.host).toBe('git.example-corp.dev');
  });

  it('pulls out host, owner, repo and number before gh is ever consulted', () => {
    const parsed = canonicalizePrUrl('https://github.com/example/api/pull/212/files');
    expect(parsed).toMatchObject({
      host: 'github.com', owner: 'example', repo: 'api', number: 212,
    });
  });

  it('rejects anything that is not a pull request url', () => {
    for (const bad of [
      '', 'not a url', 'https://github.com/example/api',
      'https://github.com/example/api/issues/7',
      'https://github.com/example/api/pull/notanumber',
      'ftp://github.com/example/api/pull/1',
    ]) {
      expect(() => canonicalizePrUrl(bad)).toThrow();
    }
  });
});

describe('pr store', () => {
  let ctx;
  const url = (n) => `https://github.com/example/api/pull/${n}`;

  beforeEach(() => {
    const dataDir = mkdtempSync(join(tmpdir(), 'mc-prs-'));
    const paths = createPaths(dataDir);
    paths.ensureBaseDirs();
    ctx = { db: openDb(paths.dbFile()), paths };
  });

  it('adds a pr, parsing identity from the url with no gh involved', () => {
    const pr = addPr(ctx, { url: url(212) + '/files' });
    expect(pr).toMatchObject({
      url: url(212), host: 'github.com', owner: 'example', repo: 'api', number: 212,
      state: 'open', position: 1,
    });
    expect(pr.author_is_me).toBeNull(); // unknown until gh says otherwise
  });

  it('re-adding a tracked pr in another url form updates rather than duplicating', () => {
    const first = addPr(ctx, { url: url(212) });
    const again = addPr(ctx, { url: url(212) + '#discussion_r1' });
    expect(again.id).toBe(first.id);
    expect(listPrs(ctx).length).toBe(1);
  });

  it('new prs land at the bottom', () => {
    const a = addPr(ctx, { url: url(1) });
    const b = addPr(ctx, { url: url(2) });
    expect(b.position).toBeGreaterThan(a.position);
  });

  it('writes a durable file holding only what gh cannot re-supply', () => {
    const task = createTask(ctx, { title: 'Auth rate limit' });
    const pr = addPr(ctx, { url: url(212), taskId: task.id });
    applyGhResult(ctx, pr.id, { title: 'Real title from gh', authorLogin: 'someone', state: 'open' });

    const fm = matter(readFileSync(ctx.paths.prFile('github.com', 'example', 'api', 212), 'utf8')).data;
    expect(fm).toMatchObject({ url: url(212), task: task.slug, position: 1 });
    // cached fields are deliberately absent: gh re-supplies them within the hour
    expect(fm.title).toBeUndefined();
    expect(fm.state).toBeUndefined();
  });

  it('survives losing the database entirely', () => {
    const task = createTask(ctx, { title: 'Auth rate limit' });
    const keep = addPr(ctx, { url: url(212), taskId: task.id });
    addPr(ctx, { url: url(99) });
    setPrOrder(ctx, [keep.id]); // give it a deliberate position

    ctx.db.prepare('DELETE FROM prs').run();
    reindexPrs(ctx);

    const rebuilt = listPrs(ctx);
    expect(rebuilt.length).toBe(2);
    const one = rebuilt.find((p) => p.number === 212);
    expect(one.url).toBe(url(212));
    expect(one.task_id).toBe(task.id);
    expect(one.state).toBe('open'); // status is a cache; the sweep refills it
  });

  it('reindex resolves an unknown task slug to null rather than dropping the pr', () => {
    const task = createTask(ctx, { title: 'Doomed' });
    addPr(ctx, { url: url(212), taskId: task.id });
    ctx.db.prepare('DELETE FROM tasks').run();
    ctx.db.prepare('DELETE FROM prs').run();
    reindexPrs(ctx);
    expect(listPrs(ctx)[0]).toMatchObject({ url: url(212), task_id: null });
  });

  // A row deleted while its file survives comes back on the next reindex, and
  // the user has no way to get rid of it.
  it('deleting a pr removes its file so reindex cannot resurrect it', () => {
    const pr = addPr(ctx, { url: url(212) });
    const file = ctx.paths.prFile('github.com', 'example', 'api', 212);
    expect(existsSync(file)).toBe(true);

    deletePr(ctx, pr.id);
    expect(existsSync(file)).toBe(false);
    reindexPrs(ctx);
    expect(listPrs(ctx).length).toBe(0);
  });

  it('setPrOrder permutes only the positions the given ids already hold', () => {
    const a = addPr(ctx, { url: url(1) });
    const b = addPr(ctx, { url: url(2) });
    const c = addPr(ctx, { url: url(3) });
    const untouched = getPr(ctx, c.id).position;

    setPrOrder(ctx, [b.id, a.id]);

    expect(getPr(ctx, b.id).position).toBe(a.position);
    expect(getPr(ctx, a.id).position).toBe(b.position);
    expect(getPr(ctx, c.id).position).toBe(untouched);
  });

  it('setPrOrder rejects unknown and duplicate ids', () => {
    const a = addPr(ctx, { url: url(1) });
    expect(() => setPrOrder(ctx, [a.id, 9999])).toThrow(/unknown/i);
    expect(() => setPrOrder(ctx, [a.id, a.id])).toThrow(/duplicate/i);
  });

  it('a failed gh lookup still leaves a usable record', () => {
    const pr = addPr(ctx, { url: url(212) });
    applyGhResult(ctx, pr.id, { error: 'gh: command not found' });
    const after = getPr(ctx, pr.id);
    expect(after.gh_error).toMatch(/command not found/);
    expect(after.gh_failures).toBe(1);
    expect(after.repo).toBe('api');       // identity survived, from the url
    expect(after.author_is_me).toBeNull(); // still unknown, NOT "someone else"
  });

  it('a success clears the error and resets the failure count', () => {
    const pr = addPr(ctx, { url: url(212) });
    applyGhResult(ctx, pr.id, { error: 'offline' });
    applyGhResult(ctx, pr.id, { title: 'T', authorLogin: 'me', isMe: true, state: 'open' });
    const after = getPr(ctx, pr.id);
    expect(after.gh_error).toBeNull();
    expect(after.gh_failures).toBe(0);
    expect(after.author_is_me).toBe(1);
  });

  it('records resolved_at for merged and for closed, which has no mergedAt', () => {
    const merged = addPr(ctx, { url: url(1) });
    applyGhResult(ctx, merged.id, { state: 'merged', mergedAt: 1700000000000 });
    expect(getPr(ctx, merged.id).resolved_at).toBe(1700000000000);

    const closed = addPr(ctx, { url: url(2) });
    applyGhResult(ctx, closed.id, { state: 'closed' }, 1800000000000);
    // gh returns mergedAt:null for closed PRs — without a fallback every
    // abandoned PR sorts under a null at the bottom of the merged column.
    expect(getPr(ctx, closed.id).resolved_at).toBe(1800000000000);
  });

  describe('dueForRefresh', () => {
    const hour = 60 * 60 * 1000;

    it('skips merged prs forever, but still checks closed ones', () => {
      const merged = addPr(ctx, { url: url(1) });
      const closed = addPr(ctx, { url: url(2) });
      applyGhResult(ctx, merged.id, { state: 'merged', mergedAt: 1 });
      applyGhResult(ctx, closed.id, { state: 'closed' }, 1);

      const due = dueForRefresh(ctx, { refreshHours: 1, now: Date.now() + 5 * hour })
        .map((p) => p.id);
      expect(due).not.toContain(merged.id);
      expect(due).toContain(closed.id);
    });

    it('leaves a freshly fetched pr alone', () => {
      const pr = addPr(ctx, { url: url(1) });
      applyGhResult(ctx, pr.id, { state: 'open' });
      expect(dueForRefresh(ctx, { refreshHours: 1, now: Date.now() })).toEqual([]);
    });

    // A deleted PR or a revoked repo fails identically every hour forever,
    // spawning a subprocess each time to learn nothing.
    it('gives up on a pr that keeps failing', () => {
      const pr = addPr(ctx, { url: url(1) });
      for (let i = 0; i < GH_FAILURE_CAP; i++) applyGhResult(ctx, pr.id, { error: 'gone' });
      const due = dueForRefresh(ctx, { refreshHours: 1, now: Date.now() + 5 * hour });
      expect(due.map((p) => p.id)).not.toContain(pr.id);
    });

    it('refreshHours 0 disables the schedule entirely', () => {
      addPr(ctx, { url: url(1) });
      expect(dueForRefresh(ctx, { refreshHours: 0, now: Date.now() + 99 * hour })).toEqual([]);
    });
  });

  it('a linked task that is archived or trashed keeps the pr tracked', () => {
    const archived = createTask(ctx, { title: 'Shipped' });
    const trashed = createTask(ctx, { title: 'Binned' });
    const a = addPr(ctx, { url: url(1), taskId: archived.id });
    const b = addPr(ctx, { url: url(2), taskId: trashed.id });

    archiveTask(ctx, archived.id);
    softDelete(ctx, trashed.id);

    expect(getPr(ctx, a.id).task_id).toBe(archived.id);
    expect(getPr(ctx, b.id).task_id).toBe(trashed.id);
  });

  it('setPrTask links and unlinks, and rewrites the durable file', () => {
    const task = createTask(ctx, { title: 'Auth rate limit' });
    const pr = addPr(ctx, { url: url(212) });
    setPrTask(ctx, pr.id, task.id);
    const file = () => matter(readFileSync(ctx.paths.prFile('github.com', 'example', 'api', 212), 'utf8')).data;
    expect(file().task).toBe(task.slug);
    setPrTask(ctx, pr.id, null);
    expect(getPr(ctx, pr.id).task_id).toBeNull();
    expect(file().task).toBeNull();
  });

  it('ignores a corrupt file in _prs rather than failing the whole reindex', () => {
    addPr(ctx, { url: url(212) });
    const { writeFileSync } = require('node:fs');
    writeFileSync(join(ctx.paths.prsDir(), 'garbage.md'), '---\n:::not yaml:::\n---\n');
    ctx.db.prepare('DELETE FROM prs').run();
    reindexPrs(ctx);
    expect(listPrs(ctx).length).toBe(1);
    expect(readdirSync(ctx.paths.prsDir()).length).toBe(2); // the bad file is left alone
  });
});
