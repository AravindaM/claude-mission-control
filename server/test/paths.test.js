import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { slugify, createPaths } from '../src/paths.js';
import { loadConfig } from '../src/config.js';

describe('slugify', () => {
  it('turns a task title into a filesystem-safe slug', () => {
    expect(slugify('DEMO-114: Search pagination!')).toBe('demo-114-search-pagination');
  });

  it('collapses runs of separators and trims edge dashes', () => {
    expect(slugify('  Cache -> Managed Cache  (TLS + ACL)  ')).toBe('cache-managed-cache-tls-acl');
  });

  it('never returns an empty slug', () => {
    expect(slugify('!!!')).toMatch(/^task-/);
  });
});

describe('createPaths', () => {
  let dataDir;
  let paths;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'mc-test-'));
    paths = createPaths(dataDir);
  });

  it('builds all well-known paths under the data dir', () => {
    expect(paths.taskDir('foo')).toBe(join(dataDir, 'foo'));
    expect(paths.briefFile('foo')).toBe(join(dataDir, 'foo', 'BRIEF.md'));
    expect(paths.briefsDir('foo')).toBe(join(dataDir, 'foo', 'briefs'));
    expect(paths.transcriptsDir('foo')).toBe(join(dataDir, 'foo', 'transcripts'));
    expect(paths.unboundDir('my-repo')).toBe(join(dataDir, '_unbound', 'my-repo'));
    expect(paths.spoolFile()).toBe(join(dataDir, '_spool', 'events.jsonl'));
    expect(paths.bindingsFile()).toBe(join(dataDir, '_spool', 'bindings.json'));
    expect(paths.dbFile()).toBe(join(dataDir, '.index', 'mission-control.db'));
  });

  it('ensureTaskDirs creates the task skeleton', () => {
    paths.ensureTaskDirs('bar');
    expect(existsSync(join(dataDir, 'bar', 'briefs'))).toBe(true);
    expect(existsSync(join(dataDir, 'bar', 'transcripts'))).toBe(true);
  });

  it('ensureBaseDirs creates spool/index/unbound roots', () => {
    paths.ensureBaseDirs();
    expect(existsSync(join(dataDir, '_spool'))).toBe(true);
    expect(existsSync(join(dataDir, '.index'))).toBe(true);
    expect(existsSync(join(dataDir, '_unbound'))).toBe(true);
  });
});

describe('loadConfig', () => {
  it('honours MC_DATA_DIR and MC_PORT env overrides and applies defaults', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'mc-cfg-'));
    const cfg = loadConfig({ MC_DATA_DIR: dataDir, MC_PORT: '55555' });
    expect(cfg.dataDir).toBe(dataDir);
    expect(cfg.port).toBe(55555);
    expect(cfg.briefModel).toBe('sonnet');
    expect(cfg.staleMinutes).toBe(4);
    expect(cfg.injectCapBytes).toBe(8192);
    expect(typeof cfg.claudeBin).toBe('string');
  });

  it('reads overrides from .index/config.json when present', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'mc-cfg-'));
    const paths = createPaths(dataDir);
    paths.ensureBaseDirs();
    writeFileSync(join(dataDir, '.index', 'config.json'), JSON.stringify({
      claudeBin: '/opt/claude/bin/claude',
      briefModel: 'haiku'
    }));
    const cfg = loadConfig({ MC_DATA_DIR: dataDir });
    expect(cfg.claudeBin).toBe('/opt/claude/bin/claude');
    expect(cfg.briefModel).toBe('haiku');
    expect(cfg.port).toBe(47613);
  });
});
