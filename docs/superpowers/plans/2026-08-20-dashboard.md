# Claude Mission Control — Plan 2: Dashboard UI

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The React 19 + Tailwind v4 dashboard over the Plan-1 server: 4-meta-column board, drag/menu/keyboard status moves, drawer, unassigned tray, archive rail, trash — verified by Playwright against the real server.

**Architecture:** Vite SPA in `dashboard/`, built to `dashboard/dist`, served statically by the existing Fastify server at `/`. State = one store fed by `GET /api/state`, resynced wholesale on SSE signal/reconnect/visibility (no optimistic UI, no client-side event merging).

**Tech Stack:** React 19, Vite 7, Tailwind v4 (`@tailwindcss/vite`), `@atlaskit/pragmatic-drag-and-drop`, `marked` (brief rendering), `@fontsource/ibm-plex-mono` + `@fontsource/ibm-plex-sans`. UI verification: Playwright MCP against a seeded real server.

**Spec:** `docs/superpowers/specs/2026-08-20-claude-mission-control-design.md` (§10)
**Design tokens:** console-telemetry direction — bg `#101418`, surface `#1A2028`, line `#2A323D`, text `#D7DEE8`/`#8A96A5`, accent `#FFB454`; stage hues: explore `#67E8F9`, shape `#A78BFA`, build `#FBBF24`, done `#4ADE80`. Plex Mono = telemetry text, Plex Sans = prose. Signature element: 8-segment clickable stage strip per card.

## Global Constraints

- No horizontal scroll at 1440×900. Dark mode via `prefers-color-scheme` (Tailwind v4 default `dark:`), no toggle.
- Meta-columns: Explore(reading,brainstorm,research) · Shape(design,plan) · Build(development,testing) · Done(deployed).
- Every drag action has a menu/keyboard path (`←`/`→` adjacent status, `e` archive, `#` trash on focused card).
- SSE client contract: heartbeat watchdog (45s) → recreate; refetch `/api/state` on open/`visibilitychange`/`online`/`changed` event; visible "synced Xs ago / DISCONNECTED" indicator.
- Card ordering: live sessions first, then last-activity desc; SSE-driven re-render buffered while a drag is active.
- No optimistic UI. Mutations POST/PATCH then rely on the refetch.
- Static pulse dots; animation only on transitions; respect `prefers-reduced-motion`.

### Task 1: Scaffold + tokens + static serving
`dashboard/` Vite React app; `@theme` tokens in `src/app.css`; fonts; Fastify `@fastify/static` serving `dashboard/dist` with SPA fallback (GET only, after API routes). Verify: `npm run build` + server serves `/`.

### Task 2: Store + SSE client (`src/store.js`, `src/sse.js`)
Plain reducer store via `useSyncExternalStore`. `connect()` wires EventSource + watchdog + visibility/online listeners; exposes `{state, syncedAt, connected}`. Header shows sync status. Verify: kill server → DISCONNECTED appears; restart → resyncs.

### Task 3: Board + cards (`Board.jsx`, `Column.jsx`, `Card.jsx`, `StageStrip.jsx`)
4 columns from state; card = slug(mono) + title + stage strip + jira chip (deep link from `MC_JIRA_BASE` config default `https://your-org.atlassian.net/browse/`) + repo:branch + activity dot + "Xm ago". StageStrip click = PATCH status. Deterministic sort. Empty-column invitation text.

### Task 4: Moves — drag, menu, keyboard (`dnd.js`, `CardMenu.jsx`)
pragmatic-drag-and-drop: cards draggable, columns drop targets; during drag show fixed bottom overlay bar with ARCHIVE / TRASH zones (≥80px); buffer store updates while dragging. Context menu (Move to → 8 statuses, Archive, Trash). Keyboard on focused card.

### Task 5: Drawer (`Drawer.jsx`)
Click card → right panel: rendered brief (marked), metadata edit (title/jira/repo/status), sessions list (uuid, activity, ended), event timeline (last 30 + show all), archive/trash buttons, `cmc resume <slug>` hint line. Esc closes.

### Task 6: Tray, archive rail, trash, banners
Unassigned pill in header → popover list (attach-to-task picker, "+ new task from session" using session cwd as repoPath). Archive rail: collapsible right rail w/ search, Restore button (returns to `status_before_archive`). Trash view behind a header link: restore / purge-info. Banners (brief_failed, claude_unreachable) as header strip.

### Task 7: Playwright verification (real server, seeded data)
Seed script `install/seed-demo.sh` (tasks across stages, sessions, briefs). Playwright checks: board renders 4 columns + seeded cards; stage-strip click moves status; drag card between columns; archive via keyboard `e` + restore from rail; trash + restore; drawer opens (click) with rendered brief; tray attach flow; SSE: server restart → board resyncs; 1440×900 no horizontal scroll; light + dark screenshots reviewed for design quality.
