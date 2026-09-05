import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, copyFileSync, readFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import matter from 'gray-matter';
import { openDb } from '../src/db.js';
import { createPaths } from '../src/paths.js';
import { createTask, saveBrief } from '../src/taskstore.js';
import { createBriefer } from '../src/briefer.js';
import { countTurns } from '../src/transcript.js';
import { sectionOf } from '../src/briefformat.js';

const fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'transcript.jsonl');

const appendUserTurn = (path, text) =>
  appendFileSync(path, `${JSON.stringify({ type: 'user', message: { role: 'user', content: text } })}\n`);

const STATUS_OUT = '## Status\nupdated brief\n- Now: x\n- Next: y';
const FULL_OUT = '## About\nfinal scope\n\n## Status\ndone\n- Now: x\n\n## Links\n- DEMO-1, PR #9';
const SEED_BRIEF = '## About\nOriginal scope of the work.\n\n## Status\nNothing yet.\n\n## Decisions\n- seeded choice\n\n## Links\n- SEED-1';

// `outputs` lets a test drive a multi-call pass (About then Status); the last
// entry repeats if more calls arrive than were scripted.
function fakeSpawnFactory({ exitCode = 0, output = STATUS_OUT, outputs = null } = {}) {
  const calls = [];
  const spawn = (cmd, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    let stdin = '';
    child.stdin = { write: (s) => { stdin += s; }, end: () => {
      const n = calls.length;
      calls.push({ cmd, args, opts, stdin });
      const payload = outputs ? outputs[Math.min(n, outputs.length - 1)] : output;
      setImmediate(() => {
        if (payload) child.stdout.emit('data', payload);
        child.emit('close', exitCode);
      });
    } };
    return child;
  };
  return { spawn, calls };
}

