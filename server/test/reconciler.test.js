import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, utimesSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { createPaths } from '../src/paths.js';
import { createTask } from '../src/taskstore.js';
import { reconcile } from '../src/reconciler.js';

const DAY = 24 * 60 * 60 * 1000;

describe('reconciler', () => {
  let ctx, config, task, live;

  beforeEach(() => {
    const dataDir = mkdtempSync(join(tmpdir(), 'mc-rec-'));
    const paths = createPaths(dataDir);
    paths.ensureBaseDirs();
    ctx = { db: openDb(paths.dbFile()), paths };
    config = { unboundRetentionDays: 30 };
    task = createTask(ctx, { title: 'Recon Task', repoPath: '/repo/a' });
    live = mkdtempSync(join(tmpdir(), 'mc-live-')); // stands in for ~/.claude/projects/...
  });

  function insertSession(uuid, { taskId = null, endedAt = null, transcript = 'x' } = {}) {
    const transcriptPath = join(live, `${uuid}.jsonl`);
    writeFileSync(transcriptPath, transcript);
    ctx.db.prepare(`
      INSERT INTO sessions (session_uuid, task_id, cwd, repo_toplevel, transcript_path, started_at, ended_at, last_activity_at)
      VALUES (?, ?, '/repo/a', '/repo/a', ?, 1, ?, 1)
    `).run(uuid, taskId, transcriptPath, endedAt);
    return transcriptPath;
  }

  it('copies a changed live transcript into the task archive (hard-kill safety net)', () => {
    insertSession('s1', { taskId: task.id });
    const r1 = reconcile({ ctx, config });
    expect(r1.copied).toBe(1);
    expect(existsSync(join(ctx.paths.transcriptsDir(task.slug), 's1.jsonl'))).toBe(true);
    // unchanged → second run copies nothing
    expect(reconcile({ ctx, config }).copied).toBe(0);
  });

  it('relocates the archive copy when a binding appears after an _unbound copy', () => {
    insertSession('s2');
    reconcile({ ctx, config });
    const unboundCopy = join(ctx.paths.unboundDir('a'), 's2.jsonl');
    expect(existsSync(unboundCopy)).toBe(true);
    ctx.db.prepare('UPDATE sessions SET task_id = ? WHERE session_uuid = ?').run(task.id, 's2');
    reconcile({ ctx, config });
    expect(existsSync(join(ctx.paths.transcriptsDir(task.slug), 's2.jsonl'))).toBe(true);
    expect(existsSync(unboundCopy)).toBe(false);
  });

  it('prunes unbound copies older than retention', () => {
    const dir = ctx.paths.unboundDir('old-repo');
    mkdirSync(dir, { recursive: true });
    const oldFile = join(dir, 'ancient.jsonl');
    writeFileSync(oldFile, 'x');
    const past = new Date(Date.now() - 31 * DAY);
    utimesSync(oldFile, past, past);
    const result = reconcile({ ctx, config });
    expect(result.pruned).toBe(1);
    expect(existsSync(oldFile)).toBe(false);
  });

  it('closes ghost sessions whose transcript has been idle 30+ minutes', () => {
    const p = insertSession('ghost', { taskId: task.id });
    const idle = new Date(Date.now() - 45 * 60 * 1000);
    utimesSync(p, idle, idle);
    const result = reconcile({ ctx, config });
    expect(result.closed).toBe(1);
    const row = ctx.db.prepare("SELECT ended_at FROM sessions WHERE session_uuid='ghost'").get();
    expect(row.ended_at).toBeGreaterThan(0);
  });

  it('never copies transcripts into an ARCHIVED task and retries its finalize when files linger', () => {
    insertSession('a1', { taskId: task.id });
    ctx.db.prepare('UPDATE tasks SET archived = 1 WHERE id = ?').run(task.id);
    mkdirSync(ctx.paths.transcriptsDir(task.slug), { recursive: true });
    writeFileSync(join(ctx.paths.transcriptsDir(task.slug), 'leftover.jsonl'), 'x');
    const finalized = [];
    const result = reconcile({ ctx, config, briefer: { sweep: () => {}, finalize: (id) => finalized.push(id) } });
    expect(result.copied).toBe(0);
    expect(finalized).toEqual([task.id]);
  });

  it('triggers the briefer sweep', () => {
    let swept = false;
    reconcile({ ctx, config, briefer: { sweep: () => { swept = true; } } });
    expect(swept).toBe(true);
  });
});
