import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { createPaths } from '../src/paths.js';
import { createTask, getTaskBySlug } from '../src/taskstore.js';
import { ingestSpool, writeBindings } from '../src/spool.js';

describe('spool ingest', () => {
  let ctx;

  beforeEach(() => {
    const dataDir = mkdtempSync(join(tmpdir(), 'mc-spool-'));
    const paths = createPaths(dataDir);
    paths.ensureBaseDirs();
    ctx = { db: openDb(paths.dbFile()), paths };
  });

  const spool = (obj) => appendFileSync(ctx.paths.spoolFile(), JSON.stringify(obj) + '\n');

  const startEvent = (over = {}) => ({
    hook_event_name: 'SessionStart', session_id: 'u-1', source: 'startup',
    cwd: '/repo/a', repo_toplevel: '/repo/a', git_branch: 'main',
    transcript_path: '/tmp/t.jsonl', ts: 1000, ...over,
  });

  it('start then end produce a complete session row', () => {
    spool(startEvent());
    spool({ hook_event_name: 'SessionEnd', session_id: 'u-1', reason: 'other', cwd: '/repo/a', repo_toplevel: '/repo/a', git_branch: 'main', transcript_path: '/tmp/t.jsonl', ts: 1600 });
    const { processed } = ingestSpool(ctx);
    expect(processed).toBe(2);
    const row = ctx.db.prepare("SELECT * FROM sessions WHERE session_uuid='u-1'").get();
    expect(row).toMatchObject({ started_at: 1000000, ended_at: 1600000, cwd: '/repo/a' });
  });

  it('a Stop event revokes a stale ended_at and counts the assistant turn', () => {
    spool(startEvent());
    spool({ hook_event_name: 'SessionEnd', session_id: 'u-1', reason: 'resume', cwd: '/repo/a', ts: 1600 });
    spool({ hook_event_name: 'Stop', session_id: 'u-1', cwd: '/repo/a', ts: 1700 });
    ingestSpool(ctx);
    const row = ctx.db.prepare("SELECT ended_at, turn_count, last_activity_at FROM sessions WHERE session_uuid='u-1'").get();
    expect(row.ended_at).toBeNull(); // SessionEnd(reason:resume) guess revoked
    expect(row.turn_count).toBe(1);
    expect(row.last_activity_at).toBe(1700000);
  });

  it('a Stop event for a session it never saw start is skipped, not fatal', () => {
    spool({ hook_event_name: 'Stop', session_id: 'ghost', cwd: '/x', ts: 1 });
    const { processed, skipped } = ingestSpool(ctx);
    expect(processed).toBe(1);
    expect(skipped).toBe(0);
    expect(ctx.db.prepare('SELECT COUNT(*) c FROM sessions').get().c).toBe(0);
  });

  it('is idempotent when replayed from offset zero', () => {
    createTask(ctx, { title: 'Only Task', repoPath: '/repo/a' });
    spool(startEvent());
    ingestSpool(ctx);
    ctx.db.prepare("UPDATE meta SET value='0' WHERE key='spool_offset'").run();
    ingestSpool(ctx);
    expect(ctx.db.prepare('SELECT COUNT(*) c FROM sessions').get().c).toBe(1);
    expect(ctx.db.prepare("SELECT COUNT(*) c FROM events WHERE type='session_attached'").get().c).toBe(1);
  });

  it('auto-attaches on ingest when exactly one task matches', () => {
    const task = createTask(ctx, { title: 'Only Task', repoPath: '/repo/a' });
    spool(startEvent());
    ingestSpool(ctx);
    const row = ctx.db.prepare("SELECT * FROM sessions WHERE session_uuid='u-1'").get();
    expect(row.task_id).toBe(task.id);
  });

  it('skips malformed lines without throwing and keeps processing', () => {
    spool(startEvent());
    appendFileSync(ctx.paths.spoolFile(), 'this is not json\n');
    spool(startEvent({ session_id: 'u-2' }));
    const { processed, skipped } = ingestSpool(ctx);
    expect(processed).toBe(2);
    expect(skipped).toBe(1);
  });

  it('persists the offset so a second ingest is a no-op', () => {
    spool(startEvent());
    ingestSpool(ctx);
    const { processed } = ingestSpool(ctx);
    expect(processed).toBe(0);
  });

  it('bind_intent creates the task if missing and binds the session', () => {
    spool(startEvent({ session_id: 'u-9', repo_toplevel: '/repo/x', cwd: '/repo/x' }));
    spool({ hook_event_name: 'bind_intent', session_id: 'u-9', task_title: 'DEMO-1 new work', jira_key: 'DEMO-1', cwd: '/repo/x', repo_toplevel: '/repo/x', ts: 1100 });
    ingestSpool(ctx);
    const task = getTaskBySlug(ctx, 'demo-1-new-work');
    expect(task).toBeTruthy();
    expect(task.jira_key).toBe('DEMO-1');
    const row = ctx.db.prepare("SELECT * FROM sessions WHERE session_uuid='u-9'").get();
    expect(row.task_id).toBe(task.id);
  });

  const promptEvent = (sessionId, prompt, ts = 1200) => ({
    hook_event_name: 'UserPromptSubmit', session_id: sessionId, prompt,
    cwd: '/repo/a', repo_toplevel: '/repo/a', git_branch: 'main', ts,
  });

  it('first prompt with a KNOWN jira key merges the session into that task', () => {
    const task = createTask(ctx, { title: 'Search pagination', jiraKey: 'DEMO-7', repoPath: '/repo/other' });
    spool(startEvent({ session_id: 'p-1', repo_toplevel: '/repo/x', cwd: '/repo/x' }));
    spool(promptEvent('p-1', 'continue the DEMO-7 origin analysis'));
    ingestSpool(ctx);
    const row = ctx.db.prepare("SELECT * FROM sessions WHERE session_uuid='p-1'").get();
    expect(row.task_id).toBe(task.id);
  });

  it('first prompt with an UNKNOWN jira key auto-creates a task and binds', () => {
    spool(startEvent({ session_id: 'p-2' }));
    spool(promptEvent('p-2', 'DEMO-42 investigate slow queries on the reports page'));
    ingestSpool(ctx);
    const row = ctx.db.prepare("SELECT * FROM sessions WHERE session_uuid='p-2'").get();
    const task = ctx.db.prepare('SELECT * FROM tasks WHERE id = ?').get(row.task_id);
    expect(task.jira_key).toBe('DEMO-42');
    expect(task.title).toContain('DEMO-42');
    expect(task.repo_path).toBe('/repo/a');
    expect(task.status).toBe('explore');
  });

  it('merging into an ARCHIVED task unarchives it', () => {
    const task = createTask(ctx, { title: 'Old thing', jiraKey: 'OLD-1', status: 'testing' });
    ctx.db.prepare('UPDATE tasks SET archived = 1, status_before_archive = ? WHERE id = ?').run('testing', task.id);
    spool(startEvent({ session_id: 'p-3', repo_toplevel: '', cwd: '/x' }));
    spool(promptEvent('p-3', 'back to OLD-1 again'));
    ingestSpool(ctx);
    const after = ctx.db.prepare('SELECT * FROM tasks WHERE id = ?').get(task.id);
    expect(after.archived).toBe(0);
    expect(after.status).toBe('testing');
  });

  it('only the FIRST prompt binds; later jira mentions never rebind', () => {
    const a = createTask(ctx, { title: 'A', jiraKey: 'AAA-1' });
    createTask(ctx, { title: 'B', jiraKey: 'BBB-2' });
    spool(startEvent({ session_id: 'p-4', repo_toplevel: '', cwd: '/x' }));
    spool(promptEvent('p-4', 'work on AAA-1'));
    spool(promptEvent('p-4', 'compare with BBB-2 please', 1300));
    ingestSpool(ctx);
    const row = ctx.db.prepare("SELECT * FROM sessions WHERE session_uuid='p-4'").get();
    expect(row.task_id).toBe(a.id);
    expect(row.prompt_count).toBe(2);
  });

  it('a prompt without a jira key leaves the session unassigned but updates activity', () => {
    spool(startEvent({ session_id: 'p-5' }));
    spool(promptEvent('p-5', 'explain how the retry backoff is calculated here', 2000));
    ingestSpool(ctx);
    const row = ctx.db.prepare("SELECT * FROM sessions WHERE session_uuid='p-5'").get();
    expect(row.task_id).toBeNull();
    expect(row.last_activity_at).toBe(2000000);
    expect(ctx.db.prepare('SELECT COUNT(*) c FROM tasks').get().c).toBe(0);
  });

  it('an already-bound session ignores jira keys in prompts', () => {
    const bound = createTask(ctx, { title: 'Bound', repoPath: '/repo/a' });
    createTask(ctx, { title: 'Other', jiraKey: 'ZZZ-9' });
    spool(startEvent({ session_id: 'p-6' })); // auto-attaches: /repo/a has one task
    spool(promptEvent('p-6', 'unrelated mention of ZZZ-9'));
    ingestSpool(ctx);
    const row = ctx.db.prepare("SELECT * FROM sessions WHERE session_uuid='p-6'").get();
    expect(row.task_id).toBe(bound.id);
  });

  it('writeBindings dumps session→slug map readable by the hook', () => {
    const task = createTask(ctx, { title: 'Only Task', repoPath: '/repo/a' });
    spool(startEvent());
    ingestSpool(ctx);
    writeBindings(ctx);
    const map = JSON.parse(readFileSync(ctx.paths.bindingsFile(), 'utf8'));
    expect(map['u-1']).toBe(task.slug);
  });

  it('attaching a session appends a custom-title line (rename) to its transcript', () => {
    const task = createTask(ctx, { title: 'Only Task', repoPath: '/repo/a' });
    const transcript = join(ctx.paths.dataDir, 'live-transcript.jsonl');
    writeFileSync(transcript, '{"type":"user"}\n');
    spool(startEvent({ session_id: 'rn-1', transcript_path: transcript }));
    ingestSpool(ctx);
    const lines = readFileSync(transcript, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const title = lines.find((l) => l.type === 'custom-title');
    expect(title).toMatchObject({ customTitle: task.slug, sessionId: 'rn-1' });
  });
});
