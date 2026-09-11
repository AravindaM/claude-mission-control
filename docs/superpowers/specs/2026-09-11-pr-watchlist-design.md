# PR Watchlist — Live Status You Do Not Maintain

Amends §4 (Filesystem layout), §5 (Data model), §9 (Server & API) and §10 (Dashboard UI)
of `2026-08-20-claude-mission-control-design.md`. Everything not restated here still holds.

## 1. Purpose

Pull requests already appear in this product, as **prose a model wrote**. The Status pass
is asked for `- PRs: #12 green, #14 draft` (`briefer.js:146`) and the drawer renders it as
a row (`briefformat.js:75`). That line is regenerated every few minutes from a transcript,
has no state machine behind it, and is wrong the moment something merges without being
mentioned out loud.

It also only ever covers PRs attached to a task you are working on. The PRs that actually
block other people — the ones waiting on *your* review — appear nowhere at all, because
you have no task for reviewing someone else's branch.

This adds a watchlist: PRs you add by hand, whose status is read from `gh` and refreshed
hourly, in a view that answers two questions — what am I waiting on, and what is waiting
on me.

## 2. What this is

A **watchlist with live status**, not a kanban.

You own exactly three things: which PRs are tracked, their order, and their optional task
link. Everything else — title, author, state, review decision, draft status — is a cache
of what `gh` last reported, and is never edited by hand.

This is the inverse of the task board, and the distinction is load-bearing: on the board
you assert a task's stage, because nothing else can know it. Here GitHub already knows,
so asserting it by hand would only create a second version of the truth that drifts.

## 3. What this is not

Not a GitHub sync. Nothing is discovered automatically; a PR is tracked because you pasted
its URL. "Every PR in the org" is explicitly not the target — the value is that the list
is short because you curated it.

Not a review tool. No diffs, no comments, no approvals from inside the dashboard. The card
links out to GitHub and that is the end of its job.

Not a task. PRs do not get briefs, transcripts, stages, or archival.

## 4. Data model

```sql
CREATE TABLE prs (
  id INTEGER PRIMARY KEY,
  url TEXT NOT NULL UNIQUE,
  repo TEXT,
  number INTEGER,
  position INTEGER NOT NULL,
  task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  -- everything below is a gh cache, never user-edited
  title TEXT,
  author_login TEXT,
  author_is_me INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'open',   -- open | merged | closed
  review_decision TEXT,
  is_draft INTEGER NOT NULL DEFAULT 0,
  resolved_at INTEGER,
  gh_fetched_at INTEGER,
  gh_error TEXT,
  added_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

`url` is identity and carries the UNIQUE constraint. Adding a URL already tracked refreshes
that record rather than inserting a duplicate — the natural thing to do when you cannot
remember whether you already added it.

`repo` and `number` are parsed from the URL at insert, **before** `gh` is consulted, so a
card always has something to render even when the lookup fails.

`task_id` is `ON DELETE SET NULL`, not `CASCADE`. Deleting a task must not delete the
record of a PR that shipped it.

`resolved_at` is `mergedAt` for a merged PR, and the time the sweep first observed
`CLOSED` for an abandoned one. It is not called `merged_at` because `gh` returns
`mergedAt: null` for closed-not-merged PRs, and both kinds share the MERGED column — so
ordering that column by `merged_at` would have stacked every abandoned PR at the bottom
under a null, in arbitrary order.

## 5. Ordering

`position` is a single global integer. Each column renders its own members sorted by it.

Positions are globally unique — an invariant maintained by construction (§9), not a
UNIQUE constraint, since transiently equal values during a permutation are harmless. They
are only ever compared **within** a column, which is what
lets ordering coexist with a state that changes underneath you: when `gh` moves a PR from
MINE to MERGED, no renumbering is needed, because the numbers were never required to be
dense per column. A new PR takes `max(position) + 1` and lands at the bottom of whichever
column it belongs to.

Reordering within a column permutes only the positions already held by that column's
members, so it cannot disturb another column.

This is deliberately weaker than the priority stack's `1..n` invariant. There, membership
changes only when the user acts, so density is cheap to maintain. Here membership changes
on an hourly sweep the user never sees, and maintaining density would mean renumbering
rows as a side effect of a background refresh — a write amplification with no reader that
benefits.

## 6. Status comes from `gh`, never from a drag

Cards are not draggable between columns. The column is a projection:

| Column | Predicate |
|---|---|
| MINE | `state = 'open' AND author_is_me` |
| TO REVIEW | `state = 'open' AND NOT author_is_me` |
| MERGED | `state IN ('merged','closed')`, newest 10 by `resolved_at` |

`gh` reports `CLOSED` for abandoned PRs. Those render in MERGED, struck through and
labelled `closed` — the distinction between landed and abandoned is worth showing, and is
not worth a fourth column for something rare.

MERGED is capped at 10. Without it the column grows for the life of the install, and
nothing the user does removes a card, because nothing is dragged. Older records are
retained, just not rendered. `prMergedShown` in config.

## 7. The `gh` lookup

Server-side, spawned exactly as `briefer.js` spawns `claude`:

```
gh pr view <url> --json number,title,author,state,isDraft,reviewDecision,mergedAt
gh api user --jq .login
```

The viewer's login is fetched once per process and cached; `author_is_me` is
`author.login === viewerLogin`. Nothing in this app previously knew who you are on GitHub,
and asking `gh` beats a config field the user has to keep correct.

**Failure is non-fatal and never blocks the write.** `gh` missing, unauthenticated, rate
limited, offline, or the repo private: the record is still created from the URL alone,
`gh_error` holds the reason, and the card renders `gh lookup failed — ↻` with whatever the
URL gave us. A tracker that refuses to accept a PR because a subprocess failed is useless
in precisely the situation where you are least able to check GitHub yourself.

## 8. Refresh

Hourly, driven by the existing 5-minute reconciler sweep plus a staleness check — the same
shape as the briefer's `staleMinutes`, and for the same reason: a fixed timer that fires
independently of the sweep is a second scheduler to reason about.

Eligibility: `state != 'merged'` and `gh_fetched_at` older than `prRefreshHours`.

**Merged is terminal and never re-fetched.** GitHub cannot unmerge, so the work is bounded
by the count of PRs you are actually waiting on, not by everything you have ever tracked.
`closed` *is* re-fetched, because a closed PR can be reopened.

Serial, never parallel: N concurrent `gh` subprocesses is rude to the machine and to the
API, and this is a background task with no deadline.

A per-card `↻` runs the same lookup on demand for "check it now".

## 9. Server & API

```
POST   /api/prs                { url, taskId? }   → create-or-refresh, then gh lookup
PATCH  /api/prs/:id            { taskId }         → the only user-editable field
PUT    /api/prs/order          { order: [id,…] }  → permute one column's positions
POST   /api/prs/:id/refresh                       → on-demand gh lookup
DELETE /api/prs/:id                               → stop tracking
```

`PATCH` accepts `taskId` only. Title, state and author are deliberately not writable:
they are cache, and a hand-edit would be silently overwritten by the next sweep.

`PUT /api/prs/order` takes the ids of one column in their new order. The server collects
the positions those ids **currently hold**, sorts that set, and reassigns them in the
given order. It never invents a position.

Stated that way the endpoint needs no column parameter and cannot corrupt anything: the
set of positions in play is unchanged, so global uniqueness is preserved and no row
outside the request is touched. It rejects `400` on an unknown or duplicate id.

Watchlist rows ride along in `GET /api/state` so the dashboard keeps a single fetch.

## 10. Durability

```
~/claude-tasks/_prs/<host>-<owner>-<repo>-<number>.md
```

The filename carries host and owner, not just `<repo>-<number>`: two GitHub hosts, or two
orgs on one host, can each have an `api` repo with a PR `#1`, and a shorter name would
have silently overwritten one watchlist entry with another.

