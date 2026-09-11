import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export function slugify(title) {
  const slug = String(title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  // A slug doubles as a directory name; an empty one would collapse
  // every unnamed task into the data root.
  return slug || `task-${Math.random().toString(36).slice(2, 8)}`;
}

export function createPaths(dataDir) {
  const p = {
    dataDir,
    taskDir: (slug) => join(dataDir, slug),
    briefFile: (slug) => join(dataDir, slug, 'BRIEF.md'),
    briefsDir: (slug) => join(dataDir, slug, 'briefs'),
    transcriptsDir: (slug) => join(dataDir, slug, 'transcripts'),
    unboundDir: (repoName) => join(dataDir, '_unbound', repoName),
    // The underscore is load-bearing: reindex enumerates task directories with
    // !startsWith('_'), so a bare `prs/` would be read as a task, fail slug
    // validation and vanish silently. Same convention as _spool and _unbound.
    prsDir: () => join(dataDir, '_prs'),
    // host+owner in the name because two orgs can each have an `api` repo with
    // a PR #1, and a shorter name would overwrite one watchlist entry with
    // another.
    prFile: (host, owner, repo, number) =>
      join(dataDir, '_prs', `${[host, owner, repo, number].map(slugify).join('-')}.md`),
    spoolFile: () => join(dataDir, '_spool', 'events.jsonl'),
    bindingsFile: () => join(dataDir, '_spool', 'bindings.json'),
    dbFile: () => join(dataDir, '.index', 'mission-control.db'),
    ensureBaseDirs() {
      for (const d of [join(dataDir, '_spool'), join(dataDir, '.index'),
        join(dataDir, '_unbound'), join(dataDir, '_prs')]) {
        mkdirSync(d, { recursive: true });
      }
    },
    ensureTaskDirs(slug) {
      mkdirSync(p.briefsDir(slug), { recursive: true });
      mkdirSync(p.transcriptsDir(slug), { recursive: true });
    },
  };
  return p;
}
