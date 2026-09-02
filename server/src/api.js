import { existsSync } from 'node:fs';
import Fastify from 'fastify';
import {
  createTask, updateTask, archiveTask, unarchiveTask, softDelete, restoreTrash,
  getTask, getTaskBySlug, listTasks, saveBrief, getBrief, recordEvent,
} from './taskstore.js';
import { ingestSpool, applySpoolEvent, writeBindings, attachSession, JIRA_KEY } from './spool.js';
import { resolveBinding } from './binding.js';
import { splitBrief, linkifyTickets } from './briefformat.js';
import { slugify } from './paths.js';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const TEN_MINUTES = 10 * 60 * 1000;
const TWO_DAYS = 48 * 60 * 60 * 1000;

export function buildApp({ ctx, config, briefer = null, heartbeatMs = 15_000, staticRoot = null }) {
  const app = Fastify({ logger: false });
  const sseClients = new Set();

  if (staticRoot) {
    app.register(import('@fastify/static'), { root: staticRoot, wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      // SPA fallback: unknown GET paths outside /api serve the app shell.
      if (req.method === 'GET' && !req.url.startsWith('/api/')) return reply.sendFile('index.html');
      reply.code(404).send({ error: 'not found' });
    });
  }

  const allowedOrigins = new Set([
    `http://localhost:${config.port}`,
    `http://127.0.0.1:${config.port}`,
  ]);

  app.addHook('onRequest', (req, reply, done) => {
    if (!LOOPBACK.has(req.socket.remoteAddress)) {
      reply.code(403).send({ error: 'loopback only' });
      return;
    }
    // Origin check shuts the DNS-rebinding/CSRF hole on mutations.
    if (req.method !== 'GET' && req.headers.origin && !allowedOrigins.has(req.headers.origin)) {
      reply.code(403).send({ error: 'bad origin' });
      return;
    }
    done();
  });

  function broadcast() {
    for (const client of sseClients) client.write('event: changed\ndata: {}\n\n');
  }

  function getSession(uuid) {
    return ctx.db.prepare('SELECT * FROM sessions WHERE session_uuid = ?').get(uuid);
  }

  function statusLineFor(session, bindingResult) {
    if (session.task_id != null) {
      const task = getTask(ctx, session.task_id);
      return `mission-control: attached to ${task.slug}`;
    }
    if (bindingResult?.reason?.startsWith('ambiguous')) {
      const n = bindingResult.reason.split(':')[1];
      return `mission-control: ${n} tasks match this repo — run /task <name> to pick one`;
    }
    return 'mission-control: unassigned — run /task <name-or-jira> to bind';
  }

  // ---- hook ingest ----

  app.post('/api/hooks/session-start', (req) => {
    ingestSpool(ctx);
    if (!getSession(req.body.session_id)) applySpoolEvent(ctx, req.body);
    const session = getSession(req.body.session_id);
    let bindingResult = null;
    if (session.task_id == null) {
      bindingResult = resolveBinding(req.body, {
        openTasks: ctx.db.prepare(`
          SELECT t.id, t.repo_path,
                 (SELECT s.git_branch FROM sessions s WHERE s.task_id = t.id ORDER BY s.started_at DESC LIMIT 1) AS last_branch
          FROM tasks t WHERE t.archived = 0 AND t.deleted_at IS NULL
        `).all(),
        recentSessions: [],
      });
    }
    writeBindings(ctx);
    broadcast();
    const brief = session.task_id != null ? getBrief(ctx, session.task_id) : null;
    return { status_line: statusLineFor(session, bindingResult), brief };
  });

  app.post('/api/hooks/prompt', (req) => {
    ingestSpool(ctx); // the spooled copy of this event does the work
    writeBindings(ctx);
    broadcast();
    return { ok: true };
  });

  app.post('/api/hooks/turn', () => {
    ingestSpool(ctx); // the spooled copy of this event does the work
    broadcast(); // liveness changed: this session is demonstrably not ended
    return { ok: true };
  });

  app.post('/api/hooks/session-end', (req) => {
    ingestSpool(ctx);
    const session = getSession(req.body.session_id);
    if (!session || !session.ended_at) applySpoolEvent(ctx, req.body);
    briefer?.enqueue(req.body.session_id);
    writeBindings(ctx);
    broadcast();
    return { ok: true };
  });

  // ---- tasks ----

  app.post('/api/tasks', (req, reply) => {
    const task = createTask(ctx, {
      title: req.body.title,
      jiraKey: req.body.jiraKey ?? null,
      repoPath: req.body.repoPath ?? null,
      status: req.body.status ?? 'explore',
    });
    broadcast();
    reply.code(201);
    return task;
  });

  app.get('/api/tasks', () => listTasks(ctx));

  app.patch('/api/tasks/:id', (req, reply) => {
    const id = Number(req.params.id);
    if (!getTask(ctx, id)) return reply.code(404).send({ error: 'not found' });
    let task;
    if (req.body.archived === true) {
      task = archiveTask(ctx, id);
      briefer?.finalize(id).then(() => broadcast()).catch(() => {});
    } else if (req.body.archived === false) task = unarchiveTask(ctx, id);
    else task = updateTask(ctx, id, req.body);
    broadcast();
    return task;
  });

  app.delete('/api/tasks/:id', (req, reply) => {
    const id = Number(req.params.id);
    if (!getTask(ctx, id)) return reply.code(404).send({ error: 'not found' });
    softDelete(ctx, id);
    broadcast();
    return { ok: true };
  });

  app.post('/api/tasks/:id/restore-trash', (req, reply) => {
    const id = Number(req.params.id);
    if (!getTask(ctx, id)) return reply.code(404).send({ error: 'not found' });
    restoreTrash(ctx, id);
    broadcast();
    return getTask(ctx, id);
  });

  app.post('/api/tasks/:id/brief', (req, reply) => {
    const id = Number(req.params.id);
    if (!getTask(ctx, id)) return reply.code(404).send({ error: 'not found' });
    const body = req.body.body;
    if (typeof body !== 'string' || body.trim().length === 0) {
      return reply.code(400).send({ error: 'body must be non-empty' });
    }
    saveBrief(ctx, id, body, req.body.source ?? 'manual');
    broadcast();
    return { ok: true };
  });

  app.get('/api/tasks/:id/brief', (req, reply) => {
    const id = Number(req.params.id);
    if (!getTask(ctx, id)) return reply.code(404).send({ error: 'not found' });
    const body = getBrief(ctx, id);
    // `sections` is what the detail panel renders; `body` stays for the raw view
    // and for any brief still in a format the splitter finds nothing in.
    // Bare ticket keys become tracker links here rather than in the dashboard,
    // because jiraBase is server config and the resolution has tests.
    const sections = splitBrief(body);
    const base = config.jiraBase;
    if (base) {
      sections.links.items = sections.links.items.map((i) => linkifyTickets(i, base));
      sections.status.fields = sections.status.fields.map(
        (f) => ({ ...f, value: linkifyTickets(f.value, base) }));
    }
    return { body, sections };
  });

  // Per-tile "refresh context": force-regenerate the brief from the task's
  // most recent session that still has a readable transcript.
  app.post('/api/tasks/:id/refresh-brief', (req, reply) => {
    const id = Number(req.params.id);
    if (!getTask(ctx, id)) return reply.code(404).send({ error: 'not found' });
    // Every session with a readable transcript, not just the newest: a task
    // worked in two tabs used to have half its material ignored on refresh.
    const readable = ctx.db.prepare(
      'SELECT session_uuid, transcript_path, archived_transcript_path FROM sessions WHERE task_id = ?'
    ).all(id).filter((s) =>
      (s.transcript_path && existsSync(s.transcript_path))
      || (s.archived_transcript_path && existsSync(s.archived_transcript_path)));
    if (readable.length === 0 || !briefer) return { queued: false, reason: 'no transcript available' };
    // `about: true` also rewrites the stable sections. The routine path skips the
    // About pass whenever the section exists, so this is the only way back from
    // an About that has gone stale or absorbed progress it should not carry.
    const about = req.body?.about === true;
    briefer.enqueueTask(id, { force: true, about });
    return { queued: true, sessions: readable.length, about };
  });

  app.get('/api/tasks/:id/sessions', (req) => ctx.db.prepare(
    'SELECT * FROM sessions WHERE task_id = ? ORDER BY last_activity_at DESC LIMIT 100'
  ).all(Number(req.params.id)));

  // A Status refresh runs every few minutes, so brief_saved is bookkeeping rather
  // than task history. It has to be excluded in SQL, not in the client: LIMIT
  // applies before any filtering, so 30 rows of it would push out everything that
  // actually describes what happened. `all=1` is the "show all" escape hatch.
  app.get('/api/tasks/:id/events', (req) => {
    const where = req.query.all === '1' ? '' : " AND type != 'brief_saved'";
    return ctx.db.prepare(
      `SELECT * FROM events WHERE task_id = ?${where} ORDER BY created_at DESC LIMIT ?`
    ).all(Number(req.params.id), Number(req.query.limit ?? 30));
  });

  // ---- sessions ----

  // Resolve a short human reference against existing tasks: exact slug first,
  // then unique substring across slug/title/jira. Never guess on ambiguity.
  function resolveTaskRef(ref) {
    const exact = getTaskBySlug(ctx, slugify(ref));
    if (exact && exact.deleted_at == null) return { task: exact };
    const needle = ref.toLowerCase();
    const matches = listTasks(ctx).filter((t) => t.deleted_at == null
      && (t.slug.includes(needle) || t.title.toLowerCase().includes(needle)
          || (t.jira_key ?? '').toLowerCase().includes(needle)));
    if (matches.length === 1) return { task: matches[0] };
    if (matches.length > 1) return { candidates: matches.map((t) => t.slug) };
    return {};
  }

  // The /task skill's single fire-and-forget entry point: all mode logic is
  // server-side so the skill costs exactly one fast curl.
  app.post('/api/sessions/:uuid/task', async (req, reply) => {
    const uuid = req.params.uuid;
    ingestSpool(ctx);
    if (!getSession(uuid)) {
      ctx.db.prepare('INSERT INTO sessions (session_uuid, cwd, repo_toplevel, started_at, last_activity_at) VALUES (?, ?, ?, ?, ?)')
        .run(uuid, req.body.cwd ?? null, req.body.repoToplevel || null, Date.now(), Date.now());
    }
    let session = getSession(uuid);
    if (!session.transcript_path && req.body.cwd) {
      // Sessions that predate hook registration have no recorded transcript;
      // Claude's path scheme (cwd with non-alphanumerics dashed) lets us derive it.
      const { existsSync } = await import('node:fs');
      const { homedir } = await import('node:os');
      const derived = `${homedir()}/.claude/projects/${req.body.cwd.replace(/[^a-zA-Z0-9]/g, '-')}/${uuid}.jsonl`;
      if (existsSync(derived)) {
        ctx.db.prepare('UPDATE sessions SET transcript_path = ? WHERE session_uuid = ?').run(derived, uuid);
        session = getSession(uuid);
      }
    }
    const ref = (req.body.ref ?? '').trim();

    if (ref) {
      const resolved = resolveTaskRef(ref);
      if (resolved.candidates) {
        return reply.code(409).send({ error: 'ambiguous', candidates: resolved.candidates });
      }
      let task = resolved.task ?? createTask(ctx, {
        title: ref,
        slug: ref,
        jiraKey: ref.match(JIRA_KEY)?.[0] ?? null,
        repoPath: req.body.repoToplevel || null,
      });
      if (task.archived) task = unarchiveTask(ctx, task.id);
      attachSession(ctx, uuid, task.id, 'explicit', Date.now());
      writeBindings(ctx);
      broadcast();
      return { action: resolved.task ? 'bound' : 'created', task };
    }

    if (session.task_id != null) {
      briefer?.enqueue(uuid, { force: true });
      return { action: 'brief-queued', slug: getTask(ctx, session.task_id).slug };
    }

    if (!session.transcript_path) {
      return { action: 'error', message: 'no transcript known for this session — give a name: /task <name>' };
    }
    briefer?.nameTask(uuid)
      .then((task) => { if (task) broadcast(); })
      .catch(() => {});
    return { action: 'naming' };
  });

  app.post('/api/sessions/:uuid/bind', (req, reply) => {
    const uuid = req.params.uuid;
    let task = null;
    if (req.body.taskId != null) {
      task = getTask(ctx, Number(req.body.taskId));
    } else if (req.body.taskTitle) {
      const resolved = resolveTaskRef(req.body.taskTitle);
      if (resolved.candidates) {
        return reply.code(409).send({ error: 'ambiguous', candidates: resolved.candidates });
      }
      task = resolved.task
        ?? createTask(ctx, {
          title: req.body.taskTitle,
          slug: req.body.taskTitle, // user-typed refs stay short
          jiraKey: req.body.jiraKey ?? null,
          repoPath: req.body.repoToplevel ?? null,
        });
    }
    if (!task) return reply.code(400).send({ error: 'taskId or taskTitle required' });
    if (task.archived) task = unarchiveTask(ctx, task.id);
    if (!getSession(uuid)) {
      // Session unseen (hook missed / server was down): create a stub so binding sticks.
      ctx.db.prepare('INSERT INTO sessions (session_uuid, cwd, started_at, last_activity_at) VALUES (?, ?, ?, ?)')
        .run(uuid, req.body.cwd ?? null, Date.now(), Date.now());
    }
    attachSession(ctx, uuid, task.id, 'explicit', Date.now());
    writeBindings(ctx);
    broadcast();
    return { task };
  });

  // ---- install-time verification: can the launchd-spawned server run claude? ----

  app.post('/api/verify-claude', async () => {
    const { execFile } = await import('node:child_process');
    return new Promise((resolve) => {
      const child = execFile(
        config.claudeBin,
        ['-p', '--no-session-persistence', '--model', 'haiku'],
        { env: { ...process.env, MC_INTERNAL: '1' }, timeout: 110_000 },
        (err, stdout, stderr) => {
          if (!err && /OK/.test(stdout)) resolve({ ok: true });
          else {
            resolve({
              ok: false,
              error: String(err ?? '').slice(0, 300),
              stdout: String(stdout).slice(0, 500),
              stderr: String(stderr).slice(0, 500),
            });
          }
        },
      );
      child.stdin.write('Reply with exactly: OK');
      child.stdin.end();
    });
  });

  // ---- state + SSE ----

  // One-shot catch-up payload: every active task with its full brief,
  // most recently touched first. Powers the DIGEST view and `cmc digest`.
  app.get('/api/digest', () => {
    const tasks = ctx.db.prepare(`
      SELECT t.*,
             (SELECT MAX(s.last_activity_at) FROM sessions s WHERE s.task_id = t.id) AS last_activity_at,
             (SELECT COUNT(*) FROM sessions s WHERE s.task_id = t.id AND s.ended_at IS NULL) AS live_sessions
      FROM tasks t WHERE t.archived = 0 AND t.deleted_at IS NULL
      ORDER BY last_activity_at DESC NULLS LAST, t.updated_at DESC
    `).all();
    return {
      now: Date.now(),
      tasks: tasks.map((t) => ({ ...t, brief: getBrief(ctx, t.id) })),
    };
  });

  app.get('/api/state', () => {
    const now = Date.now();
    const tasks = ctx.db.prepare(`
      SELECT t.*,
             (SELECT MAX(s.last_activity_at) FROM sessions s WHERE s.task_id = t.id) AS last_activity_at,
             (SELECT COUNT(*) FROM sessions s WHERE s.task_id = t.id AND s.ended_at IS NULL) AS live_sessions,
             (SELECT s.session_uuid FROM sessions s WHERE s.task_id = t.id ORDER BY s.last_activity_at DESC LIMIT 1) AS last_session_uuid,
             (SELECT s.transcript_path FROM sessions s WHERE s.task_id = t.id ORDER BY s.last_activity_at DESC LIMIT 1) AS last_transcript_path,
             (SELECT s.cwd FROM sessions s WHERE s.task_id = t.id ORDER BY s.last_activity_at DESC LIMIT 1) AS last_cwd
      FROM tasks t ORDER BY t.updated_at DESC
    `).all();
    const unassigned = ctx.db.prepare(`
      SELECT * FROM sessions
      WHERE task_id IS NULL AND hidden = 0
        AND (last_activity_at - started_at) >= ?
        AND last_activity_at >= ?
      ORDER BY last_activity_at DESC
    `).all(TEN_MINUTES, now - TWO_DAYS);
    // Failures superseded by a later success for the same task are resolved —
    // they stay in the timeline but must not banner.
    const banners = ctx.db.prepare(`
      SELECT e.id, e.type, e.created_at, t.slug FROM events e
      LEFT JOIN tasks t ON t.id = e.task_id
      WHERE e.type IN ('brief_failed', 'claude_unreachable') AND e.created_at >= ?
        AND NOT EXISTS (
          SELECT 1 FROM events s
          WHERE s.task_id = e.task_id AND s.type = 'brief_saved' AND s.created_at > e.created_at
        )
      ORDER BY e.created_at DESC LIMIT 20
    `).all(now - TWO_DAYS);
    return {
      tasks: tasks.filter(t => t.deleted_at == null),
      trash: tasks.filter(t => t.deleted_at != null),
      unassigned, banners, now,
      jiraBase: config.jiraBase,
    };
  });

  app.get('/api/events', (req, reply) => {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    reply.raw.write(': connected\n\n');
    sseClients.add(reply.raw);
    // A named event, not a comment: EventSource ignores comments entirely,
    // so a comment heartbeat could never feed the client's staleness watchdog.
    const heartbeat = setInterval(() => reply.raw.write('event: hb\ndata: {}\n\n'), heartbeatMs);
    req.raw.on('close', () => {
      clearInterval(heartbeat);
      sseClients.delete(reply.raw);
    });
  });

  app.decorate('mcBroadcast', broadcast);
  return app;
}
