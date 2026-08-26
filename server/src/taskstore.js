import { readFileSync, writeFileSync, readdirSync, rmSync, existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import matter from 'gray-matter';
import { slugify } from './paths.js';

export const STATUSES = [
  'explore', 'plan', 'development', 'review', 'testing', 'deploy', 'done',
];

// Pre-2026-08-20 stage names → current lifecycle.
export const LEGACY_STATUS_MAP = {
  reading: 'explore', brainstorm: 'explore', research: 'explore',
  design: 'plan', deployed: 'deploy',
};

// Rewrites legacy stages in BOTH the DB and BRIEF.md frontmatter; must run
// before reindex or files carrying old names would fail validation and drop out.
export function migrateLegacyStatuses(ctx) {
  let migrated = 0;
  for (const [oldStatus, newStatus] of Object.entries(LEGACY_STATUS_MAP)) {
    for (const col of ['status', 'status_before_archive']) {
      ctx.db.prepare(`UPDATE tasks SET ${col} = ? WHERE ${col} = ?`).run(newStatus, oldStatus);
    }
  }
  const entries = readdirSync(ctx.paths.dataDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('_') && !e.name.startsWith('.'));
  for (const e of entries) {
    const briefFile = ctx.paths.briefFile(e.name);
    if (!existsSync(briefFile)) continue;
    try {
      const parsed = matter(readFileSync(briefFile, 'utf8'));
      const fm = parsed.data;
      const next = LEGACY_STATUS_MAP[fm.status];
      const nextBefore = LEGACY_STATUS_MAP[fm.status_before_archive];
      if (!next && !nextBefore) continue;
      if (next) fm.status = next;
      if (nextBefore) fm.status_before_archive = nextBefore;
      writeFileSync(briefFile, matter.stringify(parsed.content, fm));
      migrated++;
    } catch { /* corrupt files are reindex's problem, not migration's */ }
  }
  return migrated;
}

const DAY = 24 * 60 * 60 * 1000;

function rowToFrontmatter(row) {
  return {
    slug: row.slug,
    title: row.title,
    status: row.status,
    archived: !!row.archived,
    status_before_archive: row.status_before_archive ?? null,
    jira_key: row.jira_key ?? null,
    repo_path: row.repo_path ?? null,
    deleted_at: row.deleted_at ?? null,
    created: row.created_at,
    updated: row.updated_at,
  };
}

function writeBriefFile(ctx, row, body) {
  writeFileSync(ctx.paths.briefFile(row.slug), matter.stringify(body, rowToFrontmatter(row)));
}

function readBriefBody(ctx, slug) {
  return matter(readFileSync(ctx.paths.briefFile(slug), 'utf8')).content;
}

// Frontmatter is the durable copy of task metadata: every DB mutation
// rewrites it so the DB stays disposable (see reindex).
function syncFrontmatter(ctx, id) {
  const row = getTask(ctx, id);
  writeBriefFile(ctx, row, readBriefBody(ctx, row.slug));
}

export function getTask(ctx, id) {
  return ctx.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
}

export function getTaskBySlug(ctx, slug) {
  return ctx.db.prepare('SELECT * FROM tasks WHERE slug = ?').get(slug);
}

export function listTasks(ctx) {
  return ctx.db.prepare('SELECT * FROM tasks ORDER BY slug').all();
}

// Binding compares repo_path against git's --show-toplevel, which resolves
// symlinks (/tmp, /var/folders, user-linked workspaces) — store the resolved form.
export function normalizeRepoPath(repoPath) {
  if (!repoPath) return repoPath;
  try {
    return realpathSync(repoPath);
  } catch {
    return repoPath;
  }
}

export function createTask(ctx, { title, jiraKey = null, repoPath = null, status = 'explore', slug = null }, now = Date.now()) {
  assertStatus(status);
  repoPath = normalizeRepoPath(repoPath);
  slug = slugify(slug ?? title);
  if (getTaskBySlug(ctx, slug)) slug = `${slug}-${now.toString(36)}`;
  const { lastInsertRowid } = ctx.db.prepare(`
    INSERT INTO tasks (slug, title, status, jira_key, repo_path, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(slug, title, status, jiraKey, repoPath, now, now);
  const row = getTask(ctx, lastInsertRowid);
  ctx.paths.ensureTaskDirs(slug);
  writeBriefFile(ctx, row, `# ${title}\n\n_No brief yet._\n`);
  recordEvent(ctx, { taskId: row.id, type: 'created' }, now);
  return row;
}

function assertStatus(status) {
  if (!STATUSES.includes(status)) {
    throw new Error(`invalid status "${status}" — expected one of ${STATUSES.join(', ')}`);
  }
}

export function updateTask(ctx, id, patch, now = Date.now()) {
  if (patch.status !== undefined) assertStatus(patch.status);
  const allowed = ['title', 'status', 'jira_key', 'repo_path'];
  const fields = allowed.filter((f) => patch[f] !== undefined || patch[camel(f)] !== undefined);
  if (fields.length === 0) return getTask(ctx, id);
  const tx = ctx.db.transaction(() => {
    for (const f of fields) {
      let value = patch[f] !== undefined ? patch[f] : patch[camel(f)];
      if (f === 'repo_path') value = normalizeRepoPath(value);
      ctx.db.prepare(`UPDATE tasks SET ${f} = ?, updated_at = ? WHERE id = ?`).run(value, now, id);
      if (f === 'status') recordEvent(ctx, { taskId: id, type: 'status_changed', detail: { to: value } }, now);
    }
  });
  tx();
  syncFrontmatter(ctx, id);
  return getTask(ctx, id);
}

function camel(snake) {
  return snake.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

export function archiveTask(ctx, id, now = Date.now()) {
  const row = getTask(ctx, id);
  ctx.db.prepare('UPDATE tasks SET archived = 1, status_before_archive = ?, updated_at = ? WHERE id = ?')
    .run(row.status, now, id);
  recordEvent(ctx, { taskId: id, type: 'archived' }, now);
  syncFrontmatter(ctx, id);
  return getTask(ctx, id);
}

export function unarchiveTask(ctx, id, now = Date.now()) {
  const row = getTask(ctx, id);
  ctx.db.prepare('UPDATE tasks SET archived = 0, status = ?, status_before_archive = NULL, updated_at = ? WHERE id = ?')
    .run(row.status_before_archive ?? row.status, now, id);
  recordEvent(ctx, { taskId: id, type: 'unarchived' }, now);
  syncFrontmatter(ctx, id);
  return getTask(ctx, id);
}

export function saveBrief(ctx, taskId, body, source, now = Date.now()) {
  const row = getTask(ctx, taskId);
  const previous = readBriefBody(ctx, row.slug);
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
  // Sequence suffix: two saves in the same millisecond must not overwrite a version.
  const seq = readdirSync(ctx.paths.briefsDir(row.slug)).length;
  writeFileSync(join(ctx.paths.briefsDir(row.slug), `${stamp}-${String(seq).padStart(3, '0')}.md`), previous);
  ctx.db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(now, taskId);
  writeBriefFile(ctx, getTask(ctx, taskId), body);
  recordEvent(ctx, { taskId, type: 'brief_saved', detail: { source } }, now);
}

export function getBrief(ctx, taskId) {
  return readBriefBody(ctx, getTask(ctx, taskId).slug);
}

export function softDelete(ctx, id, now = Date.now()) {
  ctx.db.prepare('UPDATE tasks SET deleted_at = ?, updated_at = ? WHERE id = ?').run(now, now, id);
  recordEvent(ctx, { taskId: id, type: 'trashed' }, now);
  syncFrontmatter(ctx, id);
}

export function restoreTrash(ctx, id, now = Date.now()) {
  ctx.db.prepare('UPDATE tasks SET deleted_at = NULL, updated_at = ? WHERE id = ?').run(now, id);
  recordEvent(ctx, { taskId: id, type: 'restored' }, now);
  syncFrontmatter(ctx, id);
}

export function purgeExpired(ctx, now = Date.now(), retentionDays = 30) {
  const cutoff = now - retentionDays * DAY;
  const expired = ctx.db.prepare('SELECT * FROM tasks WHERE deleted_at IS NOT NULL AND deleted_at < ?').all(cutoff);
  for (const row of expired) {
    ctx.db.prepare('DELETE FROM tasks WHERE id = ?').run(row.id); // FKs cascade sessions/events
    rmSync(ctx.paths.taskDir(row.slug), { recursive: true, force: true });
  }
  return expired.length;
}

export function recordEvent(ctx, { taskId = null, sessionUuid = null, type, detail = null }, now = Date.now()) {
  ctx.db.prepare('INSERT INTO events (task_id, session_uuid, type, detail, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(taskId, sessionUuid, type, detail ? JSON.stringify(detail) : null, now);
}

export function reindex(ctx) {
  const entries = readdirSync(ctx.paths.dataDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('_') && !e.name.startsWith('.'));
  const insert = ctx.db.prepare(`
    INSERT INTO tasks (slug, title, status, archived, status_before_archive, jira_key, repo_path, deleted_at, created_at, updated_at)
    VALUES (@slug, @title, @status, @archived, @status_before_archive, @jira_key, @repo_path, @deleted_at, @created, @updated)
    ON CONFLICT(slug) DO UPDATE SET
      title=excluded.title, status=excluded.status, archived=excluded.archived,
      status_before_archive=excluded.status_before_archive, jira_key=excluded.jira_key,
      repo_path=excluded.repo_path, deleted_at=excluded.deleted_at,
      created_at=excluded.created_at, updated_at=excluded.updated_at
  `);
  let indexed = 0;
  for (const e of entries) {
    const briefFile = ctx.paths.briefFile(e.name);
    if (!existsSync(briefFile)) continue;
    try {
      const fm = matter(readFileSync(briefFile, 'utf8')).data;
      if (!fm.slug || !fm.title || !STATUSES.includes(fm.status)) continue;
      insert.run({
        slug: fm.slug,
        title: fm.title,
        status: fm.status,
        archived: fm.archived ? 1 : 0,
        status_before_archive: fm.status_before_archive ?? null,
        jira_key: fm.jira_key ?? null,
        repo_path: fm.repo_path ?? null,
        deleted_at: fm.deleted_at ?? null,
        created: fm.created,
        updated: fm.updated,
      });
      indexed++;
    } catch {
      // A corrupt BRIEF.md must never take the index down; the task
      // simply stays unindexed until the file is fixed.
    }
  }
  return indexed;
}
