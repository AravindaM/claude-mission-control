import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, readdirSync, writeFileSync, symlinkSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import matter from 'gray-matter';
import { openDb } from '../src/db.js';
import { createPaths } from '../src/paths.js';
import {
  createTask, updateTask, saveBrief, archiveTask, unarchiveTask,
  softDelete, restoreTrash, purgeExpired, reindex, getTask, listTasks,
  migrateLegacyStatuses,
} from '../src/taskstore.js';

const DAY = 24 * 60 * 60 * 1000;

describe('taskstore', () => {
  let ctx;

  beforeEach(() => {
    const dataDir = mkdtempSync(join(tmpdir(), 'mc-store-'));
    const paths = createPaths(dataDir);
    paths.ensureBaseDirs();
    ctx = { db: openDb(paths.dbFile()), paths };
  });

  it('createTask writes BRIEF.md frontmatter that mirrors the DB row', () => {
    const task = createTask(ctx, { title: 'DEMO-7 Search pagination', jiraKey: 'DEMO-7', repoPath: '/repo' });
    expect(task.slug).toBe('demo-7-search-pagination');
    const raw = readFileSync(ctx.paths.briefFile(task.slug), 'utf8');
    const fm = matter(raw);
    expect(fm.data).toMatchObject({
      slug: task.slug, title: 'DEMO-7 Search pagination', status: 'explore',
      archived: false, jira_key: 'DEMO-7', repo_path: '/repo',
    });
    expect(fm.content).toContain('_No brief yet._');
    expect(getTask(ctx, task.id).title).toBe('DEMO-7 Search pagination');
  });

  it('updateTask rejects an invalid status', () => {
    const task = createTask(ctx, { title: 'x' });
    expect(() => updateTask(ctx, task.id, { status: 'doing-stuff' })).toThrow(/status/);
  });

  it('updateTask moves status and rewrites frontmatter', () => {
    const task = createTask(ctx, { title: 'x' });
    updateTask(ctx, task.id, { status: 'development' });
    const fm = matter(readFileSync(ctx.paths.briefFile(task.slug), 'utf8'));
    expect(fm.data.status).toBe('development');
  });

  it('archive remembers the prior status; unarchive restores it', () => {
    const task = createTask(ctx, { title: 'x', status: 'testing' });
    archiveTask(ctx, task.id);
    expect(getTask(ctx, task.id)).toMatchObject({ archived: 1, status_before_archive: 'testing' });
    unarchiveTask(ctx, task.id);
    expect(getTask(ctx, task.id)).toMatchObject({ archived: 0, status: 'testing' });
  });

  it('saveBrief versions the previous body and records an event', () => {
    const task = createTask(ctx, { title: 'x' });
    saveBrief(ctx, task.id, '# v1\ncontent one', 'manual');
    saveBrief(ctx, task.id, '# v2\ncontent two', 'auto');
    const fm = matter(readFileSync(ctx.paths.briefFile(task.slug), 'utf8'));
    expect(fm.content).toContain('# v2');
    const versions = readdirSync(ctx.paths.briefsDir(task.slug));
    expect(versions.length).toBe(2); // initial placeholder + v1
    const events = ctx.db.prepare("SELECT * FROM events WHERE type='brief_saved'").all();
    expect(events.length).toBe(2);
  });

  it('softDelete hides, restoreTrash revives, purgeExpired removes rows and dir', () => {
    const task = createTask(ctx, { title: 'x' });
    const now = Date.now();
    softDelete(ctx, task.id, now);
    expect(getTask(ctx, task.id).deleted_at).toBe(now);
    restoreTrash(ctx, task.id);
    expect(getTask(ctx, task.id).deleted_at).toBeNull();
    softDelete(ctx, task.id, now - 31 * DAY);
    purgeExpired(ctx, now);
    expect(getTask(ctx, task.id)).toBeUndefined();
    expect(existsSync(ctx.paths.taskDir(task.slug))).toBe(false);
  });

  it('reindex rebuilds identical task rows from BRIEF.md files alone', () => {
    const a = createTask(ctx, { title: 'Alpha', jiraKey: 'A-1', status: 'plan' });
    const b = createTask(ctx, { title: 'Beta', repoPath: '/r/b' });
    archiveTask(ctx, b.id);
    createTask(ctx, { title: 'Gamma' });
    const before = listTasks(ctx).map(({ id, ...rest }) => rest);

    ctx.db.prepare('DELETE FROM tasks').run();
    expect(listTasks(ctx).length).toBe(0);
    reindex(ctx);

    const after = listTasks(ctx).map(({ id, ...rest }) => rest);
    expect(after).toEqual(before);
    expect(after.find(t => t.slug === a.slug).status).toBe('plan');
  });

  it('stores repo_path symlink-resolved so it matches git --show-toplevel', () => {
    // Caught by the e2e smoke test on macOS: /tmp and /var/folders are symlinks,
    // git resolves them, and an unresolved repo_path never auto-attaches.
    const real = join(ctx.paths.dataDir, 'real-repo');
    const link = join(ctx.paths.dataDir, 'link-repo');
    mkdirSync(real);
    symlinkSync(real, link);
    const task = createTask(ctx, { title: 'Symlinked', repoPath: link });
    expect(getTask(ctx, task.id).repo_path).toBe(realpathSync(real));
  });

  it('migrateLegacyStatuses rewrites old stage names in DB and frontmatter so reindex keeps them', () => {
    const task = createTask(ctx, { title: 'Legacy', status: 'testing' });
    ctx.db.prepare("UPDATE tasks SET status = 'deployed' WHERE id = ?").run(task.id);
    const raw = readFileSync(ctx.paths.briefFile(task.slug), 'utf8');
    writeFileSync(ctx.paths.briefFile(task.slug), raw.replace('status: testing', 'status: deployed'));

    const migrated = migrateLegacyStatuses(ctx);
    expect(migrated).toBe(1);
    expect(getTask(ctx, task.id).status).toBe('deploy');
    ctx.db.prepare('DELETE FROM tasks').run();
    reindex(ctx);
    expect(listTasks(ctx)[0].status).toBe('deploy');
  });

  it('reindex ignores non-task directories and survives a corrupt BRIEF.md', () => {
    createTask(ctx, { title: 'Good' });
    const badDir = join(ctx.paths.dataDir, 'corrupt-task');
    ctx.paths.ensureTaskDirs('corrupt-task');
    writeFileSync(join(badDir, 'BRIEF.md'), '---\n:::not yaml:::\n---\n');
    reindex(ctx);
    expect(listTasks(ctx).length).toBe(1);
  });
});
