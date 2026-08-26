import { existsSync, statSync, copyFileSync, unlinkSync, readdirSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { getTask } from './taskstore.js';
import { writeBindings } from './spool.js';

const DAY = 24 * 60 * 60 * 1000;
const GHOST_AFTER_MS = 30 * 60 * 1000;

function archiveHome(ctx, session) {
  if (session.task_id != null) {
    const task = getTask(ctx, session.task_id);
    // Archived tasks keep only their summary — never re-copy transcripts in.
    if (task?.archived) return null;
    if (task) return ctx.paths.transcriptsDir(task.slug);
  }
  const repoName = basename(session.repo_toplevel || session.cwd || 'unknown');
  return ctx.paths.unboundDir(repoName);
}

export function reconcile({ ctx, config, briefer = null, now = Date.now() }) {
  const result = { copied: 0, pruned: 0, closed: 0 };
  const sessions = ctx.db.prepare('SELECT * FROM sessions WHERE transcript_path IS NOT NULL').all();

  for (const session of sessions) {
    if (!existsSync(session.transcript_path)) continue;
    const src = statSync(session.transcript_path);

    // Honest liveness: hook events lie less than transcript mtime never does.
    if (src.mtimeMs > (session.last_activity_at ?? 0)) {
      ctx.db.prepare('UPDATE sessions SET last_activity_at = ? WHERE session_uuid = ?')
        .run(Math.round(src.mtimeMs), session.session_uuid);
    }
    if (session.ended_at == null && now - src.mtimeMs > GHOST_AFTER_MS) {
      ctx.db.prepare('UPDATE sessions SET ended_at = ? WHERE session_uuid = ?')
        .run(Math.round(src.mtimeMs), session.session_uuid);
      result.closed++;
    }

    const home = archiveHome(ctx, session);
    if (!home) continue;
    const dest = join(home, basename(session.transcript_path));
    const stale = !existsSync(dest) || statSync(dest).mtimeMs < src.mtimeMs;
    if (stale) {
      mkdirSync(home, { recursive: true });
      copyFileSync(session.transcript_path, dest);
      result.copied++;
    }
    if (session.archived_transcript_path && session.archived_transcript_path !== dest
        && existsSync(session.archived_transcript_path)) {
      // Binding appeared after the copy landed in _unbound — relocate.
      unlinkSync(session.archived_transcript_path);
    }
    if (session.archived_transcript_path !== dest) {
      ctx.db.prepare('UPDATE sessions SET archived_transcript_path = ? WHERE session_uuid = ?')
        .run(dest, session.session_uuid);
    }
  }

  // Unbound transcript copies expire; task-bound copies live with the task.
  const retentionMs = (config.unboundRetentionDays ?? 30) * DAY;
  const unboundRoot = join(ctx.paths.dataDir, '_unbound');
  if (existsSync(unboundRoot)) {
    for (const repoDir of readdirSync(unboundRoot)) {
      const dir = join(unboundRoot, repoDir);
      for (const file of readdirSync(dir)) {
        const full = join(dir, file);
        if (now - statSync(full).mtimeMs > retentionMs) {
          unlinkSync(full);
          result.pruned++;
        }
      }
    }
  }

  // Finalize retry: an archived task still holding transcript files means a
  // closing brief failed earlier — try again until the summary lands.
  const archived = ctx.db.prepare('SELECT id, slug FROM tasks WHERE archived = 1 AND deleted_at IS NULL').all();
  for (const task of archived) {
    const dir = ctx.paths.transcriptsDir(task.slug);
    if (existsSync(dir) && readdirSync(dir).length > 0) {
      result.finalizeRetries = (result.finalizeRetries ?? 0) + 1;
      briefer?.finalize(task.id);
    }
  }

  writeBindings(ctx);
  briefer?.sweep();
  return result;
}
