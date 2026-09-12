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
  migrateLegacyStatuses, setPriorities, PRIORITY_CAP,
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

  it('backlog is a valid stage, but never the default for a new task', () => {
    // A task exists because a session is working on it, which is `explore` at
    // the earliest. Backlog is somewhere you put things on purpose.
    const fresh = createTask(ctx, { title: 'Auto-named' });
    expect(fresh.status).toBe('explore');

    const parked = createTask(ctx, { title: 'Parked', status: 'backlog' });
    expect(parked.status).toBe('backlog');
    expect(matter(readFileSync(ctx.paths.briefFile(parked.slug), 'utf8')).data.status).toBe('backlog');

    // and it round-trips through a rebuild like any other stage
    ctx.db.prepare('DELETE FROM tasks').run();
    reindex(ctx);
    expect(getTask(ctx, parked.id) ?? listTasks(ctx).find((t) => t.slug === 'parked')).toMatchObject({ status: 'backlog' });
  });

  it('a task can be parked into backlog and pulled back out', () => {
    const task = createTask(ctx, { title: 'Movable', status: 'development' });
    expect(updateTask(ctx, task.id, { status: 'backlog' }).status).toBe('backlog');
    expect(updateTask(ctx, task.id, { status: 'development' }).status).toBe('development');
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

// The stack's whole correctness story is one invariant: among eligible tasks the
// non-null priorities are exactly 1..n. It holds by construction because every
// write restates the entire order, so these tests exercise that property rather
// than any repair path — there is none.
describe('taskstore priority', () => {
  let ctx;

  const ranks = () => ctx.db
    .prepare('SELECT slug, priority FROM tasks WHERE priority IS NOT NULL ORDER BY priority')
    .all()
    .map((r) => [r.slug, r.priority]);

  beforeEach(() => {
    const dataDir = mkdtempSync(join(tmpdir(), 'mc-pri-'));
    const paths = createPaths(dataDir);
    paths.ensureBaseDirs();
    ctx = { db: openDb(paths.dbFile()), paths };
  });

  const mk = (title, status = 'development') => createTask(ctx, { title, status });

  it('setPriorities assigns exactly 1..n by array position', () => {
    const a = mk('Alpha'); const b = mk('Bravo'); const c = mk('Charlie');
    setPriorities(ctx, [c.id, a.id, b.id]);
    expect(ranks()).toEqual([['charlie', 1], ['alpha', 2], ['bravo', 3]]);
  });

  it('setPriorities drops tasks left out of the order back to NULL', () => {
    const a = mk('Alpha'); const b = mk('Bravo');
    setPriorities(ctx, [a.id, b.id]);
    setPriorities(ctx, [b.id]);
    expect(ranks()).toEqual([['bravo', 1]]);
    expect(getTask(ctx, a.id).priority).toBe(null);
  });

  it('setPriorities with an empty order clears the stack', () => {
    const a = mk('Alpha');
    setPriorities(ctx, [a.id]);
    setPriorities(ctx, []);
    expect(ranks()).toEqual([]);
  });

  // The regression this guards: updated_at feeds sortCards AND the digest's
  // ORDER BY, so a reorder routed through updateTask would reshuffle both — a
  // pure scheduling act would register as activity.
  it('setPriorities never touches updated_at', () => {
    const a = mk('Alpha'); const b = mk('Bravo');
    const before = [getTask(ctx, a.id).updated_at, getTask(ctx, b.id).updated_at];
    setPriorities(ctx, [b.id, a.id]);
    expect([getTask(ctx, a.id).updated_at, getTask(ctx, b.id).updated_at]).toEqual(before);
  });

  it('priority round-trips through frontmatter and survives a DB rebuild', () => {
    const a = mk('Alpha'); const b = mk('Bravo');
    setPriorities(ctx, [b.id, a.id]);
    expect(matter(readFileSync(ctx.paths.briefFile('bravo'), 'utf8')).data.priority).toBe(1);

    ctx.db.prepare('DELETE FROM tasks').run(); // the index is disposable; files win
    reindex(ctx);
    expect(ranks()).toEqual([['bravo', 1], ['alpha', 2]]);
  });

  it('rejects a duplicate id, an unknown id, and an over-cap order', () => {
    const a = mk('Alpha');
    expect(() => setPriorities(ctx, [a.id, a.id])).toThrow(/duplicate/i);
    expect(() => setPriorities(ctx, [a.id, 9999])).toThrow(/unknown/i);
    const many = Array.from({ length: PRIORITY_CAP + 1 }, (_, i) => mk(`T${i}`).id);
    expect(() => setPriorities(ctx, many)).toThrow(/cap|most/i);
  });

  // Backlog work is exactly what "what will I pick up next" means, so parked
  // tasks stay rankable. Only finished or gone work is excluded.
  it('a backlog task can still be ranked', () => {
    const parked = mk('Parked', 'backlog');
    setPriorities(ctx, [parked.id]);
    expect(getTask(ctx, parked.id).priority).toBe(1);
  });

  it('refuses to rank a task that is done, archived or trashed', () => {
    const done = mk('Finished', 'done');
    const gone = mk('Archived');
    archiveTask(ctx, gone.id);
    const binned = mk('Binned');
    softDelete(ctx, binned.id);
    for (const t of [done, gone, binned]) {
      expect(() => setPriorities(ctx, [t.id])).toThrow(/eligible|done|archived|deleted/i);
    }
  });

  it('reaching done drops the task and closes the gap', () => {
    const a = mk('Alpha'); const b = mk('Bravo'); const c = mk('Charlie');
    setPriorities(ctx, [a.id, b.id, c.id]);
    updateTask(ctx, b.id, { status: 'done' });
    // relative order of the survivors is preserved; only the numbers shift
    expect(ranks()).toEqual([['alpha', 1], ['charlie', 2]]);
  });

  it('archiving drops the task and closes the gap', () => {
    const a = mk('Alpha'); const b = mk('Bravo'); const c = mk('Charlie');
    setPriorities(ctx, [a.id, b.id, c.id]);
    archiveTask(ctx, a.id);
    expect(ranks()).toEqual([['bravo', 1], ['charlie', 2]]);
  });

  it('trashing drops the task and closes the gap', () => {
    const a = mk('Alpha'); const b = mk('Bravo');
    setPriorities(ctx, [a.id, b.id]);
    softDelete(ctx, a.id);
    expect(ranks()).toEqual([['bravo', 1]]);
  });

  it('unarchiving does NOT restore a previous rank', () => {
    const a = mk('Alpha');
    setPriorities(ctx, [a.id]);
    archiveTask(ctx, a.id);
    unarchiveTask(ctx, a.id);
    expect(getTask(ctx, a.id).priority).toBe(null);
  });

  it('a status change that is not done leaves the rank alone', () => {
    const a = mk('Alpha', 'plan');
    setPriorities(ctx, [a.id]);
    updateTask(ctx, a.id, { status: 'review' });
    expect(getTask(ctx, a.id).priority).toBe(1);
  });
});