Frontmatter only, empty body:

```yaml
---
url: https://github.com/example/api/pull/212
task: auth-rate-limit      # slug, not id — ids are a DB artefact
position: 3
added: 1789123456789
---
```

The file holds only what cannot be recovered: the URL you chose to track, the task you
linked it to, and the order you put it in. Every cached field is deliberately absent —
writing a title to disk that `gh` re-supplies in an hour would be a second copy to keep
correct for no gain.

Delete the database and the watchlist survives; the next sweep refills the status. That is
the README's stated contract, and a PR list that lived only in SQLite would break it.

`task` is stored as a slug because task ids are an index artefact that `reindex` may
reassign, while slugs are stable and greppable.

An empty body is intentional headroom: per-PR review notes can be added later without a
migration, in the same place a brief lives for a task.

## 11. Dashboard

A fifth top-level view, `PRS`, beside BOARD / DIGEST / ARCHIVE / TRASH.

Three columns, cards ordered by `position` and draggable **within** a column only. The add
form sits at the top: one URL field, plus an optional task picker.

A card shows: `repo#number`, title, author (when not you), review decision, a draft badge,
age, the linked task, and `↻`. It links out to GitHub. Task link is editable from the card
after creation, reusing the click-to-edit pattern from the drawer header.

Columns always render with an explicit empty state, matching the drawer rule: a vanished
column is not information, "nothing waiting on you" is.

## 12. Configuration

| Key | Default | Meaning |
|---|---|---|
| `ghBin` | resolved | Absolute path to `gh` — launchd gets a bare PATH |
| `prRefreshHours` | `1` | Staleness threshold for the sweep. `0` disables refresh |
| `prMergedShown` | `10` | How many merged PRs the column renders |

`ghBin` is resolved at install time for the same reason `claudeBin` is: the launchd agent
does not inherit a login shell's PATH, so a bare `gh` would fail only under launchd and
work in every manual test.

## 13. Testing

| Concern | Test |
|---|---|
| URL parsing | github.com, enterprise host, trailing slash, `/files` and `#discussion` suffixes |
| Identity | adding a tracked URL updates rather than inserts |
| Degradation | `gh` failure still creates a record, sets `gh_error`, leaves `repo`/`number` populated |
| Cache is not writable | `PATCH` with `title` or `state` is ignored or rejected |
| Ordering | reorder permutes one column and leaves the others' positions untouched |
| Terminal state | a merged PR is never re-fetched by the sweep; a closed one is |
| Durability | `url` + `task` + `position` round-trip through `reindex` after deleting the DB |
| Referential integrity | deleting a task nulls `task_id`, leaving the PR tracked |

`gh` is stubbed with the injected-spawn pattern from `briefer.test.js`, so no test shells
out. The spawn seam is the reason that file's tests are fast and hermetic, and this
inherits it.

## 14. Out of scope (deliberate)

- Discovering PRs automatically from GitHub, or any notion of "all my open PRs"
- Webhooks, polling faster than hourly, or any push mechanism
- Diffs, comments, approvals, or merging from the dashboard
- Editing cached fields by hand
- Dragging between columns — §6
- A separate column for closed-not-merged — §6
- Removing the model-written `PRs:` row from the brief. It is duplicated truth and should
  eventually go, but deleting it belongs with a Status-prompt change, not here.
- CI status. `gh` can supply `statusCheckRollup`, and a red build is genuinely useful, but
  it is a second axis of state and earns its own decision.
