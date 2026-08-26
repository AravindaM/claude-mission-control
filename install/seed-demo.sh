#!/bin/sh
# Seed a running server with demo data for UI work and README screenshots.
# Usage: MC_PORT=47915 MC_DATA_DIR=/tmp/mc-demo sh install/seed-demo.sh
#
# Everything here is invented, and deliberately generic: a demo board should not
# advertise what its author actually works on. Keep it that way — the README
# screenshot is generated from this file, and it is the only thing this project
# ever screenshots.
set -u
PORT="${MC_PORT:-47613}"
DATA="${MC_DATA_DIR:-$HOME/claude-tasks}"
API="http://127.0.0.1:$PORT"
DB="$DATA/.index/mission-control.db"

mk() { # mk <title> <status> <jira> <repo>
  curl -s -X POST "$API/api/tasks" -H 'Content-Type: application/json' \
    -d "{\"title\":\"$1\",\"status\":\"$2\",\"jiraKey\":$3,\"repoPath\":\"$4\"}" | jq -r .id
}

# The tool tracking its own development — this is the task the README screenshots.
T0=$(mk "mission-control" development 'null' /repo/claude-mission-control)
T1=$(mk "Paginate the search results endpoint" testing '"DEMO-114"' /repo/api)
T2=$(mk "Move uploads to object storage" deploy '"DEMO-98"' /repo/api)
T3=$(mk "Spike: offline mode for the mobile client" explore 'null' /repo/mobile)
T4=$(mk "Dark mode for the settings screen" development '"DEMO-121"' /repo/web)
T5=$(mk "Cut cold-start time on the worker" plan '"DEMO-133"' /repo/worker)
T6=$(mk "Reading: consistent hashing paper" explore 'null' /repo/notes)
T7=$(mk "Retry policy for the email sender" plan '"DEMO-140"' /repo/worker)

# Briefs use the current four-section format, so the demo board shows what the
# generator actually produces rather than an older shape.
curl -s -X POST "$API/api/tasks/$T0/brief" -H 'Content-Type: application/json' -d '{
  "body": "## About\nWork spread across a dozen Claude sessions is unrecoverable once the tabs close, and per-session transcripts are eventually cleaned up. This tracks every session through hooks, groups them into tasks, and keeps a brief per task that regenerates itself.\n\n**In scope**\n- Hook capture, spooled to disk before any network call\n- Two-cadence briefs: stable About, frequent Status\n- Board, detail panel, and the `cmc` CLI\n\n**Out of scope**\n- Live issue-tracker sync\n- Any hosted or multi-user mode\n\n**Commands**\n- `npm test && sh hooks/test/hook.test.sh`\n\n## Status\n- Now: writing the README and install instructions\n- Next: generate the screenshot from seeded demo data\n- Branch: main, clean tree\n- PRs: none open\n\n## Decisions\n- **Files are the source of truth. SQLite is a rebuildable index.**\n  Why: a corrupt database should never cost you a brief.\n- **Briefing is keyed per task, not per session.**\n  Why: two tabs on one task would otherwise overwrite each other.\n\n## Invariants\n- The hook always exits 0 and never writes to stdout, except the SessionStart brief.\n- Archiving never deletes transcripts until a closing brief has been written.\n\n## Links\n- [Design spec](docs/superpowers/specs/)\n- [Dashboard](http://127.0.0.1:47613)",
  "source": "auto"}' > /dev/null

