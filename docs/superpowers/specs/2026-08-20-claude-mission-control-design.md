# Claude Mission Control — Design Spec

Date: 2026-08-20
Status: implemented (both plans merged); §2/§7 updated post-install for the --bare finding

## 1. Purpose

A local-only system that tracks work driven through Claude Code across ~10 concurrent
terminal tabs, so that any task can be parked for days-to-weeks and resumed with full
context. Core problem: Claude Code deletes session transcripts after `cleanupPeriodDays`
(14 by default), and untracked context (decisions, state, next steps)
dies with closed tabs.

Design principle (from independent review): **disk is the source of truth; the server and
dashboard are views.** Capture and durability must work even if the server is dead. LLM
summarization is a convenience layer, never the integrity layer.

## 2. Verified platform facts (tested empirically 2026-08-20)

These were verified by live experiment, not assumed:

- `SessionStart` hook stdin payload: `session_id`, `transcript_path`, `cwd`,
  `hook_event_name`, `source` (`startup` | `resume` | `clear` observed values used).
  No git branch — hook computes it.
- `SessionEnd` hook exists; payload adds `reason`. It does NOT fire on hard tab-kill —
  never trust it as the only liveness signal.
- **`claude -p` fires SessionStart/SessionEnd hooks** → any headless summarizer we spawn
  re-enters our own hooks. Mitigation is mandatory (sentinel env var, §6.1).
- **SessionStart hook stdout is injected into the session's context** (proven: a hook
  echoed a fact; the session knew it). This is the resume mechanism (§8).
- `claude -p --resume <id>` fires SessionStart with `source: "resume"` and the same
  session_id.
- Hooks in `~/.claude/settings.json` apply globally to all projects.
- `CLAUDE_CODE_SESSION_ID` is exported into the session's shell environment — skills can
  read the current session id directly (verified in a live session).
- **Task-tool subagent sessions do NOT fire SessionStart/SessionEnd hooks** (verified:
  a `-p` run that spawned a subagent produced exactly one event pair). Subagents are
  therefore invisible to capture and cannot be polluted by brief injection — by design,
  they are not tracked.
- `--no-session-persistence` (no transcript write, `-p` only) is used for the
  summarizer. **`--bare` is NOT used: verified post-install (2026-08-20) that bare
  mode disables Keychain OAuth** — a standalone (launchd-spawned) `claude -p --bare`
  is always "Not logged in"; it only appeared to work in testing because nested
  sessions inherit auth from their parent. Recursion protection is therefore the
  `MC_INTERNAL=1` guard alone, which the hook script checks before anything else.

## 3. Architecture

```
Claude Code session (any repo, any tab)
  ├─ SessionStart / SessionEnd hooks (shell script, fire-and-forget)
  │     ├─ 1. append event JSON to local spool file            (always works)
  │     ├─ 2. SessionEnd: cp transcript .jsonl into archive    (always works)
  │     └─ 3. curl POST to server, --max-time 2, exit 0 always (best effort)
  ├─ /task, /task-save skills (in-session, POST to server, file fallback)
  ▼
Fastify server — 127.0.0.1:47613 (Node 20+, launchd KeepAlive agent)
  ├─ ingests spool (on start + on every hook POST) → SQLite index
  ├─ auto-brief engine (spawns claude -p with MC_INTERNAL=1)
  ├─ REST API + SSE stream
  └─ serves built React SPA
  ▼
React 19 + Vite + Tailwind v4 dashboard          cmc CLI (terminal resume)
```

- Port **47613** (unregistered). Server binds `127.0.0.1` only.
- launchd LaunchAgent, `KeepAlive=true`, starts at login. This is a daemon, not a
  scheduled task. No cron. No 4pm timer — the daily-batch concept was reviewed out
  (it loses data across sleep/weekends); briefs generate at SessionEnd (§7).

## 4. Filesystem layout (the durable core)

```
~/claude-tasks/
  <task-slug>/
    BRIEF.md              # current context brief; YAML frontmatter = task metadata
    briefs/               # prior brief versions (timestamped)
    transcripts/          # copied session .jsonl files (immortal, grep-able)
  _unbound/<repo-name>/   # transcript copies for sessions never bound to a task
  _spool/events.jsonl     # hook-written append-only event spool
  .index/mission-control.db   # SQLite; DISPOSABLE — rebuildable from files
```

