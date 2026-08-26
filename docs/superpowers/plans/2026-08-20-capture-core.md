# Claude Mission Control — Plan 1: Capture Core, Server, Auto-Brief, CLI

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Durable, file-first capture of Claude Code sessions bound to tasks, with a local Fastify server (index + API + SSE), SessionEnd auto-briefs, and terminal resume — everything except the dashboard UI (Plan 2).

**Architecture:** Hooks write to disk first (spool + transcript copies under `~/claude-tasks/`), the server ingests the spool into a disposable SQLite index and exposes REST + SSE on `127.0.0.1:47613`. Briefs are markdown files with YAML frontmatter as the metadata source of truth; the DB is rebuildable from files. An auto-brief engine spawns `claude -p --bare --no-session-persistence` at SessionEnd.

**Tech Stack:** Node 20+ (dev machine has v24), ESM JavaScript (no TS build), Fastify 5, better-sqlite3, gray-matter (frontmatter), Vitest. Hook + CLI are POSIX shell.

**Spec:** `docs/superpowers/specs/2026-08-20-claude-mission-control-design.md`

## Global Constraints

- Server binds `127.0.0.1` only, port **47613**; mutation routes reject non-loopback and bad `Origin`.
- Hook script: ALWAYS `exit 0`; network calls `--max-time 2` backgrounded; nothing reaches stdout except the intentional context injection (SessionStart only).
- `MC_INTERNAL=1` env set ⇒ hook exits immediately (recursion guard; summarizer also uses `--bare`).
- Data root: `~/claude-tasks/` (overridable via `MC_DATA_DIR` for tests). DB at `.index/mission-control.db`, `journal_mode=WAL`, `busy_timeout=5000`, all multi-write ops in transactions.
- Every task dir self-contained: metadata lives in `BRIEF.md` frontmatter; DB rebuildable via reindex.
- Status enum (8): `reading, brainstorm, research, design, plan, development, testing, deployed`. Archived + deleted_at are orthogonal to status.
- Binding precedence: explicit `/task` > inheritance (`source` = `resume`/`clear`/`compact`, same cwd) > auto-attach (exactly ONE match by repo toplevel, branch tiebreaker) > unassigned.
- Brief injection: `source` `startup`/`resume` only, 8 KB cap; `clear` gets status line only.
- claude binary path is resolved at install time into config, never assumed on PATH (launchd).

## File Structure

```
claude-mission-control/
  package.json                    # ESM, scripts: test, start
  server/src/config.js            # data dir, port, claude binary path, thresholds
  server/src/paths.js             # all path construction + slugify + ensure dirs
  server/src/db.js                # schema + connection (better-sqlite3)
  server/src/taskstore.js         # BRIEF.md frontmatter read/write, task CRUD on disk+db, reindex
  server/src/spool.js             # spool read/ingest (idempotent), bindings.json writer
  server/src/binding.js           # binding resolution (pure logic)
  server/src/transcript.js        # JSONL parser → user/assistant text; size-capped tail
  server/src/briefer.js           # auto-brief queue + claude -p spawn + failure records
  server/src/reconciler.js        # transcript re-copy sweep, unbound prune, catch-up briefs
  server/src/api.js               # Fastify routes (hooks, tasks, sessions, state, SSE)
  server/src/index.js             # entry: config → db → ingest → sweeps → listen
  server/test/*.test.js           # Vitest, tmpdir data root, in-memory-ish sqlite (file in tmpdir)
  server/test/fixtures/transcript.jsonl
  hooks/mc-hook.sh                # the ONE hook script (SessionStart + SessionEnd)
  hooks/test/hook.test.sh         # shell test harness w/ stub server (node one-liner)
  skills/task/SKILL.md            # /task
  skills/task-save/SKILL.md       # /task-save
  cli/cmc.sh                      # shell function file (sourced from .zshrc)
  install/install.sh              # resolve paths, write config, register hooks, launchd, skills, cmc
  install/cmcctl                  # start|stop|status|logs
  install/mission-control.plist.tmpl
```

---

### Task 1: Scaffolding + config + paths

**Files:** Create `package.json`, `server/src/config.js`, `server/src/paths.js`, `server/test/paths.test.js`, `.gitignore`

