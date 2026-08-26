import Database from 'better-sqlite3';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0,
  status_before_archive TEXT,
  jira_key TEXT,
  repo_path TEXT,
  deleted_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  session_uuid TEXT PRIMARY KEY,
  task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
  cwd TEXT,
  repo_toplevel TEXT,
  git_branch TEXT,
  transcript_path TEXT,
  archived_transcript_path TEXT,
  started_at INTEGER,
  ended_at INTEGER,
  last_activity_at INTEGER,
  brief_generated_at INTEGER,
  hidden INTEGER NOT NULL DEFAULT 0,
  prompt_count INTEGER NOT NULL DEFAULT 0,
  briefed_prompt_count INTEGER NOT NULL DEFAULT 0,
  turn_count INTEGER NOT NULL DEFAULT 0,
  briefed_turn_index INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
  session_uuid TEXT,
  type TEXT NOT NULL,
  detail TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_task ON sessions(task_id);
CREATE INDEX IF NOT EXISTS idx_sessions_cwd ON sessions(cwd);
CREATE INDEX IF NOT EXISTS idx_events_task ON events(task_id, created_at);
`;

export function openDb(file) {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

// Additive migrations for DBs created before a column existed.
function migrate(db) {
  // Rename before the additive pass, or the ADD COLUMN below would recreate the
  // old name as an empty column. briefed_user_turns counted user prompts;
  // briefed_turn_index counts ALL distilled turns so an agentic run that works
  // for hours off one prompt still registers as new material. Carrying the old
  // values over is safe: a user count is <= the turn count, so every session
  // simply becomes due once.
  try {
    db.exec('ALTER TABLE sessions RENAME COLUMN briefed_user_turns TO briefed_turn_index');
  } catch (err) {
    if (!/no such column|no such table/.test(String(err))) throw err;
  }
  for (const ddl of [
    'ALTER TABLE sessions ADD COLUMN prompt_count INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE sessions ADD COLUMN briefed_prompt_count INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE sessions ADD COLUMN turn_count INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE sessions ADD COLUMN briefed_turn_index INTEGER NOT NULL DEFAULT 0',
  ]) {
    try {
      db.exec(ddl);
    } catch (err) {
      if (!/duplicate column/.test(String(err))) throw err;
    }
  }
}