- `BRIEF.md` frontmatter carries: title, status, archived, deleted_at, jira_key,
  repo_path, created/updated. The server writes frontmatter on every metadata change,
  so **every task is fully self-contained on disk**. `cmc reindex` (and server startup
  reconciliation) rebuilds the DB from files.
- `_unbound` transcripts are pruned by the server after 30 days.
- Task-bound transcripts are kept in full while the task is ACTIVE. **Archiving a task
  replaces them with a summary** (user decision 2026-08-20): a closing brief is generated
  first — self-contained, with every referenced link/ticket/PR under `## Links` — and only
  after it saves successfully are the task's transcript copies deleted (failure keeps
  them; the reconciler retries). Unarchiving restores the task, not the transcripts.

## 5. Data model (SQLite index)

- `tasks`: id, slug, title, status, archived (orthogonal to status),
  status_before_archive, jira_key, repo_path, deleted_at, timestamps.
  Status enum (8): `reading, brainstorm, research, design, plan, development, testing,
  deployed`. Soft delete → trash view → purge after 30 days (cascades sessions/events
  rows; files removed with the task dir).
- `sessions`: session_uuid, task_id (nullable), cwd, repo_toplevel, git_branch,
  transcript_path, archived_transcript_path, started_at, ended_at, last_activity_at,
  brief_generated_at.
- `events`: append-only (status moves, attaches, saves, brief generations) → drawer
  timeline (rendered capped at last N, "show all" paginates).
- No `alive` boolean (SessionEnd is unreliable). Liveness = derived: "last activity Xm
  ago" from hook events + a reconciler that stats transcript mtime.
- SQLite via better-sqlite3, `journal_mode=WAL`, `busy_timeout` set; all writes in
  transactions.

## 6. Capture layer

### 6.1 Hook script (one shell script, both events)

Registered globally in `~/.claude/settings.json` for SessionStart + SessionEnd
(no matcher — `source`/`reason` filtering happens inside the script):

```json
{
  "hooks": {
    "SessionStart": [{"hooks": [{"type": "command", "command": "~/claude-tasks/.bin/mc-hook.sh"}]}],
    "SessionEnd":   [{"hooks": [{"type": "command", "command": "~/claude-tasks/.bin/mc-hook.sh"}]}]
  }
}
```

Hard rules, in order:

1. `[ -n "$MC_INTERNAL" ] && exit 0` — kills the `claude -p` recursion loop (§2).
   This guard is the SOLE recursion defense: `--bare` would skip hooks too but is
   unusable because it disables Keychain OAuth (§2).
2. All stdout/stderr of the network path redirected to /dev/null except the deliberate
   SessionStart context line (§8). A stray curl JSON response on stdout would be
   injected into every session's context.
3. Append the event (stdin JSON + computed `git rev-parse --show-toplevel` +
   `--abbrev-ref HEAD`) to `_spool/events.jsonl`. Disk first, network second.
4. SessionEnd: `cp` the transcript into the archive. Destination: the task dir if the
   session appears in `_spool/bindings.json` (a session→task map the server rewrites on
   every binding change, readable when the server is down), else `_unbound/`.
   Durability never depends on the server.
5. `curl --max-time 2` POST to the server, backgrounded, always `exit 0`. A dead
   dashboard must never slow or break a Claude session.

### 6.2 Session→task binding (precedence order)

1. **Explicit**: `/task <name-or-jira-key>` skill — binds current session, creates the
   task if new. Always wins. Re-binding mid-session is allowed; capture before the
   switch stays with the earlier task.
2. **Inheritance**: `source` = `resume`/`clear`/`compact` → inherit the binding of the
   most recent bound session with the same cwd (resume keeps the same session_id anyway).
   Without this, every `/clear` would orphan the tab.
3. **Auto-attach**: only when EXACTLY ONE non-archived task matches the repo toplevel;
   if several match, branch is used as a tiebreaker; still ambiguous → unassigned.
   Auto-attaches are recorded in `events` and reversible in the UI. Rationale: the user
   runs multiple workstreams in one repo on one branch — a wrong attach poisons briefs,
   which is worse than no attach.
4. **Unassigned**: session lands in the tray (§10) and the injected status line says so.