**Interfaces (Produces):**
- `config`: `{ dataDir, port:47613, claudeBin, briefModel:'sonnet', minTurnsForBrief:5, injectCapBytes:8192 }` — reads `~/claude-tasks/.index/config.json` if present, env `MC_DATA_DIR`/`MC_PORT` override.
- `paths.slugify(title) → 'demo-114-search-pagination'`; `paths.taskDir(slug)`, `paths.briefFile(slug)`, `paths.briefsDir(slug)`, `paths.transcriptsDir(slug)`, `paths.unboundDir(repoName)`, `paths.spoolFile()`, `paths.bindingsFile()`, `paths.dbFile()`; `paths.ensureTaskDirs(slug)`.

- [ ] Step 1: `npm init` equivalent package.json (`"type":"module"`, vitest devDep, fastify/better-sqlite3/gray-matter deps), `npm install`.
- [ ] Step 2: Failing test: slugify ("DEMO-114: Search pagination!" → "demo-114-search-pagination"; collision-safe: slugify never returns empty; taskDir under MC_DATA_DIR tmpdir; ensureTaskDirs creates BRIEF-less skeleton).
- [ ] Step 3: Implement config.js + paths.js minimal. Run tests green.
- [ ] Step 4: Commit `feat: scaffolding, config, path model`.

### Task 2: SQLite schema + db module

**Files:** Create `server/src/db.js`, `server/test/db.test.js`

**Interfaces (Produces):** `openDb(file) → Database` with schema applied idempotently (`CREATE TABLE IF NOT EXISTS`): `tasks(id INTEGER PK, slug UNIQUE, title, status, archived INT DEFAULT 0, status_before_archive, jira_key, repo_path, deleted_at, created_at, updated_at)`; `sessions(session_uuid PK, task_id NULL REFERENCES tasks(id) ON DELETE CASCADE, cwd, repo_toplevel, git_branch, transcript_path, archived_transcript_path, started_at, ended_at, last_activity_at, brief_generated_at, hidden INT DEFAULT 0)`; `events(id PK, task_id NULL, session_uuid NULL, type, detail JSON, created_at)`; `meta(key PK, value)` (spool offset lives here). PRAGMAs: WAL, busy_timeout, foreign_keys ON.

- [ ] Step 1: Failing test: open twice idempotent; FK cascade deletes sessions/events when task row deleted; WAL pragma active.
- [ ] Step 2: Implement. Green. Commit `feat: sqlite schema`.

### Task 3: taskstore — frontmatter files + CRUD + reindex

**Files:** Create `server/src/taskstore.js`, `server/test/taskstore.test.js`

**Interfaces (Produces):**
- `createTask(db, {title, jiraKey?, repoPath?, status='reading'}) → task` — writes `BRIEF.md` (frontmatter: slug,title,status,archived,jira_key,repo_path,created,updated; body: `# <title>\n\n_No brief yet._`), inserts DB row, ensures dirs.
- `updateTask(db, id, patch)` — DB + frontmatter rewrite in one transaction; guards: `status` must be in enum; archiving sets `status_before_archive`; restore uses it.
- `saveBrief(db, taskId, markdownBody, source)` — versions old body to `briefs/<iso>.md`, rewrites BRIEF.md body, records event `brief_saved`, sets `updated`.
- `softDelete/restore/purgeExpired(db, now)` — purge removes rows AND task dir when `deleted_at` older than 30 days.
- `reindex(db, dataDir)` — wipes tasks table, rebuilds from every `*/BRIEF.md` frontmatter (sessions/events survive only if task slug still exists; orphans get task_id NULL).

- [ ] Step 1: Failing tests: create→frontmatter on disk matches DB row; updateTask invalid status throws; archive stores status_before_archive, restore returns to it; saveBrief versions previous body; purge removes dir; **reindex round-trip: create 3 tasks, wipe DB file, reindex, rows identical**.
- [ ] Step 2: Implement with gray-matter. Green. Commit `feat: taskstore with file-first metadata and reindex`.

### Task 4: binding resolution (pure) + spool ingest

**Files:** Create `server/src/binding.js`, `server/src/spool.js`, tests for both.

**Interfaces (Produces):**
- `resolveBinding(event, {openTasks, recentSessions}) → {taskId|null, mode:'inherit'|'auto'|'none', reason}` — pure function. `event`: `{session_id, source, cwd, repo_toplevel, git_branch}`. Rules: source in (resume,clear,compact) → most recent bound session with same cwd; else candidates = non-archived tasks where `repo_path === repo_toplevel`; 1 → auto; >1 → filter by branch match on that task's last-known branch; still ≠1 → none+reason `'ambiguous:N'`.
- `ingestSpool(db, deps) → {processed}` — reads `_spool/events.jsonl` from byte offset stored in `meta('spool_offset')`, applies each event (session upsert on start; ended_at + archived transcript path on end; task-bind intents from skills), idempotent on replay (re-running from 0 changes nothing), advances offset.
- `writeBindings(db, dataDir)` — dumps `{session_uuid: task_slug}` for live sessions to `_spool/bindings.json` (what the hook reads server-down).