curl -s -X POST "$API/api/tasks/$T1/brief" -H 'Content-Type: application/json' -d '{
  "body": "## About\nThe search endpoint returns every match in one response, so a broad query can return 40k rows and time out the client. This adds cursor pagination and caps the page size.\n\n**In scope**\n- Cursor pagination on the search endpoint\n- A hard maximum page size of 200\n\n**Out of scope**\n- Changing the ranking algorithm\n\n## Status\n- Now: load-testing the cursor path against a 2M-row fixture\n- Next: update the two client SDKs to follow the cursor\n- Blockers: needs a staging dataset large enough to be meaningful\n- Branch: api@feature/search-pagination, 3 unpushed\n\nOffset pagination degraded badly past page 50, which is what moved this to cursors.\n\n## Decisions\n- **Cursor pagination, not offset.**\n  Why: offset re-scans the whole result set, and rows shift under the reader.\n\n## Invariants\n- Never return an unbounded result set, whatever the caller asks for.\n\n## Links\n- [DEMO-114](https://example.atlassian.net/browse/DEMO-114)\n- [PR #212](https://github.com/example/api/pull/212)",
  "source": "manual"}' > /dev/null

curl -s -X POST "$API/api/tasks/$T4/brief" -H 'Content-Type: application/json' -d '{
  "body": "## About\nThe settings screen hardcodes light-theme colours, so it is the one screen that ignores the system theme. This moves it onto the shared design tokens.\n\n**In scope**\n- Replace hardcoded colours with theme tokens\n- Follow the system theme, with a manual override\n\n**Out of scope**\n- Redesigning the settings layout\n\n## Status\n- Now: auditing the screen for remaining hardcoded hex values\n- Next: add a visual regression test for both themes\n- Branch: web@feature/dark-settings, clean\n- PRs: #77 draft\n\n## Decisions\n- **Tokens live in CSS custom properties, not in JS.**\n  Why: the theme can then switch without a re-render.\n\n## Links\n- [DEMO-121](https://example.atlassian.net/browse/DEMO-121)",
  "source": "auto"}' > /dev/null

# Archive one, trash one (exercises both rails).
T8=$(mk "Old deploy runbook" deploy 'null' /repo/notes)
curl -s -X PATCH "$API/api/tasks/$T8" -H 'Content-Type: application/json' -d '{"archived":true}' > /dev/null
T9=$(mk "Abandoned spike: custom router" explore 'null' /repo/web)
curl -s -X DELETE "$API/api/tasks/$T9" > /dev/null

# Sessions: live ones on the tool's own task and two others, one ended, one unassigned.
NOW=$(node -e 'console.log(Date.now())')
sqlite3 "$DB" <<EOF
INSERT INTO sessions (session_uuid, task_id, cwd, repo_toplevel, git_branch, started_at, last_activity_at)
VALUES ('cccc3333-0000-0000-0000-000000000001', $T0, '/repo/claude-mission-control', '/repo/claude-mission-control', 'main', $NOW - 5400000, $NOW - 60000);
INSERT INTO sessions (session_uuid, task_id, cwd, repo_toplevel, git_branch, started_at, last_activity_at)
VALUES ('aaaa1111-0000-0000-0000-000000000001', $T1, '/repo/api', '/repo/api', 'feature/search-pagination', $NOW - 3600000, $NOW - 120000);
INSERT INTO sessions (session_uuid, task_id, cwd, repo_toplevel, git_branch, started_at, last_activity_at)
VALUES ('aaaa1111-0000-0000-0000-000000000002', $T4, '/repo/web', '/repo/web', 'feature/dark-settings', $NOW - 7200000, $NOW - 30000);
INSERT INTO sessions (session_uuid, task_id, cwd, repo_toplevel, git_branch, started_at, ended_at, last_activity_at)
VALUES ('aaaa1111-0000-0000-0000-000000000003', $T2, '/repo/api', '/repo/api', 'main', $NOW - 90000000, $NOW - 86400000, $NOW - 86400000);
INSERT INTO sessions (session_uuid, cwd, repo_toplevel, git_branch, started_at, last_activity_at)
VALUES ('bbbb2222-0000-0000-0000-000000000001', '/repo/scratch', '/repo/scratch', 'main', $NOW - 2400000, $NOW - 300000);
EOF

echo "seeded: 8 active tasks, 1 archived, 1 trashed, 5 sessions (3 live, 1 unassigned)"
