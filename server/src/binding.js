const INHERIT_SOURCES = new Set(['resume', 'clear', 'compact']);

/**
 * Decide which task (if any) a starting session belongs to.
 * Pure function — callers supply current state.
 *
 * @param {{session_id:string, source:string, cwd:string, repo_toplevel:string, git_branch:string}} event
 * @param {{openTasks: Array<{id:number, repo_path:string|null, last_branch:string|null}>,
 *          recentSessions: Array<{session_uuid:string, cwd:string, task_id:number|null, started_at:number}>}} state
 * @returns {{taskId:number|null, mode:'inherit'|'auto'|'none', reason:string}}
 */
export function resolveBinding(event, { openTasks, recentSessions }) {
  if (INHERIT_SOURCES.has(event.source)) {
    const prior = [...recentSessions]
      .filter((s) => s.cwd === event.cwd && s.task_id != null && s.session_uuid !== event.session_id)
      .sort((a, b) => b.started_at - a.started_at)[0];
    if (prior) return { taskId: prior.task_id, mode: 'inherit', reason: `from ${prior.session_uuid}` };
  }

  if (!event.repo_toplevel) return { taskId: null, mode: 'none', reason: 'no-repo' };

  let candidates = openTasks.filter((t) => t.repo_path === event.repo_toplevel);
  if (candidates.length === 0) return { taskId: null, mode: 'none', reason: 'no-match' };
  if (candidates.length > 1 && event.git_branch) {
    const byBranch = candidates.filter((t) => t.last_branch === event.git_branch);
    if (byBranch.length >= 1) candidates = byBranch;
  }
  if (candidates.length === 1) return { taskId: candidates[0].id, mode: 'auto', reason: 'repo-match' };
  // A wrong attach poisons briefs (worse than no attach) — never guess.
  return { taskId: null, mode: 'none', reason: `ambiguous:${candidates.length}` };
}