- [ ] Step 1: Failing tests for resolveBinding: explicit not handled here (skill POST path); inherit-on-clear same cwd; single-repo auto; two-tasks-same-repo → none/ambiguous; branch tiebreaker picks right task.
- [ ] Step 2: Failing tests for ingestSpool: start then end event → session row complete; replay idempotent; offset persists; malformed line skipped + counted, never throws.
- [ ] Step 3: Implement both. Green. Commit `feat: binding resolution + idempotent spool ingest`.

### Task 5: hook script

**Files:** Create `hooks/mc-hook.sh`, `hooks/test/hook.test.sh`

**Interfaces (Consumes):** server routes `POST /api/hooks/session-start` (responds `{status_line, brief|null}`) and `POST /api/hooks/session-end` (Task 7). **Produces:** spool lines `{ts, event, session_id, source|reason, cwd, repo_toplevel, git_branch, transcript_path}`; transcript copies.

Script logic (single file, dispatches on `hook_event_name` from stdin JSON via `jq`):

```sh
#!/bin/sh
[ -n "$MC_INTERNAL" ] && exit 0
IN=$(cat); DATA="${MC_DATA_DIR:-$HOME/claude-tasks}"
EV=$(printf '%s' "$IN" | jq -r .hook_event_name)
SID=$(printf '%s' "$IN" | jq -r .session_id); CWD=$(printf '%s' "$IN" | jq -r .cwd)
TOP=$(cd "$CWD" 2>/dev/null && git rev-parse --show-toplevel 2>/dev/null)
BR=$(cd "$CWD" 2>/dev/null && git rev-parse --abbrev-ref HEAD 2>/dev/null)
LINE=$(printf '%s' "$IN" | jq -c --arg top "$TOP" --arg br "$BR" --arg ts "$(date +%s)" '. + {repo_toplevel:$top, git_branch:$br, ts:($ts|tonumber)}')
mkdir -p "$DATA/_spool"; printf '%s\n' "$LINE" >> "$DATA/_spool/events.jsonl"
if [ "$EV" = "SessionEnd" ]; then
  TP=$(printf '%s' "$IN" | jq -r .transcript_path)
  SLUG=$(jq -r --arg s "$SID" '.[$s] // empty' "$DATA/_spool/bindings.json" 2>/dev/null)
  if [ -n "$SLUG" ]; then DEST="$DATA/$SLUG/transcripts"; else DEST="$DATA/_unbound/$(basename "${TOP:-$CWD}")"; fi
  mkdir -p "$DEST"; cp -f "$TP" "$DEST/" 2>/dev/null
  curl -s --max-time 2 -X POST -H 'Content-Type: application/json' -d "$LINE" \
    "http://127.0.0.1:${MC_PORT:-47613}/api/hooks/session-end" >/dev/null 2>&1 &
  exit 0
fi
# SessionStart: the ONLY path allowed to print to stdout (context injection)
RESP=$(curl -s --max-time 2 -X POST -H 'Content-Type: application/json' -d "$LINE" \
  "http://127.0.0.1:${MC_PORT:-47613}/api/hooks/session-start" 2>/dev/null)
if [ -n "$RESP" ]; then
  printf '%s' "$RESP" | jq -r '.status_line // empty'
  SRC=$(printf '%s' "$IN" | jq -r .source)
  case "$SRC" in startup|resume) printf '%s' "$RESP" | jq -r '.brief // empty' | head -c 8192 ;; esac
else
  echo "mission-control: SERVER DOWN — capture spooling locally"
fi
exit 0
```

- [ ] Step 1: Write shell test harness: stub server via `node -e` (records requests, canned responses); cases: (a) MC_INTERNAL set → no spool line, no output; (b) server down → spool line written, stdout = SERVER DOWN line only, exit 0, completes <3s; (c) SessionEnd bound (bindings.json) → transcript copied into task dir; (d) SessionEnd unbound → `_unbound/<repo>/`; (e) SessionStart source=clear → status line but NO brief; (f) brief >8KB truncated. Run: FAIL (script absent).
- [ ] Step 2: Implement script (above). Tests green. `chmod +x`.
- [ ] Step 3: Commit `feat: hook script — spool-first capture, transcript archive, context injection`.