describe('briefer', () => {
  let ctx, config, task;

  beforeEach(() => {
    const dataDir = mkdtempSync(join(tmpdir(), 'mc-brief-'));
    const paths = createPaths(dataDir);
    paths.ensureBaseDirs();
    ctx = { db: openDb(paths.dbFile()), paths };
    config = { claudeBin: '/fake/claude', briefModel: 'sonnet', dataDir };
    task = createTask(ctx, { title: 'Briefed Task', repoPath: '/repo/a' });
    saveBrief(ctx, task.id, SEED_BRIEF, 'manual');
  });

  function insertSession(over = {}) {
    const transcript = join(mkdtempSync(join(tmpdir(), 'mc-tr-')), 't.jsonl');
    copyFileSync(fixture, transcript);
    ctx.db.prepare(`
      INSERT INTO sessions (session_uuid, task_id, transcript_path, started_at, ended_at, last_activity_at)
      VALUES (@uuid, @taskId, @transcript, 1, 2, 2)
    `).run({ uuid: over.uuid ?? 's-1', taskId: over.taskId ?? task.id, transcript, ...over });
    return over.uuid ?? 's-1';
  }

  it('spawns claude with the exact safety flags and MC_INTERNAL, feeding prompt on stdin', async () => {
    const { spawn, calls } = fakeSpawnFactory();
    const briefer = createBriefer({ ctx, config, spawn });
    briefer.enqueue(insertSession());
    await briefer.drain();
    expect(calls.length).toBe(1);
    expect(calls[0].cmd).toBe('/fake/claude');
    expect(calls[0].args.slice(0, 5)).toEqual(['-p', '--no-session-persistence', '--model', 'sonnet', '--append-system-prompt']);
    expect(calls[0].opts.env.MC_INTERNAL).toBe('1');
    expect(calls[0].stdin).toContain('Original scope of the work.'); // the About section anchors the prompt
    expect(calls[0].stdin).toContain('pagination bug'); // conversation text included
    expect(calls[0].stdin).not.toContain('GIANT TOOL OUTPUT'); // tool noise excluded
  });

  it('on success writes a versioned auto brief and stamps the session', async () => {
    const { spawn } = fakeSpawnFactory({ output: '## Status\nupdated by auto brief\n- Now: x' });
    const briefer = createBriefer({ ctx, config, spawn });
    const uuid = insertSession();
    briefer.enqueue(uuid);
    await briefer.drain();
    const fm = matter(readFileSync(ctx.paths.briefFile(task.slug), 'utf8'));
    expect(fm.content).toContain('updated by auto brief');
    const row = ctx.db.prepare('SELECT brief_generated_at FROM sessions WHERE session_uuid = ?').get(uuid);
    expect(row.brief_generated_at).toBeGreaterThan(0);
  });

  it('sweep re-briefs a LIVE session with new prompts and a stale brief, then stamps progress', async () => {
    const { spawn, calls } = fakeSpawnFactory({ output: '## Status\nlive rebrief\n- Now: x' });
    const briefer = createBriefer({ ctx, config: { ...config, staleMinutes: 20 }, spawn });
    const uuid = insertSession({ uuid: 'live-re' });
    ctx.db.prepare(`
      UPDATE sessions SET ended_at = NULL, prompt_count = 9, briefed_prompt_count = 4,
        brief_generated_at = ? WHERE session_uuid = 'live-re'
    `).run(Date.now() - 30 * 60 * 1000); // stale brief, 5 new prompts
    await briefer.sweep();
    expect(calls.length).toBe(1);
    const row = ctx.db.prepare("SELECT briefed_prompt_count FROM sessions WHERE session_uuid='live-re'").get();
    expect(row.briefed_prompt_count).toBe(9);
    // no new prompts since → second sweep does nothing
    await briefer.sweep();
    expect(calls.length).toBe(1);
  });

  it('sweep leaves a live session alone while its brief is still fresh', async () => {
    const { spawn, calls } = fakeSpawnFactory();
    const briefer = createBriefer({ ctx, config: { ...config, staleMinutes: 20 }, spawn });
    insertSession({ uuid: 'live-fresh' });
    ctx.db.prepare(`
      UPDATE sessions SET ended_at = NULL, prompt_count = 9, briefed_prompt_count = 4,
        brief_generated_at = ? WHERE session_uuid = 'live-fresh'
    `).run(Date.now() - 5 * 60 * 1000); // new prompts but briefed 5 min ago
    await briefer.sweep();
    expect(calls.length).toBe(0);
  });

  it('accepts fenced or preambled output by normalizing before validation', async () => {
    // Live failure 2026-08-20: a valid 1.5KB brief was rejected because the
    // model wrapped it in ``` fences.
    const { spawn } = fakeSpawnFactory({ output: 'Here is the update:\n```markdown\n## Status\nfenced\n- Now: y\n```' });
    const briefer = createBriefer({ ctx, config, spawn });
    const uuid = insertSession({ uuid: 'fenced' });
    briefer.enqueue(uuid);
    await briefer.drain();
    const fm = matter(readFileSync(ctx.paths.briefFile(task.slug), 'utf8'));
    expect(fm.content.startsWith('## About')).toBe(true);
    expect(fm.content).toContain('fenced');
  });

  it('rejects a prompt-captured conversational reply instead of saving it as the brief', async () => {
    // Regression: the summarizer once ANSWERED the transcript instead of
    // distilling it, and the garbage overwrote a real brief.
    const { spawn } = fakeSpawnFactory({ output: 'Confirmed: the underlying data is fine — want me to hand you the one-liner?' });
    const briefer = createBriefer({ ctx, config, spawn });
    const uuid = insertSession({ uuid: 'captured' });
    briefer.enqueue(uuid);
    await briefer.drain();
    const fm = matter(readFileSync(ctx.paths.briefFile(task.slug), 'utf8'));
    expect(fm.content).toContain('Nothing yet.'); // the old status survived the rejection
    expect(ctx.db.prepare("SELECT COUNT(*) c FROM events WHERE type='brief_failed'").get().c).toBe(1);
  });

  it('on failure records a brief_failed event and leaves the session unsummarized for retry', async () => {
    const { spawn } = fakeSpawnFactory({ exitCode: 1, output: '' });
    const briefer = createBriefer({ ctx, config, spawn });
    const uuid = insertSession();
    briefer.enqueue(uuid);
    await briefer.drain();
    expect(ctx.db.prepare("SELECT COUNT(*) c FROM events WHERE type='brief_failed'").get().c).toBe(1);
    const row = ctx.db.prepare('SELECT brief_generated_at FROM sessions WHERE session_uuid = ?').get(uuid);
    expect(row.brief_generated_at).toBeNull();
    // sweep retries it
    const good = fakeSpawnFactory({ output: '## Status\nretry worked\n- Now: x' });
    const briefer2 = createBriefer({ ctx, config, spawn: good.spawn });
    await briefer2.sweep();
    expect(good.calls.length).toBe(1);
  });

  it('force-enqueue briefs a LIVE session, waiving ended/threshold checks', async () => {
    const { spawn, calls } = fakeSpawnFactory({ output: '## Status\nlive brief\n- Now: x' });
    const briefer = createBriefer({ ctx, config: config, spawn });
    const uuid = insertSession({ uuid: 'live-1' });
    ctx.db.prepare("UPDATE sessions SET ended_at = NULL WHERE session_uuid = 'live-1'").run();
    briefer.enqueue(uuid, { force: true });
    await briefer.drain();
    expect(calls.length).toBe(1);
    const fm = matter(readFileSync(ctx.paths.briefFile(task.slug), 'utf8'));
    expect(fm.content).toContain('live brief');
  });

  it('nameTask creates a short-slug task from claude JSON and binds the session', async () => {
    const { spawn } = fakeSpawnFactory({ output: '{"slug":"cache-warm-startup","title":"Warm the cache on worker startup","jira":null}' });
    const briefer = createBriefer({ ctx, config, spawn });
    const uuid = insertSession({ uuid: 'n-1', taskId: null });
    const created = await briefer.nameTask(uuid);
    expect(created.slug).toBe('cache-warm-startup');
    const row = ctx.db.prepare("SELECT task_id FROM sessions WHERE session_uuid = 'n-1'").get();
    expect(row.task_id).toBe(created.id);
  });

  it('nameTask aborts instead of creating a duplicate when the session got bound mid-generation', async () => {
    // Live incident: user typed /task java-image-update while the background
    // namer was running; the namer then created an orphaned duplicate card.
    let bindDuringGeneration;
    const spawn = () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = { write: () => {}, end: () => {
        setImmediate(() => {
          bindDuringGeneration();
          child.stdout.emit('data', '{"slug":"dupe-card","title":"Dupe","jira":null}');
          child.emit('close', 0);
        });
      } };
      return child;
    };
    const briefer = createBriefer({ ctx, config, spawn });
    const uuid = insertSession({ uuid: 'race-1', taskId: null });
    bindDuringGeneration = () =>
      ctx.db.prepare('UPDATE sessions SET task_id = ? WHERE session_uuid = ?').run(task.id, uuid);
    const created = await briefer.nameTask(uuid);
    expect(created).toBeNull();
    expect(ctx.db.prepare("SELECT COUNT(*) c FROM tasks WHERE slug='dupe-card'").get().c).toBe(0);
  });

  it('nameTask falls back to first-words naming when claude output is garbage', async () => {
    const { spawn } = fakeSpawnFactory({ exitCode: 1, output: 'nonsense' });
    const briefer = createBriefer({ ctx, config, spawn });
    const uuid = insertSession({ uuid: 'n-2', taskId: null });
    const created = await briefer.nameTask(uuid);
    expect(created).toBeTruthy();
    expect(created.slug.length).toBeGreaterThan(0);
    const row = ctx.db.prepare("SELECT task_id FROM sessions WHERE session_uuid = 'n-2'").get();
    expect(row.task_id).toBe(created.id);
  });

  it('finalize writes a self-contained closing brief THEN deletes transcripts and stamps sessions', async () => {
    const { spawn, calls } = fakeSpawnFactory({ output: FULL_OUT });
    const briefer = createBriefer({ ctx, config, spawn });
    const uuid = insertSession({ uuid: 'f-1' });
    const { copyFileSync: cpSync } = await import('node:fs');
    const archivedCopy = join(ctx.paths.transcriptsDir(task.slug), 'f-1.jsonl');
    cpSync(fixture, archivedCopy);

    const ok = await briefer.finalize(task.id);
    expect(ok).toBe(true);
    expect(calls[0].stdin).toContain('ARCHIVED');
    const fm = matter(readFileSync(ctx.paths.briefFile(task.slug), 'utf8'));
    expect(fm.content).toContain('## Links');
    const { existsSync, readdirSync } = await import('node:fs');
    expect(readdirSync(ctx.paths.transcriptsDir(task.slug)).length).toBe(0);
    expect(existsSync(archivedCopy)).toBe(false);
    const row = ctx.db.prepare("SELECT brief_generated_at FROM sessions WHERE session_uuid='f-1'").get();
    expect(row.brief_generated_at).toBeGreaterThan(0);
  });

  it('finalize reads EVERY session, since the closing brief replaces deleted transcripts', async () => {
    // Archive deletes transcripts, so material missed here is gone for good.
    // finalize used to distil only the newest-transcript session.
    const { spawn, calls } = fakeSpawnFactory({ output: FULL_OUT });
    const briefer = createBriefer({ ctx, config, spawn });
    insertSession({ uuid: 'tab-1' });
    insertSession({ uuid: 'tab-2' });
    const [one, two] = ctx.db.prepare(
      "SELECT transcript_path FROM sessions WHERE session_uuid IN ('tab-1','tab-2') ORDER BY session_uuid"
    ).all();
    appendUserTurn(one.transcript_path, 'decision made in tab one');
    appendUserTurn(two.transcript_path, 'decision made in tab two');

    expect(await briefer.finalize(task.id)).toBe(true);
    expect(calls.length).toBe(1);
    expect(calls[0].stdin).toContain('decision made in tab one');
    expect(calls[0].stdin).toContain('decision made in tab two');
  });

  it('finalize failure KEEPS transcripts and records brief_failed', async () => {
    const { spawn } = fakeSpawnFactory({ exitCode: 1, output: '' });
    const briefer = createBriefer({ ctx, config, spawn });
    insertSession({ uuid: 'f-2' });
    const { copyFileSync: cpSync } = await import('node:fs');
    const archivedCopy = join(ctx.paths.transcriptsDir(task.slug), 'f-2.jsonl');
    cpSync(fixture, archivedCopy);

    const ok = await briefer.finalize(task.id);
    expect(ok).toBe(false);
    const { existsSync } = await import('node:fs');
    expect(existsSync(archivedCopy)).toBe(true);
    expect(ctx.db.prepare("SELECT COUNT(*) c FROM events WHERE type='brief_failed'").get().c).toBe(1);
  });

  it('finalize with no transcripts anywhere still cleans up without calling claude', async () => {
    const { spawn, calls } = fakeSpawnFactory();
    const briefer = createBriefer({ ctx, config, spawn });
    const ok = await briefer.finalize(task.id);
    expect(ok).toBe(true);
    expect(calls.length).toBe(0);
  });

  it('one user prompt is enough to brief an ended session', async () => {
    // User decision 2026-08-20: agentic sessions do hours of work off one or
    // two prompts — the old 5-turn minimum starved them of briefs.
    const { spawn, calls } = fakeSpawnFactory();
    const briefer = createBriefer({ ctx, config, spawn });
    const uuid = insertSession({ uuid: 'one-prompt' });
    const { writeFileSync } = await import('node:fs');
    const row = ctx.db.prepare("SELECT transcript_path FROM sessions WHERE session_uuid='one-prompt'").get();
    writeFileSync(row.transcript_path, '{"type":"user","message":{"role":"user","content":"do the whole migration"}}\n');
    await briefer.sweep();
    expect(calls.length).toBe(1);
  });

  it('briefs a task worked in two tabs once, folding in both and advancing both watermarks', async () => {
    // Observed live: a task with two sessions produced two
    // briefs 7s apart, the second overwriting the first. The queue must key on
    // the task, and refresh-brief must stop looking at only the newest session.
    const { spawn, calls } = fakeSpawnFactory({ output: '## Status\nmerged from both tabs\n- Now: x' });
    const briefer = createBriefer({ ctx, config, spawn });
    insertSession({ uuid: 'tab-a' });
    insertSession({ uuid: 'tab-b' });
    const [a, b] = ctx.db.prepare(
      "SELECT transcript_path FROM sessions WHERE session_uuid IN ('tab-a','tab-b') ORDER BY session_uuid"
    ).all();
    appendUserTurn(a.transcript_path, 'work from tab A');
    appendUserTurn(b.transcript_path, 'work from tab B');

    await briefer.sweep();

    expect(calls.length).toBe(1); // one pass for the task, not one per session
    expect(calls[0].stdin).toContain('work from tab A');
    expect(calls[0].stdin).toContain('work from tab B');
    const marks = ctx.db.prepare(
      "SELECT briefed_turn_index m FROM sessions WHERE session_uuid IN ('tab-a','tab-b')"
    ).all().map((r) => r.m);
    expect(marks).toEqual([7, 7]); // both advanced past their own fresh turn
  });

  it('a drain with nothing to do does not disable every later brief', async () => {
    // The queue drained with an empty queue used to leave `draining` set to a
    // resolved promise: the async body ran to completion synchronously and its
    // `draining = null` was then overwritten by the outer assignment. Every
    // subsequent enqueue — including a forced ↻ refresh — was silently dropped
    // for the lifetime of the server process. index.js sweeps on boot, so a
    // single uneventful sweep was enough to disable briefing entirely.
    const { spawn, calls } = fakeSpawnFactory();
    const briefer = createBriefer({ ctx, config, spawn });
    await briefer.drain(); // nothing queued
    expect(briefer.pending()).toBe(0);

    briefer.enqueue(insertSession({ uuid: 'after-idle-drain' }), { force: true });
    await briefer.drain();
    expect(calls.length).toBe(1);
  });

  it('re-briefs an ended, already-briefed session once its transcript grows', async () => {
    // Live incident 2026-08-21: ended_at was a one-way latch — the reconciler
    // ghost-closer and SessionEnd(reason:resume) both set it, nothing cleared
    // it, so `ended_at && brief_generated_at` froze every brief permanently.
    const { spawn, calls } = fakeSpawnFactory({ output: '## Status\nafter resume\n- Now: x' });
    const briefer = createBriefer({ ctx, config, spawn });
    const uuid = insertSession({ uuid: 'resumed' });
    const row = ctx.db.prepare("SELECT transcript_path FROM sessions WHERE session_uuid='resumed'").get();
    // Everything currently in the transcript has already been briefed, long ago.
    ctx.db.prepare(`
      UPDATE sessions SET brief_generated_at = ?, briefed_turn_index = ?
      WHERE session_uuid = 'resumed'
    `).run(Date.now() - 60 * 60 * 1000, countTurns(row.transcript_path));
    await briefer.sweep();
    expect(calls.length).toBe(0); // nothing new yet

    appendUserTurn(row.transcript_path, 'now add the cursor endpoint');
    await briefer.sweep();
    expect(calls.length).toBe(1);
    expect(matter(readFileSync(ctx.paths.briefFile(task.slug), 'utf8')).content).toContain('after resume');
  });

  it('sweep skips a session whose transcript gained no turns since the last brief', async () => {
    // Guards the replacement for the ended_at latch: staleness alone must not
    // trigger a re-brief, or every sweep would burn quota re-summarizing
    // identical material.
    const { spawn, calls } = fakeSpawnFactory();
    const briefer = createBriefer({ ctx, config, spawn });
    const uuid = insertSession({ uuid: 'no-new-material' });
    const row = ctx.db.prepare("SELECT transcript_path FROM sessions WHERE session_uuid='no-new-material'").get();
    ctx.db.prepare(`
      UPDATE sessions SET ended_at = NULL, prompt_count = 9, briefed_prompt_count = 0,
        brief_generated_at = ?, briefed_turn_index = ?
      WHERE session_uuid = 'no-new-material'
    `).run(Date.now() - 60 * 60 * 1000, countTurns(row.transcript_path));
    await briefer.sweep();
    expect(calls.length).toBe(0);
  });

  it('a routine refresh rewrites only Status, leaving the stable sections byte-identical', async () => {
    // This is the whole point of the split: About/Decisions/Links are expensive
    // to regenerate and rarely change, so a refresh must not touch them.
    const { spawn, calls } = fakeSpawnFactory({ output: '## Status\nnow at step three\n- Now: wiring' });
    const briefer = createBriefer({ ctx, config, spawn });
    const before = readFileSync(ctx.paths.briefFile(task.slug), 'utf8');
    briefer.enqueue(insertSession({ uuid: 'routine' }));
    await briefer.drain();

    expect(calls.length).toBe(1); // Status pass only — no About pass
    const after = matter(readFileSync(ctx.paths.briefFile(task.slug), 'utf8')).content;
    expect(sectionOf(after, 'About')).toBe(sectionOf(matter(before).content, 'About'));
    expect(sectionOf(after, 'Decisions')).toBe(sectionOf(matter(before).content, 'Decisions'));
    expect(sectionOf(after, 'Links')).toBe(sectionOf(matter(before).content, 'Links'));
    expect(sectionOf(after, 'Status')).toContain('now at step three');
    // and the prompt stayed small: no need to resend what is not changing
    expect(calls[0].stdin).not.toContain('seeded choice');
  });

  it('upgrades an old ## Goal brief by running the About pass before the Status pass', async () => {
    const { spawn, calls } = fakeSpawnFactory({
      outputs: [
        '## About\npaginate search results\n\n## Decisions\n- cursor over offset\n\n## Links\n- PR #12',
        '## Status\nmigrated and current\n- Now: verifying',
      ],
    });
    const briefer = createBriefer({ ctx, config, spawn });
    saveBrief(ctx, task.id, '## Goal\nlegacy shape\n## Next steps\n- something', 'manual');
    briefer.enqueue(insertSession({ uuid: 'legacy' }));
    await briefer.drain();

    expect(calls.length).toBe(2); // About, then Status
    const body = matter(readFileSync(ctx.paths.briefFile(task.slug), 'utf8')).content;
    expect(body.startsWith('## About')).toBe(true);
    expect(body).toContain('paginate search results');
    expect(sectionOf(body, 'Status')).toContain('migrated and current');
    expect(sectionOf(body, 'Links')).toContain('PR #12');
    expect(body).not.toContain('## Goal');
  });

  it('flags dropped turns only when a routine pass skipped new work', async () => {
    // A forced refresh deliberately re-reads from turn zero, so the byte cap
    // dropping old turns is inherent, not news — the brief already carries them.
    // Only an incremental pass losing material is worth recording.
    const { spawn } = fakeSpawnFactory();
    const briefer = createBriefer({ ctx, config: { ...config, tailBudgetBytes: 40 }, spawn });
    const uuid = insertSession({ uuid: 'big' });
    const truncations = () =>
      ctx.db.prepare("SELECT COUNT(*) c FROM events WHERE type='brief_truncated'").get().c;

    briefer.enqueue(uuid, { force: true });
    await briefer.drain();
    expect(truncations()).toBe(0);

    const row = ctx.db.prepare("SELECT transcript_path FROM sessions WHERE session_uuid='big'").get();
    appendUserTurn(row.transcript_path, 'a long new turn that will not fit in the budget at all');
    ctx.db.prepare("UPDATE sessions SET brief_generated_at = ? WHERE session_uuid='big'")
      .run(Date.now() - 60 * 60 * 1000);
    await briefer.sweep();
    expect(truncations()).toBe(1);
  });

  it('an explicit About refresh rewrites the stable sections even though About exists', async () => {
    // Without this there is no way back from a bad About: the routine path skips
    // the About pass whenever the section is present, so a polluted one is stuck.
    const { spawn, calls } = fakeSpawnFactory({
      outputs: [
        '## About\nrewritten scope\n\n## Decisions\n- fresh choice\n\n## Links\n- NEW-1',
        '## Status\nstill going\n- Now: x',
      ],
    });
    const briefer = createBriefer({ ctx, config, spawn });
    insertSession({ uuid: 'about-refresh' });

    briefer.enqueueTask(task.id, { force: true, about: true });
    await briefer.drain();

    expect(calls.length).toBe(2);
    const body = matter(readFileSync(ctx.paths.briefFile(task.slug), 'utf8')).content;
    expect(sectionOf(body, 'About')).toContain('rewritten scope');
    expect(sectionOf(body, 'Decisions')).toContain('fresh choice');
    expect(sectionOf(body, 'Status')).toContain('still going');
  });

  it('an About rewrite leaves the brief in reading order: About, Status, Links, Decisions', async () => {
    // Status is spliced in before the SECOND heading, so the About pass's own
    // section order decides where it lands. Emitting Links before Decisions is
    // what puts Status above Links rather than below Invariants — and the Digest
    // view renders this file verbatim, so the file's order is the tile's order.
    const { spawn } = fakeSpawnFactory({
      outputs: [
        '## About\nscope\n\n## Links\n- PR #1\n\n## Decisions\n- a choice\n\n## Invariants\n- a rule',
        '## Status\n- Now: wiring',
      ],
    });
    const briefer = createBriefer({ ctx, config, spawn });
    insertSession({ uuid: 'ordering' });

    briefer.enqueueTask(task.id, { force: true, about: true });
    await briefer.drain();

    const body = matter(readFileSync(ctx.paths.briefFile(task.slug), 'utf8')).content;
    const at = (name) => body.indexOf(`## ${name}`);
    expect(at('About')).toBeLessThan(at('Status'));
    expect(at('Status')).toBeLessThan(at('Links'));
    expect(at('Links')).toBeLessThan(at('Decisions'));
    expect(at('Decisions')).toBeLessThan(at('Invariants'));
  });

  it('rejects a Status pass that emits a whole brief, keeping the stable sections', async () => {
    // A status pass returning every section has been captured by the transcript;
    // saving it would let it overwrite sections it was never asked to touch.
    const { spawn } = fakeSpawnFactory({ output: '## Status\nx\n\n## Decisions\n- rewritten by mistake' });
    const briefer = createBriefer({ ctx, config, spawn });
    const uuid = insertSession({ uuid: 'runaway' });
    briefer.enqueue(uuid);
    await briefer.drain();

    const body = matter(readFileSync(ctx.paths.briefFile(task.slug), 'utf8')).content;
    expect(body).toContain('seeded choice'); // original Decisions intact
    expect(body).not.toContain('rewritten by mistake');
    expect(ctx.db.prepare("SELECT COUNT(*) c FROM events WHERE type='brief_failed'").get().c).toBe(1);
    const row = ctx.db.prepare('SELECT briefed_turn_index FROM sessions WHERE session_uuid = ?').get(uuid);
    expect(row.briefed_turn_index).toBe(0); // watermark held back for the retry
  });

  it('still skips zero-turn, unbound, and quiet live sessions', async () => {
    const { spawn, calls } = fakeSpawnFactory();
    const briefer = createBriefer({ ctx, config, spawn });
    const uuid = insertSession({ uuid: 'zero-turns' });
    const { writeFileSync } = await import('node:fs');
    const row = ctx.db.prepare("SELECT transcript_path FROM sessions WHERE session_uuid='zero-turns'").get();
    writeFileSync(row.transcript_path, '{"type":"queue-operation"}\n'); // no user turns at all
    insertSession({ uuid: 'unbound', taskId: null });
    ctx.db.prepare("UPDATE sessions SET ended_at = NULL WHERE session_uuid = 'unbound'").run();
    await briefer.sweep();
    expect(calls.length).toBe(0);
  });
});
