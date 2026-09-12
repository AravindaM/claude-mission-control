import { readFileSync, writeFileSync, readdirSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import matter from 'gray-matter';
import { getTask, getTaskBySlug } from './taskstore.js';

// Some gh failures are permanent: the PR was deleted, the repo went private,
// your access was revoked. Without a cap those retry every hour forever,
// spawning a subprocess each time to learn the same thing. Giving up is the
// sweep's decision only — a manual refresh always tries.
export const GH_FAILURE_CAP = 5;

const PR_PATH = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:[/#?].*)?$/;

/**
 * Reduce any form of a PR url to one canonical string.
 *
 * This is what makes the UNIQUE index on `url` mean anything. `/pull/212` and
 * `/pull/212/files` are different strings, so storing what was pasted would let
 * the same PR in twice — and a browser address bar is usually sitting on
 * `/files` or a `#discussion_r…` anchor when you copy it.
 */
export function canonicalizePrUrl(input) {
  let parsed;
  try {
    parsed = new URL(String(input ?? '').trim());
  } catch {
    throw new Error(`not a pull request url: ${input}`);
  }
  if (!/^https?:$/.test(parsed.protocol)) throw new Error(`not a pull request url: ${input}`);
  const match = parsed.pathname.replace(/\/+$/, '').match(PR_PATH);
  if (!match) throw new Error(`not a pull request url: ${input}`);

  const host = parsed.host.replace(/^www\./, '');
  const [, owner, repo, number] = match;
  return {
    url: `https://${host}/${owner}/${repo}/pull/${Number(number)}`,
    host,
    owner,
    repo,
    number: Number(number),
  };
}

export function getPr(ctx, id) {
  return ctx.db.prepare('SELECT * FROM prs WHERE id = ?').get(id);
}

export function getPrByUrl(ctx, url) {
  return ctx.db.prepare('SELECT * FROM prs WHERE url = ?').get(url);
}

export function listPrs(ctx) {
  return ctx.db.prepare('SELECT * FROM prs ORDER BY position').all();
}

// ---- durable form -----------------------------------------------------------
// The file holds ONLY what gh cannot re-supply: the url you chose to track, the
// task you linked, and the order you put it in. Writing a cached title to disk
// would be a second copy to keep correct for no gain.

function writePrFile(ctx, row) {
  mkdirSync(ctx.paths.prsDir(), { recursive: true });
  const task = row.task_id != null ? getTask(ctx, row.task_id) : null;
  const file = ctx.paths.prFile(row.host, row.owner, row.repo, row.number);
  writeFileSync(file, matter.stringify('', {
    url: row.url,
    // A slug, not an id: ids are an index artefact reindex may reassign, slugs
    // are stable and greppable without the server.
    task: task?.slug ?? null,
    position: row.position,
    added: row.added_at,
  }));
}

function removePrFile(ctx, row) {
  rmSync(ctx.paths.prFile(row.host, row.owner, row.repo, row.number), { force: true });
}

// ---- writes -----------------------------------------------------------------

export function addPr(ctx, { url, taskId = null }, now = Date.now()) {
  const id = canonicalizePrUrl(url);
  const existing = getPrByUrl(ctx, id.url);
  if (existing) {
    // Re-adding something already tracked is what you do when you cannot
    // remember whether you added it. Treat it as a no-op plus an optional link.
    if (taskId != null) setPrTask(ctx, existing.id, taskId, now);
    return getPr(ctx, existing.id);
  }
  const next = (ctx.db.prepare('SELECT MAX(position) AS m FROM prs').get().m ?? 0) + 1;
  const { lastInsertRowid } = ctx.db.prepare(`
    INSERT INTO prs (url, host, owner, repo, number, position, task_id, added_at, updated_at)
    VALUES (@url, @host, @owner, @repo, @number, @position, @taskId, @now, @now)
  `).run({ ...id, position: next, taskId, now });
  const row = getPr(ctx, lastInsertRowid);
  writePrFile(ctx, row);
  return row;
}

export function setPrTask(ctx, id, taskId, now = Date.now()) {
  ctx.db.prepare('UPDATE prs SET task_id = ?, updated_at = ? WHERE id = ?').run(taskId, now, id);
  const row = getPr(ctx, id);
  if (row) writePrFile(ctx, row);
  return row;
}

export function deletePr(ctx, id) {
  const row = getPr(ctx, id);
  if (!row) return false;
  // File first. The files are the source of truth, so a row deleted while its
  // file survives is resurrected by the next reindex — the PR reappears after a
  // restart with no way to remove it. An orphan row is the recoverable
  // direction: the next reindex drops it.
  removePrFile(ctx, row);
  ctx.db.prepare('DELETE FROM prs WHERE id = ?').run(id);
  return true;
}

/**
 * Restate the order of some PRs.
 *
 * Defined as a permutation of the positions those ids ALREADY hold, which is
 * why it needs no column parameter and cannot corrupt anything: the set of
 * positions in play is unchanged, so global uniqueness survives and no row
 * outside the request moves.
 */
export function setPrOrder(ctx, order, now = Date.now()) {
  if (!Array.isArray(order)) throw new Error('order must be an array of pr ids');
  const ids = order.map(Number);
  if (new Set(ids).size !== ids.length) throw new Error('duplicate pr id in order');
  const rows = ids.map((id) => {
    const row = getPr(ctx, id);
    if (!row) throw new Error(`unknown pr id ${id}`);
    return row;
  });
  const positions = rows.map((r) => r.position).sort((a, b) => a - b);
  const write = ctx.db.prepare('UPDATE prs SET position = ?, updated_at = ? WHERE id = ?');
  ctx.db.transaction(() => {
    rows.forEach((row, i) => write.run(positions[i], now, row.id));
  })();
  for (const row of rows) writePrFile(ctx, getPr(ctx, row.id));
  return ids;
}

/**
 * Fold one gh lookup into a record. `result.error` marks a failure; anything
 * else is a successful read.
 */
export function applyGhResult(ctx, id, result, now = Date.now()) {
  const row = getPr(ctx, id);
  if (!row) return null;

  if (result?.error) {
    ctx.db.prepare(`
      UPDATE prs SET gh_error = ?, gh_failures = gh_failures + 1, gh_fetched_at = ?, updated_at = ?
      WHERE id = ?
    `).run(String(result.error).slice(0, 500), now, now, id);
    return getPr(ctx, id);
  }

  const state = String(result.state ?? 'open').toLowerCase();
  // gh returns mergedAt:null for a PR closed without merging, and both kinds
  // share the merged column — ordering by mergedAt alone would stack every
  // abandoned PR under a null.
  const resolvedAt = state === 'merged' ? (result.mergedAt ?? now)
    : state === 'closed' ? (row.resolved_at ?? now)
      : null;

  ctx.db.prepare(`
    UPDATE prs SET
      title = @title, author_login = @authorLogin, author_is_me = @isMe,
      state = @state, review_decision = @reviewDecision, is_draft = @isDraft,
      resolved_at = @resolvedAt, gh_error = NULL, gh_failures = 0,
      gh_fetched_at = @now, updated_at = @now
    WHERE id = @id
  `).run({
    id,
    title: result.title ?? row.title ?? null,
    authorLogin: result.authorLogin ?? null,
    // Left NULL when the viewer login is unknown. A 0 here would file your own
    // PR under someone else's and look entirely plausible doing it.
    isMe: result.isMe == null ? null : (result.isMe ? 1 : 0),
    state,
    reviewDecision: result.reviewDecision ?? null,
    isDraft: result.isDraft ? 1 : 0,
    resolvedAt,
    now,
  });
  return getPr(ctx, id);
}

/** PRs the sweep should re-read, oldest fetch first. */
export function dueForRefresh(ctx, { refreshHours = 1, now = Date.now() } = {}) {
  if (!refreshHours) return []; // 0 disables the schedule, not the feature
  const cutoff = now - refreshHours * 60 * 60 * 1000;
  return ctx.db.prepare(`
    SELECT * FROM prs
    WHERE state != 'merged'              -- merged is terminal; github cannot unmerge
      AND gh_failures < ?
      AND (gh_fetched_at IS NULL OR gh_fetched_at < ?)
    ORDER BY gh_fetched_at IS NOT NULL, gh_fetched_at
  `).all(GH_FAILURE_CAP, cutoff);
}

// ---- rebuild ----------------------------------------------------------------

export function reindexPrs(ctx) {
  const dir = ctx.paths.prsDir();
  if (!existsSync(dir)) return 0;
  const insert = ctx.db.prepare(`
    INSERT INTO prs (url, host, owner, repo, number, position, task_id, added_at, updated_at)
    VALUES (@url, @host, @owner, @repo, @number, @position, @taskId, @added, @added)
    ON CONFLICT(url) DO UPDATE SET
      position = excluded.position, task_id = excluded.task_id
  `);
  let indexed = 0;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.md')) continue;
    try {
      const fm = matter(readFileSync(join(dir, name), 'utf8')).data;
      const id = canonicalizePrUrl(fm.url);
      // An unresolvable task link is not a reason to lose the PR.
      const task = fm.task ? getTaskBySlug(ctx, fm.task) : null;
      insert.run({
        ...id,
        position: Number.isInteger(fm.position) ? fm.position : indexed + 1,
        taskId: task?.id ?? null,
        added: fm.added ?? Date.now(),
      });
      indexed++;
    } catch {
      // A corrupt or non-PR file must never take the index down; it simply
      // stays unindexed until someone fixes it.
    }
  }
  return indexed;
}