### Task 6: transcript parser

**Files:** Create `server/src/transcript.js`, fixture `server/test/fixtures/transcript.jsonl` (copy a small real one from `~/.claude/projects/`, scrubbed), `server/test/transcript.test.js`

**Interfaces (Produces):** `extractConversation(jsonlPath, maxBytes=200_000) → string` — user + assistant TEXT turns only (skip tool_use/tool_result/thinking), formatted `USER: …\nASSISTANT: …`, taken from the TAIL when over cap; `countUserTurns(jsonlPath) → number` (drives the ≥5-turns brief threshold).

- [ ] Step 1: Failing tests against fixture: no `tool_result` content in output; turn count correct; cap trims from the head.
- [ ] Step 2: Implement (line-by-line JSON parse, tolerate malformed lines). Green. Commit `feat: transcript text extraction`.

### Task 7: Fastify API + SSE

**Files:** Create `server/src/api.js`, `server/src/index.js`, `server/test/api.test.js`

**Interfaces (Produces — Plan 2's dashboard and the skills consume these):**
- `POST /api/hooks/session-start` → runs ingest + `resolveBinding`, upserts session, returns `{status_line, brief}` (brief body only when bound and source startup/resume).
- `POST /api/hooks/session-end` → ingest; enqueues auto-brief when eligible (Task 8).
- `POST /api/tasks` `{title, jiraKey?, repoPath?}`; `GET /api/tasks`; `PATCH /api/tasks/:id` (status/title/jira/archive/restore); `DELETE /api/tasks/:id` (soft); `POST /api/tasks/:id/restore-trash`.
- `POST /api/sessions/:uuid/bind` `{taskId}` (also used by `/task` skill with `taskTitle` to create+bind); `POST /api/tasks/:id/brief` `{body, source}` (used by `/task-save`).
- `GET /api/state` → full snapshot `{tasks:[…with derived lastActivity…], unassigned:[…], banners:[…]}`.
- `GET /api/events` → SSE; heartbeat comment every 15s; every mutation broadcasts `{type:'changed'}` (clients refetch /state — spec's dumb-resync contract); compression disabled on this route.
- Guards: `onRequest` hook rejects non-loopback sockets (403) and, on non-GET, `Origin` headers not in (`http://localhost:47613`, `http://127.0.0.1:47613`, absent).

- [ ] Step 1: Failing tests (fastify `inject` + one real-listen test for loopback guard): session-start unassigned → status_line mentions `/task`; bound → brief returned; bad Origin on PATCH → 403; task lifecycle create→move→archive→restore→trash→restore; `/state` shape; SSE route emits heartbeat comment (real listen, read a chunk).
- [ ] Step 2: Implement api.js + index.js (boot: config→db→reindex-if-empty→ingest→writeBindings→listen; reconciler wiring lands in Task 9). Green. Commit `feat: server API + SSE`.

### Task 8: auto-brief engine

**Files:** Create `server/src/briefer.js`, `server/test/briefer.test.js`

**Interfaces (Produces):** `createBriefer({config, db, spawn=child_process.spawn}) → {enqueue(sessionUuid), sweep(), pending()}` — sequential queue. Eligibility: session bound + ended + `countUserTurns ≥ config.minTurnsForBrief` + `brief_generated_at IS NULL`. Invocation: `spawn(config.claudeBin, ['-p','--bare','--no-session-persistence','--model',config.briefModel], {env:{...process.env, MC_INTERNAL:'1'}, cwd: os.tmpdir()})`, prompt piped via **stdin**: previous brief + plan-file content (if frontmatter names one) + `extractConversation(...)` + fixed instruction ("update this brief incrementally; keep sections Goal/State/Decisions/Next steps; output ONLY the markdown"). Success → `saveBrief(source='auto')`, stamp `brief_generated_at`. Failure/garbage (empty or >100KB output) → event `brief_failed` + banner row; retried by next `sweep()`. `sweep()` = catch-up over all eligible sessions.

- [ ] Step 1: Failing tests with fake spawn: eligible session → spawn called with exact argv/env/stdin containing previous brief text; success writes versioned brief; failure records banner + leaves session unsummarized; sweep retries it; sub-threshold session never enqueued; queue is strictly sequential.
- [ ] Step 2: Implement. Green. Commit `feat: SessionEnd auto-brief engine with catch-up sweep`.

### Task 9: reconciler

**Files:** Create `server/src/reconciler.js`, `server/test/reconciler.test.js`; modify `server/src/index.js` (wire 5-min interval + on-start run).

**Interfaces (Produces):** `reconcile({db, config}) → {copied, pruned, liveness}` — (1) for every session with a `transcript_path` that exists and mtime > last copy, re-copy to its archive home (covers hard-kills; move `_unbound` copy into task dir if binding appeared later); (2) prune `_unbound` files older than 30 days; (3) set `last_activity_at` from transcript mtime; sessions with ended_at NULL and mtime older than 30 min get ended_at = mtime (the honest-liveness rule). Then `briefer.sweep()` and `writeBindings()`.

- [ ] Step 1: Failing tests: stale live transcript re-copied; late binding relocates archive; 31-day unbound file pruned; ghost session closed by mtime.
- [ ] Step 2: Implement + wire interval in index.js. Green. Commit `feat: reconciler sweep`.

### Task 10: skills (/task, /task-save)

**Files:** Create `skills/task/SKILL.md`, `skills/task-save/SKILL.md`

Content (task): frontmatter `name: task`, `description: Bind this Claude session to a mission-control task (creates it if new). Use when the user runs /task <name-or-jira>.`; body instructs Claude to: read `$CLAUDE_CODE_SESSION_ID`; `curl -s -X POST http://127.0.0.1:47613/api/sessions/$CLAUDE_CODE_SESSION_ID/bind -H 'Content-Type: application/json' -d '{"taskTitle":"<arg>","cwd":"<pwd>","jiraKey":"<arg if JIRA-shaped>"}'`; report the returned task slug/status one-line; if curl fails, append a bind-intent line to `~/claude-tasks/_spool/events.jsonl` instead and say capture is offline.
Content (task-save): compose the brief from live context under fixed headings (Goal / Current state / Decisions / Next steps / Links: plan file, Jira) — derived from the conversation, ≤4KB; POST to `/api/tasks/<bound-task>/brief` (server resolves bound task from session id in payload); confirm with one line. No test framework — verification is Task 11's smoke test.

- [ ] Step 1: Write both SKILL.md files. Commit `feat: /task and /task-save skills`.

### Task 11: cmc CLI + install + launchd + E2E smoke

**Files:** Create `cli/cmc.sh`, `install/install.sh`, `install/cmcctl`, `install/mission-control.plist.tmpl`

- `cli/cmc.sh`: shell functions (`cmc ls` — curl `/api/state` + jq table, file-fallback to frontmatter grep when server down; `cmc resume [query]` — pick task (fzf if present, else numbered `select`), `cd` to repo_path, then `claude --resume <last-session>` if that transcript file exists else `claude`).
- `install/install.sh` (idempotent): resolve `claude` + `node` absolute paths → write `.index/config.json`; merge hook registration into `~/.claude/settings.json` (via `jq`, backing up first — file is USER-OWNED, print the diff and require confirm); symlink skills into `~/.claude/skills/`; render plist from template with absolute paths; `launchctl bootstrap`; **verify from launchd context**: wait for `/api/state` 200, then trigger one `claude -p --bare` round-trip via a test endpoint and report PASS/FAIL loudly.
- `install/cmcctl`: start|stop|status|logs wrapping launchctl + log tail.

- [ ] Step 1: Write cmc.sh + cmcctl + plist template + install.sh.
- [ ] Step 2: E2E smoke (manual, scripted in `install/smoke.sh`): with server running under `MC_DATA_DIR=/tmp/mc-smoke`, run a real `claude -p "reply ok"` in a scratch repo with hooks pointed at the smoke config → assert spool line, session row via `/api/state`, transcript copy exists; create task via API, re-run session, assert auto-attach + brief injection line in output.
- [ ] Step 3: Commit `feat: cmc CLI, installer, launchd agent, smoke test`.

---

## Self-review notes

- Spec coverage: §4 files→T1/T3; §5 schema→T2; §6.1 hook→T5; §6.2 binding→T4; §6.3 skills→T10; §7 briefer→T8; §8 resume→T5(injection)+T11(cmc); §9 API/SSE/guards/launchd→T7+T11; §11 reconciler/banners→T9/T7; §12 testing→per-task. Dashboard (§10) intentionally Plan 2.
- Type consistency: `resolveBinding` consumed in T7 as produced in T4; briefer consumed in T7/T9 via enqueue/sweep; frontmatter fields identical in T3 and reindex.
- No placeholders remain; hook script and route list are concrete.
