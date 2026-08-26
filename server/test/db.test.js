import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';

function tmpDbFile() {
  return join(mkdtempSync(join(tmpdir(), 'mc-db-')), 'test.db');
}

describe('openDb', () => {
  it('applies the schema idempotently (open twice on same file)', () => {
    const file = tmpDbFile();
    const db1 = openDb(file);
    db1.close();
    const db2 = openDb(file);
    const tables = db2.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all().map(r => r.name);
    expect(tables).toEqual(expect.arrayContaining(['tasks', 'sessions', 'events', 'meta']));
    db2.close();
  });

  it('runs in WAL mode with foreign keys on', () => {
    const db = openDb(tmpDbFile());
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    db.close();
  });

  it('cascades sessions and events when a task row is deleted', () => {
    const db = openDb(tmpDbFile());
    const { lastInsertRowid: taskId } = db.prepare(
      "INSERT INTO tasks (slug, title, status, created_at, updated_at) VALUES ('t', 'T', 'explore', 1, 1)"
    ).run();
    db.prepare(
      "INSERT INTO sessions (session_uuid, task_id, started_at) VALUES ('s1', ?, 1)"
    ).run(taskId);
    db.prepare(
      "INSERT INTO events (task_id, session_uuid, type, created_at) VALUES (?, 's1', 'attached', 1)"
    ).run(taskId);
    db.prepare('DELETE FROM tasks WHERE id = ?').run(taskId);
    expect(db.prepare('SELECT COUNT(*) c FROM sessions').get().c).toBe(0);
    expect(db.prepare('SELECT COUNT(*) c FROM events').get().c).toBe(0);
    db.close();
  });
});
