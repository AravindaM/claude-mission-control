import { readFileSync, writeFileSync, statSync, appendFileSync, existsSync } from 'node:fs';
import { getTask } from './taskstore.js';
import { resolveBinding } from './binding.js';
import { createTask, getTaskBySlug, recordEvent, unarchiveTask } from './taskstore.js';
import { slugify } from './paths.js';

export const JIRA_KEY = /\b[A-Z][A-Z0-9]+-\d+\b/;

function getOffset(db) {
  const row = db.prepare("SELECT value FROM meta WHERE key='spool_offset'").get();
  return row ? Number(row.value) : 0;
}

function setOffset(db, offset) {
  db.prepare("INSERT INTO meta (key, value) VALUES ('spool_offset', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(String(offset));
}

function bindingState(db) {
  return {
    openTasks: db.prepare(`
      SELECT t.id, t.repo_path,
             (SELECT s.git_branch FROM sessions s WHERE s.task_id = t.id ORDER BY s.started_at DESC LIMIT 1) AS last_branch
      FROM tasks t WHERE t.archived = 0 AND t.deleted_at IS NULL
    `).all(),
    recentSessions: db.prepare(
      'SELECT session_uuid, cwd, task_id, started_at FROM sessions ORDER BY started_at DESC LIMIT 200'
    ).all(),
  };
}

export function attachSession(ctx, sessionUuid, taskId, mode, ts) {
  // Only record an event on an actual change — this is what makes replay idempotent.
  const changed = ctx.db.prepare(
    'UPDATE sessions SET task_id = ? WHERE session_uuid = ? AND (task_id IS NULL OR task_id != ?)'
  ).run(taskId, sessionUuid, taskId).changes;
  if (changed) {
    recordEvent(ctx, { taskId, sessionUuid, type: 'session_attached', detail: { mode } }, ts);
    nameSessionAfterTask(ctx, sessionUuid, taskId);
  }
}

// Claude stores /rename titles as a custom-title line in the session's own
// transcript (verified 2026-08-20); appending one names the session after its
// task so the /resume picker shows task slugs.
function nameSessionAfterTask(ctx, sessionUuid, taskId) {
  const task = getTask(ctx, taskId);
  const session = ctx.db.prepare('SELECT transcript_path FROM sessions WHERE session_uuid = ?').get(sessionUuid);
  if (!task || !session?.transcript_path || !existsSync(session.transcript_path)) return;
  try {
    appendFileSync(
      session.transcript_path,
      JSON.stringify({ type: 'custom-title', customTitle: task.slug, sessionId: sessionUuid }) + '\n',
    );
  } catch { /* naming is cosmetic; never let it break an attach */ }
}

export function applySpoolEvent(ctx, ev) {
  const ts = (ev.ts ?? 0) * 1000;
  switch (ev.hook_event_name) {
    case 'SessionStart': {
      ctx.db.prepare(`
        INSERT INTO sessions (session_uuid, cwd, repo_toplevel, git_branch, transcript_path, started_at, last_activity_at)
        VALUES (@session_id, @cwd, @repo_toplevel, @git_branch, @transcript_path, @ts, @ts)
        ON CONFLICT(session_uuid) DO UPDATE SET
          cwd=excluded.cwd, repo_toplevel=excluded.repo_toplevel, git_branch=excluded.git_branch,
          transcript_path=excluded.transcript_path, last_activity_at=excluded.last_activity_at
      `).run({ ...ev, ts });
      const session = ctx.db.prepare('SELECT task_id FROM sessions WHERE session_uuid = ?').get(ev.session_id);
      if (session.task_id == null) {
        const result = resolveBinding(ev, bindingState(ctx.db));
        if (result.taskId != null) attachSession(ctx, ev.session_id, result.taskId, result.mode, ts);
      }
      break;
    }
    case 'SessionEnd': {
      ctx.db.prepare(`
        INSERT INTO sessions (session_uuid, cwd, repo_toplevel, git_branch, transcript_path, started_at, ended_at, last_activity_at)
        VALUES (@session_id, @cwd, @repo_toplevel, @git_branch, @transcript_path, @ts, @ts, @ts)
        ON CONFLICT(session_uuid) DO UPDATE SET ended_at=@ts, last_activity_at=@ts
      `).run({ ...ev, ts });
      break;
    }
    case 'Stop': {
      // An assistant response is proof of life, so it revokes any ended_at that
      // was only ever a guess: the reconciler's 30-minute mtime heuristic, or
      // SessionEnd(reason:"resume"), which fires on every `claude --resume` of a
      // session that is about to keep running under the same session id.
      // Counting is not replay-idempotent, matching prompt_count below; the
      // spool offset makes that moot outside a truncation.
      ctx.db.prepare(`
        UPDATE sessions SET turn_count = turn_count + 1, last_activity_at = ?, ended_at = NULL
        WHERE session_uuid = ?
      `).run(ts, ev.session_id);
      break; // no row means a session we never saw start; ignore
    }
    case 'UserPromptSubmit': {
      const session = ctx.db.prepare('SELECT * FROM sessions WHERE session_uuid = ?').get(ev.session_id);
      if (!session) break; // prompt for a session we never saw start; ignore
      ctx.db.prepare('UPDATE sessions SET prompt_count = prompt_count + 1, last_activity_at = ? WHERE session_uuid = ?')
        .run(ts, ev.session_id);
      // First prompt of a still-unbound session: a Jira key creates or merges a
      // task; anything else stays in the unassigned tray (user decision 2026-08-20).
      if (session.task_id != null || session.prompt_count > 0) break;
      const jiraKey = (ev.prompt ?? '').match(JIRA_KEY)?.[0];
      if (!jiraKey) break;
      let task = ctx.db.prepare('SELECT * FROM tasks WHERE jira_key = ? AND deleted_at IS NULL').get(jiraKey);
      if (task) {
        if (task.archived) unarchiveTask(ctx, task.id, ts || Date.now());
      } else {
        const words = (ev.prompt ?? '').replace(JIRA_KEY, '').trim().split(/\s+/).slice(0, 8).join(' ');
        task = createTask(ctx, {
          title: `${jiraKey} ${words}`.trim(),
          slug: jiraKey.toLowerCase(), // short id: the key IS the slug
          jiraKey,
          repoPath: ev.repo_toplevel || session.repo_toplevel || null,
        }, ts || Date.now());
        recordEvent(ctx, { taskId: task.id, sessionUuid: ev.session_id, type: 'task_autocreated', detail: { jiraKey } }, ts);
      }
      attachSession(ctx, ev.session_id, task.id, 'first-prompt', ts);
      break;
    }
    case 'bind_intent': {
      // Offline fallback of the /task skill: create-if-missing, then bind.
      let task = getTaskBySlug(ctx, slugify(ev.task_title));
      if (!task) {
        task = createTask(ctx, {
          title: ev.task_title,
          jiraKey: ev.jira_key ?? null,
          repoPath: ev.repo_toplevel || null,
        }, ts || Date.now());
      }
      attachSession(ctx, ev.session_id, task.id, 'explicit', ts);
      break;
    }
    default:
      throw new Error(`unknown spool event ${ev.hook_event_name}`);
  }
}

export function ingestSpool(ctx) {
  const file = ctx.paths.spoolFile();
  let size;
  try {
    size = statSync(file).size;
  } catch {
    return { processed: 0, skipped: 0 };
  }
  let offset = getOffset(ctx.db);
  if (offset > size) offset = 0; // spool was rotated/truncated; replay is idempotent
  if (offset === size) return { processed: 0, skipped: 0 };

  const chunk = readFileSync(file, 'utf8').slice(offset);
  // Only consume complete lines; a partially-written line stays for next ingest.
  const upto = chunk.lastIndexOf('\n');
  if (upto < 0) return { processed: 0, skipped: 0 };
  const lines = chunk.slice(0, upto).split('\n').filter(Boolean);

  let processed = 0;
  let skipped = 0;
  const tx = ctx.db.transaction(() => {
    for (const line of lines) {
      try {
        applySpoolEvent(ctx, JSON.parse(line));
        processed++;
      } catch {
        skipped++;
      }
    }
    setOffset(ctx.db, offset + Buffer.byteLength(chunk.slice(0, upto + 1), 'utf8'));
  });
  tx();
  return { processed, skipped };
}

export function writeBindings(ctx) {
  const rows = ctx.db.prepare(`
    SELECT s.session_uuid, t.slug FROM sessions s JOIN tasks t ON t.id = s.task_id
    WHERE t.deleted_at IS NULL
  `).all();
  const map = Object.fromEntries(rows.map((r) => [r.session_uuid, r.slug]));
  writeFileSync(ctx.paths.bindingsFile(), JSON.stringify(map, null, 2));
}
