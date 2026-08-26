import { describe, it, expect } from 'vitest';
import { resolveBinding } from '../src/binding.js';

const tasks = (...t) => t.map((x, i) => ({ id: i + 1, ...x }));

describe('resolveBinding', () => {
  it('inherits from the most recent bound session in the same cwd on resume/clear/compact', () => {
    for (const source of ['resume', 'clear', 'compact']) {
      const result = resolveBinding(
        { session_id: 's-new', source, cwd: '/repo/a', repo_toplevel: '/repo/a', git_branch: 'main' },
        {
          openTasks: tasks({ repo_path: '/repo/a', last_branch: 'main' }),
          recentSessions: [
            { session_uuid: 's-old', cwd: '/repo/a', task_id: 42, started_at: 100 },
            { session_uuid: 's-older', cwd: '/repo/a', task_id: 7, started_at: 50 },
          ],
        },
      );
      expect(result).toMatchObject({ taskId: 42, mode: 'inherit' });
    }
  });

  it('auto-attaches when exactly one open task matches the repo toplevel', () => {
    const result = resolveBinding(
      { session_id: 's', source: 'startup', cwd: '/repo/a/sub', repo_toplevel: '/repo/a', git_branch: 'dev' },
      { openTasks: tasks({ repo_path: '/repo/a', last_branch: 'main' }, { repo_path: '/repo/b', last_branch: 'main' }), recentSessions: [] },
    );
    expect(result).toMatchObject({ taskId: 1, mode: 'auto' });
  });

  it('refuses to attach when two tasks share the repo and the branch does not disambiguate', () => {
    const result = resolveBinding(
      { session_id: 's', source: 'startup', cwd: '/repo/a', repo_toplevel: '/repo/a', git_branch: 'develop' },
      { openTasks: tasks({ repo_path: '/repo/a', last_branch: 'develop' }, { repo_path: '/repo/a', last_branch: 'develop' }), recentSessions: [] },
    );
    expect(result).toMatchObject({ taskId: null, mode: 'none', reason: 'ambiguous:2' });
  });

  it('uses last-known branch as a tiebreaker between same-repo tasks', () => {
    const result = resolveBinding(
      { session_id: 's', source: 'startup', cwd: '/repo/a', repo_toplevel: '/repo/a', git_branch: 'feature/x' },
      { openTasks: tasks({ repo_path: '/repo/a', last_branch: 'develop' }, { repo_path: '/repo/a', last_branch: 'feature/x' }), recentSessions: [] },
    );
    expect(result).toMatchObject({ taskId: 2, mode: 'auto' });
  });

  it('returns none when nothing matches or repo is unknown', () => {
    expect(resolveBinding(
      { session_id: 's', source: 'startup', cwd: '/elsewhere', repo_toplevel: '', git_branch: '' },
      { openTasks: tasks({ repo_path: '/repo/a', last_branch: 'main' }), recentSessions: [] },
    )).toMatchObject({ taskId: null, mode: 'none' });
  });
});
