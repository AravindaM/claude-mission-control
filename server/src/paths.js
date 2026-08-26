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
    spoolFile: () => join(dataDir, '_spool', 'events.jsonl'),
    bindingsFile: () => join(dataDir, '_spool', 'bindings.json'),
    dbFile: () => join(dataDir, '.index', 'mission-control.db'),
    ensureBaseDirs() {
      for (const d of [join(dataDir, '_spool'), join(dataDir, '.index'), join(dataDir, '_unbound')]) {
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
