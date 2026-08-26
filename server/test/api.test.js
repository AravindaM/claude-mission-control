import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import matter from 'gray-matter';
import { openDb } from '../src/db.js';
import { createPaths } from '../src/paths.js';
import { buildApp } from '../src/api.js';

const startEvent = (over = {}) => ({
  hook_event_name: 'SessionStart', session_id: 'u-1', source: 'startup',
  cwd: '/repo/a', repo_toplevel: '/repo/a', git_branch: 'main',
  transcript_path: '/tmp/t.jsonl', ts: 1000, ...over,
});

describe('api', () => {
  let app, ctx, config;

  beforeEach(() => {
    const dataDir = mkdtempSync(join(tmpdir(), 'mc-api-'));
    const paths = createPaths(dataDir);
    paths.ensureBaseDirs();
    ctx = { db: openDb(paths.dbFile()), paths };
    config = { port: 47613, dataDir };
    app = buildApp({ ctx, config, heartbeatMs: 40 });
  });

  afterEach(async () =>
    await app.close());

  const post = (url, payload, headers = {}) =>
    app.inject({ method: 'POST', url, payload, headers });

  it('session-start with no matching task returns an unassigned status line and no brief', async () => {
    const res = await post('/api/hooks/session-start', startEvent());
    const body = res.json();
    expect(body.status_line).toContain('/task');
    expect(body.brief).toBeNull();
  });

  it('session-start auto-attaches to a single matching task and returns its brief', async () => {
    await post('/api/tasks', { title: 'Search pagination', repoPath: '/repo/a' });
    const res = await post('/api/hooks/session-start', startEvent());
    const body = res.json();
    expect(body.status_line).toContain('attached to search-pagination');
    expect(body.brief).toContain('No brief yet');
  });

  it('the turn endpoint ingests the spooled Stop event and revokes a stale ended_at', async () => {
    // Mirrors the real hook sequence: spool to disk first, then curl. The
    // reconciler ghost-closer and SessionEnd(reason:resume) both stamp ended_at
    // on live sessions; observed activity has to revoke that guess or briefing
    // stays latched off forever.
    await post('/api/hooks/session-start', startEvent({ session_id: 'alive' }));
    ctx.db.prepare("UPDATE sessions SET ended_at = 5000 WHERE session_uuid = 'alive'").run();

    const turn = { hook_event_name: 'Stop', session_id: 'alive', cwd: '/repo/a', ts: 2000 };
    appendFileSync(ctx.paths.spoolFile(), `${JSON.stringify(turn)}\n`);
    const res = await post('/api/hooks/turn', turn);

    expect(res.statusCode).toBe(200);
    const row = ctx.db.prepare("SELECT ended_at, turn_count FROM sessions WHERE session_uuid='alive'").get();
    expect(row.ended_at).toBeNull();
    expect(row.turn_count).toBe(1);
  });

  it('session-start names the ambiguity when several tasks match', async () => {
    await post('/api/tasks', { title: 'Task One', repoPath: '/repo/a' });
    await post('/api/tasks', { title: 'Task Two', repoPath: '/repo/a' });
    const res = await post('/api/hooks/session-start', startEvent());
    expect(res.json().status_line).toContain('2 tasks match');
  });

  it('rejects non-loopback sockets and cross-origin mutations', async () => {
    const remote = await app.inject({
      method: 'GET', url: '/api/tasks', remoteAddress: '10.1.2.3',
    });
    expect(remote.statusCode).toBe(403);
    const badOrigin = await post('/api/tasks', { title: 'x' }, { origin: 'https://evil.example' });
    expect(badOrigin.statusCode).toBe(403);
    const goodOrigin = await post('/api/tasks', { title: 'x' }, { origin: 'http://localhost:47613' });
    expect(goodOrigin.statusCode).toBe(201);
  });

  it('walks a task through move → archive → restore → trash → restore-trash', async () => {
    const { id } = (await post('/api/tasks', { title: 'Lifecycle' })).json();
    let res = await app.inject({ method: 'PATCH', url: `/api/tasks/${id}`, payload: { status: 'development' } });
    expect(res.json().status).toBe('development');
    res = await app.inject({ method: 'PATCH', url: `/api/tasks/${id}`, payload: { archived: true } });
    expect(res.json()).toMatchObject({ archived: 1, status_before_archive: 'development' });
    res = await app.inject({ method: 'PATCH', url: `/api/tasks/${id}`, payload: { archived: false } });
    expect(res.json()).toMatchObject({ archived: 0, status: 'development' });
    await app.inject({ method: 'DELETE', url: `/api/tasks/${id}` });
    let state = (await app.inject({ method: 'GET', url: '/api/state' })).json();
    expect(state.tasks.find(t => t.id === id)).toBeUndefined();
    expect(state.trash.find(t => t.id === id)).toBeTruthy();
    await post(`/api/tasks/${id}/restore-trash`, {});
    state = (await app.inject({ method: 'GET', url: '/api/state' })).json();
    expect(state.tasks.find(t => t.id === id)).toBeTruthy();
  });

  it('/task endpoint: ref binds-or-creates, no-ref queues brief when bound, names when unbound', async () => {
    const brieferCalls = { enqueued: [], named: [] };
    const fakeBriefer = {
      enqueue: (uuid, opts) => brieferCalls.enqueued.push({ uuid, ...opts }),
      nameTask: async (uuid) => { brieferCalls.named.push(uuid); return null; },
      sweep: () => {},
    };
    await app.close();
    app = buildApp({ ctx, config, briefer: fakeBriefer, heartbeatMs: 40 });

    // ref → create with short slug
    await post('/api/hooks/session-start', startEvent({ session_id: 't-1' }));
    let res = await post('/api/sessions/t-1/task', { ref: 'search-paging', cwd: '/repo/a', repoToplevel: '/repo/a' });
    expect(res.json()).toMatchObject({ action: 'created' });
    expect(res.json().task.slug).toBe('search-paging');

    // ref substring → bound to existing, not duplicated
    res = await post('/api/sessions/t-1/task', { ref: 'paging' });
    expect(res.json()).toMatchObject({ action: 'bound' });

    // no ref on the (now bound) session → background brief queued with force
    res = await post('/api/sessions/t-1/task', { ref: '' });
    expect(res.json()).toMatchObject({ action: 'brief-queued', slug: 'search-paging' });
    expect(brieferCalls.enqueued).toContainEqual({ uuid: 't-1', force: true });

    // no ref, unbound session WITH transcript → naming kicked off in background
    await post('/api/hooks/session-start', startEvent({ session_id: 't-2', repo_toplevel: '/repo/zz', cwd: '/repo/zz' }));
    res = await post('/api/sessions/t-2/task', { ref: '' });
    expect(res.json()).toMatchObject({ action: 'naming' });
    expect(brieferCalls.named).toEqual(['t-2']);

    // no ref, session the hooks never saw (no transcript) → explicit error
    res = await post('/api/sessions/ghost-1/task', { ref: '', cwd: '/x' });
    expect(res.json().action).toBe('error');
  });

  it('/task derives the transcript path for pre-hook sessions from cwd + uuid', async () => {
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const { homedir } = await import('node:os');
    const cwd = `/derive-test-${Date.now()}`;
    const dir = `${homedir()}/.claude/projects/${cwd.replace(/[^a-zA-Z0-9]/g, '-')}`;
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}/pre-hook-1.jsonl`, '{"type":"user","message":{"role":"user","content":"x"}}\n');
    const res = await post('/api/sessions/pre-hook-1/task', { ref: '', cwd });
    expect(res.json().action).toBe('naming');
    const row = ctx.db.prepare("SELECT transcript_path FROM sessions WHERE session_uuid='pre-hook-1'").get();
    expect(row.transcript_path).toBe(`${dir}/pre-hook-1.jsonl`);
    const { rmSync } = await import('node:fs');
    rmSync(dir, { recursive: true, force: true });
  });

  it('bind with an unknown ref creates a task whose slug is the short typed ref', async () => {
    await post('/api/hooks/session-start', startEvent({ session_id: 'u-7' }));
    const res = await post('/api/sessions/u-7/bind', { taskTitle: 'search-paging', jiraKey: 'DEMO-9' });
    expect(res.json().task.slug).toBe('search-paging');
    const map = JSON.parse(readFileSync(ctx.paths.bindingsFile(), 'utf8'));
    expect(map['u-7']).toBe('search-paging');
  });

  it('bind resolves a substring ref to the unique existing task instead of creating', async () => {
    const { id } = (await post('/api/tasks', { title: 'Worker cold start investigation', jiraKey: 'DEMO-70' })).json();
    await post('/api/hooks/session-start', startEvent({ session_id: 'u-8' }));
    const res = await post('/api/sessions/u-8/bind', { taskTitle: 'cold start' });
    expect(res.json().task.id).toBe(id);
    expect((await app.inject({ method: 'GET', url: '/api/tasks' })).json().length).toBe(1);
  });

  it('bind returns 409 with candidates when the ref is ambiguous', async () => {
    await post('/api/tasks', { title: 'Redis migration acceptance' });
    await post('/api/tasks', { title: 'Redis migration prod' });
    await post('/api/hooks/session-start', startEvent({ session_id: 'u-9' }));
    const res = await post('/api/sessions/u-9/bind', { taskTitle: 'redis' });
    expect(res.statusCode).toBe(409);
    expect(res.json().candidates.length).toBe(2);
  });

  it('binding to an archived task unarchives it', async () => {
    const { id } = (await post('/api/tasks', { title: 'Parked thing', status: 'testing' })).json();
    await app.inject({ method: 'PATCH', url: `/api/tasks/${id}`, payload: { archived: true } });
    await post('/api/hooks/session-start', startEvent({ session_id: 'u-10' }));
    const res = await post('/api/sessions/u-10/bind', { taskTitle: 'parked' });
    expect(res.json().task).toMatchObject({ archived: 0, status: 'testing' });
  });

  it('saving a brief via the API rewrites BRIEF.md', async () => {
    const { id, slug } = (await post('/api/tasks', { title: 'Briefed' })).json();
    await post(`/api/tasks/${id}/brief`, { body: '# Goal\nShip it.', source: 'manual' });
    const fm = matter(readFileSync(ctx.paths.briefFile(slug), 'utf8'));
    expect(fm.content).toContain('Ship it.');
  });

  it('rejects an empty or blank manual brief instead of wiping the current one', async () => {
    const { id, slug } = (await post('/api/tasks', { title: 'Guarded' })).json();
    await post(`/api/tasks/${id}/brief`, { body: 'real content here', source: 'manual' });
    const res = await post(`/api/tasks/${id}/brief`, { body: '   ', source: 'manual' });
    expect(res.statusCode).toBe(400);
    const fm = matter(readFileSync(ctx.paths.briefFile(slug), 'utf8'));
    expect(fm.content).toContain('real content here');
  });

  it('state hides short/stale unassigned sessions', async () => {
    const now = Math.floor(Date.now() / 1000);
    // 20-minute session → should surface
    await post('/api/hooks/session-start', startEvent({ session_id: 'long', ts: now - 1200 }));
    ctx.db.prepare("UPDATE sessions SET last_activity_at = ? WHERE session_uuid = 'long'").run(Date.now());
    // 1-minute session → hidden
    await post('/api/hooks/session-start', startEvent({ session_id: 'short', ts: now }));
    const state = (await app.inject({ method: 'GET', url: '/api/state' })).json();
    const uuids = state.unassigned.map(s => s.session_uuid);
    expect(uuids).toContain('long');
    expect(uuids).not.toContain('short');
  });

  it('refresh-brief force-queues the whole task, not just its newest session', async () => {
    // It used to pick only the newest-transcript session, so a task worked in
    // two tabs had half its material silently ignored on every refresh.
    const queuedTasks = [];
    await app.close();
    app = buildApp({
      ctx,
      config,
      briefer: {
        enqueue: () => {},
        enqueueTask: (t, o) => queuedTasks.push({ t, ...o }),
        nameTask: async () => null,
        sweep: () => {},
      },
      heartbeatMs: 40,
    });

    const { id } = (await post('/api/tasks', { title: 'Refresh Me' })).json();
    const { writeFileSync: wf } = await import('node:fs');
    const t1 = join(ctx.paths.dataDir, 'old.jsonl'); wf(t1, 'x');
    const t2 = join(ctx.paths.dataDir, 'new.jsonl'); wf(t2, 'x');
    ctx.db.prepare("INSERT INTO sessions (session_uuid, task_id, transcript_path, started_at, last_activity_at) VALUES ('old-s', ?, ?, 1, 1)").run(id, t1);
    ctx.db.prepare("INSERT INTO sessions (session_uuid, task_id, transcript_path, started_at, last_activity_at) VALUES ('new-s', ?, ?, 2, 2)").run(id, t2);

    const res = await post(`/api/tasks/${id}/refresh-brief`, {});
    expect(res.json()).toMatchObject({ queued: true, sessions: 2 });
    expect(queuedTasks).toEqual([{ t: id, force: true, about: false }]);

    // opting in also rewrites the stable sections
    await post(`/api/tasks/${id}/refresh-brief`, { about: true });
    expect(queuedTasks[1]).toEqual({ t: id, force: true, about: true });

    // no transcript anywhere → honest refusal
    const bare = (await post('/api/tasks', { title: 'Bare' })).json();
    const res2 = await post(`/api/tasks/${bare.id}/refresh-brief`, {});
    expect(res2.json().queued).toBe(false);
  });

  it('the timeline hides routine brief saves so real history is not buried', async () => {
    // Status refreshes run every few minutes, so brief_saved would consume the
    // whole limit and push out the events that describe what happened to the task.
    const { id } = (await post('/api/tasks', { title: 'Noisy' })).json();
    const ins = ctx.db.prepare("INSERT INTO events (task_id, type, detail, created_at) VALUES (?, ?, NULL, ?)");
    for (let i = 0; i < 40; i++) ins.run(id, 'brief_saved', 2000 + i);
    ins.run(id, 'status_changed', 1000); // older than every brief_saved

    const shown = (await app.inject({ method: 'GET', url: `/api/tasks/${id}/events?limit=30` })).json();
    expect(shown.map((e) => e.type)).toContain('status_changed');
    expect(shown.some((e) => e.type === 'brief_saved')).toBe(false);

    const all = (await app.inject({ method: 'GET', url: `/api/tasks/${id}/events?limit=500&all=1` })).json();
    expect(all.filter((e) => e.type === 'brief_saved').length).toBe(40);
  });

  it('digest returns active tasks with briefs, excluding archived and trashed', async () => {
    const a = (await post('/api/tasks', { title: 'Active One' })).json();
    await post(`/api/tasks/${a.id}/brief`, { body: '## Goal\nfinish the thing', source: 'manual' });
    const b = (await post('/api/tasks', { title: 'Archived One' })).json();
    await app.inject({ method: 'PATCH', url: `/api/tasks/${b.id}`, payload: { archived: true } });
    const c = (await post('/api/tasks', { title: 'Trashed One' })).json();
    await app.inject({ method: 'DELETE', url: `/api/tasks/${c.id}` });

    const digest = (await app.inject({ method: 'GET', url: '/api/digest' })).json();
    expect(digest.tasks.map((t) => t.slug)).toEqual(['active-one']);
    expect(digest.tasks[0].brief).toContain('finish the thing');
    expect(digest.now).toBeGreaterThan(0);
  });

  it('a brief_failed superseded by a later brief_saved for the same task does not banner', async () => {
    const { id } = (await post('/api/tasks', { title: 'Flaky' })).json();
    const insertEvent = (type, at) => ctx.db.prepare(
      'INSERT INTO events (task_id, type, created_at) VALUES (?, ?, ?)').run(id, type, at);
    insertEvent('brief_failed', Date.now() - 3000);
    let banners = (await app.inject({ method: 'GET', url: '/api/state' })).json().banners;
    expect(banners.length).toBe(1);
    expect(banners[0].slug).toBe('flaky');
    insertEvent('brief_saved', Date.now() - 1000);
    banners = (await app.inject({ method: 'GET', url: '/api/state' })).json().banners;
    expect(banners.length).toBe(0);
  });

  it('SSE stream sends heartbeats', async () => {
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address();
    const res = await fetch(`http://127.0.0.1:${port}/api/events`);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body.getReader();
    let text = '';
    const deadline = Date.now() + 2000;
    while (!text.includes('event: hb') && Date.now() < deadline) {
      const { value } = await reader.read();
      text += new TextDecoder().decode(value);
    }
    expect(text).toContain(': connected');
    expect(text).toContain('event: hb');
    await reader.cancel();
  });
});