### 6.3 Skills

- Skills identify the current session via the `CLAUDE_CODE_SESSION_ID` env var (§2).
- `/task <name-or-jira>`: bind/create (POST; on server-down, writes intent to spool).
- `/task-save`: Claude writes/updates BRIEF.md content from live context — goal, current
  state, decisions, next steps, plan-file path, Jira key — and POSTs it (`source=manual`).
  Manual saves are the high-quality path; auto-briefs (§7) are the safety net.

## 7. Auto-brief engine

- Trigger: SessionEnd of a bound session with real activity (≥5 user turns — threshold
  configurable), debounced. Plus a **catch-up sweep** on server start / spool ingest:
  any ended, bound, unsummarized session gets processed. No daily timer exists.
- Mechanism: server spawns
  `claude -p --no-session-persistence --model <configurable, default sonnet>`
  (env `MC_INTERNAL=1`, cwd = neutral dir; `--no-session-persistence` avoids
  littering `~/.claude/projects/` with summarizer transcripts; no `--bare` — see §2,
  it breaks Keychain OAuth). Content is piped via stdin, never argv. Prompt is seeded with the PREVIOUS BRIEF.md +
  linked plan file + extracted conversation text (user/assistant turns parsed from the
  archived JSONL — never raw JSONL tail, which is tool-result noise), size-capped from
  the tail. Output = incremental brief update (`source=auto`), prior version retained
  in `briefs/`.
- Sequential queue (one summarizer at a time; it shares the user's Claude quota).
- Failure (auth, quota, garbage output) → logged per-task, surfaced as a dashboard
  banner AND retried by the next catch-up sweep. Never fatal, never silent.

## 8. Resume (terminal-first; no browser resume)

- **SessionStart injection**: when the hook binds/inherits/auto-attaches a task, the
  server returns the current BRIEF.md; the hook prints it, capped at 8 KB (~2k tokens
  per tab open — negligible), on `source` = `startup`/`resume` only. On `clear` the
  user chose to wipe context, so only the status line is printed. (Plus one status line:
  `mission-control: attached to <task>` / `2 tasks match — run /task` /
  `SERVER DOWN — capture spooling locally`.) Stdout → auto-injected into context.
  Resuming a parked task is therefore just: `cd <repo> && claude`.
- **`cmc` CLI** (named to avoid the `mc`/minio collision; installed as a small shell
  function so it can `cd` the parent shell):
  - `cmc ls` — tasks with status, last activity, Jira key.
  - `cmc resume [query]` — picker (fzf if present, numbered list otherwise) → `cd` to
    the task's repo → if the last session's live transcript still exists on disk
    (checked by `fs.exists`, never date math), offer `claude --resume <id>`; else plain
    `claude` (brief injects via the hook). Reads files/DB directly — works server-down.
- Dashboard drawer shows the brief and session history but has NO resume panel
  (user decision 2026-08-20).

## 9. Server & API

- Fastify. REST: tasks CRUD (+ move/archive/restore/trash), sessions
  (attach/detach), briefs (get/save), hooks ingest, `GET /state` (full snapshot),
  `GET /events` (SSE).
- SSE: 15s comment heartbeat; compression disabled on this route; long timeouts.
  Client contract (§10) is full-state resync, so no Last-Event-ID replay is needed.
- Rejects non-loopback connections; `Origin` checked against `localhost:47613` to shut
  the DNS-rebinding/CSRF hole on mutation routes.
- launchd plist: absolute paths for node and the server entry, explicit PATH
  `EnvironmentVariables`, `claude` binary path resolved at install time into server
  config. Installer verifies a `claude -p` round-trip **from the launchd context**
  (Keychain auth) before declaring install complete. Unreachable claude binary at
  runtime = top-of-dashboard banner. Port-bind retry with backoff (KeepAlive restart
  race). `cmcctl start|stop|status|logs` helper script.

## 10. Dashboard UI

React 19 + Vite + Tailwind v4 (`@tailwindcss/vite`). Dark mode follows
`prefers-color-scheme` (Tailwind v4 default; no toggle). Visual design pass will load
the `frontend-design` skill at build time.

- **Board: 4 meta-columns** — Explore (reading/brainstorm/research), Shape (design/plan),
  Build (development/testing), Done (deployed). The precise 8-stage status is a colored
  badge on the card; clicking the badge cycles/edits the stage within (or across) its
  column. No horizontal scroll at 1440px — hard requirement.
- Drag & drop: **pragmatic-drag-and-drop** (actively maintained; chosen over dormant
  dnd-kit). 8px activation distance so click reliably opens the drawer; interactive
  chips (Jira link, buttons) never start drags. During any drag, a fixed ≥80px overlay
  bar appears with **Archive** and **Trash** drop zones — the archive rail itself is
  never a drop target. SSE-driven state changes are buffered while a drag is active.
- Every drag action has a non-drag equivalent: card context menu ("Move to →", Archive,
  Trash, Restore) and keyboard (`←`/`→` adjacent status, `e` archive, `#` trash).
  Restore returns a task to `status_before_archive` via button — drag-out is a bonus.
- Card: title, Jira chip (deep link), repo/branch, activity dot (static; animates only
  on transition, respects `prefers-reduced-motion`), "last activity Xm", brief freshness.
- Ordering within columns: deterministic — active-session cards first, then
  last-activity desc. No manual ordering.
- Drawer: rendered BRIEF.md, session history, event timeline (capped, paginated),
  editable metadata, archive/trash controls.
- **Unassigned tray**: a header pill ("2 unmatched sessions") opening a popover — not a
  persistent band. Sessions with under 10 minutes of activity never surface; entries leave the view
  after 48h (data retained). Attach = dropdown picker on the session or
  "+ new task from session"; no drag-to-attach.
- Archive rail: collapsible side panel with search/filter.
- **State/live-updates contract**: no optimistic UI (localhost RTT ~ms; server echo is
  the single source of truth). SSE client: watchdog (no message 45s → reconnect); on
  every (re)open, `visibilitychange→visible`, and `online`, refetch `GET /state` and
  replace the store wholesale. A visible "synced Xs ago / DISCONNECTED" indicator —
  a stale board must never look healthy. `BroadcastChannel` dedupe warns on duplicate
  dashboard tabs (HTTP/1.1 6-connection limit).

## 11. Error handling & observability

- Hooks: always exit 0; disk spool means a dead server loses nothing; on recovery the
  server ingests the spool backlog.
- **Transcript reconciler** (server, every 5 min + on start): re-copies the live
  transcript of every tracked session whose file changed since the last copy. Covers
  hard-killed sessions where SessionEnd never fires — the archive copy is at most
  minutes stale instead of lost. SessionEnd `reason` values are treated uniformly
  (any SessionEnd = ended); nothing load-bearing depends on enumerating them.
- Loud failures, quiet success: dashboard banners for claude-binary-unreachable,
  auto-brief failures, spool-ingest errors. Per-session status line (§8) makes a broken
  capture path visible within seconds of opening any tab.
- Trash purge (30 days) cascades DB rows and task directory; enforced with FKs.

## 12. Testing

- Vitest, in-memory SQLite: binding precedence (explicit > inheritance > unambiguous
  auto-attach > tray), spool ingest/replay idempotency, brief versioning,
  archive/trash/restore transitions, reindex-from-files.
- Hook script: bats/shell tests against a stub server, including server-down (spool
  only), MC_INTERNAL short-circuit, and stdout-hygiene (nothing but the intended
  context line reaches stdout).
- Auto-brief: transcript-parser unit tests on real JSONL fixtures; the `claude -p`
  boundary mocked.
- UI: Playwright against the real server — drag/move/archive/restore, drawer open vs
  drag conflict, SSE resync after forced disconnect.

## 13. Out of scope (deliberate)

Live Jira sync (key = deep link only), multi-user/auth beyond loopback+Origin,
time tracking, claude.ai web sessions, manual card ordering, SSE event replay,
browser-based resume. Transcript full-text search UI is out; `rg ~/claude-tasks/`
covers it because transcripts are archived as files.

## 14. Build order (for the implementation plan)

1. Durable core: filesystem layout, hook script + spool + transcript copy, `/task`,
   `/task-save`, binding logic, SQLite index + reindex. (Capture works with no UI.)
2. Server: ingest, REST, SSE, launchd install + `cmcctl`.
3. Auto-brief engine.
4. `cmc` CLI.
5. Dashboard.
