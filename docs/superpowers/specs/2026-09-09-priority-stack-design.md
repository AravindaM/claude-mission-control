# Priority Stack — An Ordering the Board Cannot Express

Amends §5 (Data model), §9 (Server & API) and §10 (Dashboard UI) of
`2026-08-20-claude-mission-control-design.md`. Everything not restated here still holds.

## 1. Purpose

The board answers "what stage is each task at". It cannot answer "what should I do next",
and its sort actively obscures it.

`meta.js:34` orders every card by liveness, then `last_activity_at`, then `updated_at`.
That is a recency ranking. A task you have been avoiding for a week sinks to the bottom of
its column *because* you have been avoiding it — the signal is inverted relative to
importance. With twelve active tasks across four columns there is no surface anywhere in
the product that states, in order, the three things that actually matter.

This adds one: a short, manually ordered stack, held separately from stage.

## 2. What this is not

Not a total ranking. Ranking twelve tasks to express that three matter is work that
produces a number nobody trusts. Rank is **sparse and optional** — most tasks never have
one, and an empty stack is a legitimate state meaning "nothing is prioritised".

Not a second board. The stack is capped (§6) so it stays glanceable. If it grows to hold
everything it has become the thing it was meant to cut through.

Not a due-date or estimate system. Order is the only signal.

## 3. Placement, and why not a rail

A horizontal strip above the board, always visible in the board view.

A vertical rail left of PREP was the first instinct and is wrong on this layout. The
measurement that settles it:

| | Board width available | Per column (4 columns) |
|---|---|---|
| Today, drawer open, 1440px window | ~776px | ~194px |
| With a 186px priority rail | ~590px | ~147px |

`Drawer.jsx:234` is `w-[640px] shrink-0` — fixed, and it never yields. `Board.jsx`
columns are `flex-1 min-w-0`, so they absorb the entire squeeze and, because `min-w-0`
removes the floor that would otherwise force a scrollbar, they absorb it *silently* by
truncating card titles. Titles already truncate at 194px (visible in `docs/screenshot.png`:
"Retry policy for…", "Paginate the searc…").

Meanwhile the same columns run 40–70% empty vertically.

So horizontal space is the scarce axis and vertical is abundant. A rail spends the failing
axis permanently, on every screen, whether or not anything is prioritised. A strip spends
~80px of the axis that is spare. The strip also leaves `Board.jsx` untouched.

The cost accepted in exchange: a left-to-right rank reads slightly worse than
top-to-bottom, and horizontal drag targets are narrower. Both are acceptable at a
single-digit cap; neither would be at thirty items.

## 4. Data model

```sql
ALTER TABLE tasks ADD COLUMN priority INTEGER   -- nullable; NULL means unranked
```

Added to the existing additive loop in `db.js:75`, which already tolerates
`duplicate column`.

**Invariant.** Across tasks that are not archived, not soft-deleted, and not at stage
`done`, the non-NULL `priority` values are exactly `1..n` — no gaps, no duplicates.

This is enforced by construction, not repaired by maintenance: every write restates the
entire order (§5). There is deliberately no compaction job, because there is no state it
could ever find to fix.

**Durability.** `priority` is added to `rowToFrontmatter` (`taskstore.js:47`) and to
`reindex`'s insert and `ON CONFLICT` clause (`:208`). This is not optional polish — the
project's core invariant is that the SQLite index is disposable and rebuilds from
`BRIEF.md`. A rank held only in the DB would be destroyed by an operation the README
explicitly tells users is safe.

## 5. Server

One endpoint serves promote, demote, remove, and reorder, because all four are the same
statement: *here is the new order*.

```
PUT /api/priority     { order: [taskId, ...] }   →  { order: [...] }
```

Backed by `setPriorities(ctx, order)` in `taskstore.js`, which assigns `1..n` by array
position inside a single transaction, then syncs frontmatter for every task whose rank
changed — including tasks dropped out of the order, which are set back to NULL.

`order: []` is valid and clears the stack entirely. There is no separate delete route.

Rejects `400` on: unknown id, duplicate id, a task that is archived / soft-deleted / at
`done`, or `order.length` greater than the cap.

**It must not route through `updateTask`.** `updateTask` bumps `updated_at` on every
field it writes (`taskstore.js:131`). `updated_at` feeds `sortCards` and the digest's
`ORDER BY … updated_at DESC`, so reordering the stack through it would reshuffle the board
and the digest — reordering would register as *activity*. The endpoint uses a dedicated
statement that writes `priority` alone.

**Auto-clear.** Reaching `done`, being archived, or being trashed drops a task from the
stack and closes the gap. Implemented as `dropFromStack(ctx, id)` called *inside* the
existing transactions of `updateTask` (when `status` becomes `done`), `archiveTask`, and
`softDelete` — inside, because a crash between the status write and the rank write would
otherwise leave the invariant in §4 violated.

Chosen over "rank persists until you clear it" because a stack that accumulates finished
work rots, which is the failure the board already has. The accepted cost: moving a task to
`done` prematurely loses its rank with no undo. Rank is cheap to re-set; a stack you have
stopped trusting is not.

`unarchiveTask` does **not** restore a previous rank. The task returns unranked. Storing a
`priority_before_archive` to mirror `status_before_archive` is possible and deliberately
skipped — an old rank restored into a stack that has moved on is worse than no rank.

## 6. Cap

Eight. The server rejects a longer order; the dashboard hides the drop target at the cap.

Eight rather than five because the strip fits eight chips at 1440px without wrapping, and a
cap that bites during ordinary use gets resented. Eight rather than unbounded because the
strip's whole value is being readable in one glance, and it wraps past that.

## 7. Dashboard

New `PriorityStrip.jsx`, rendered by `App.jsx` above `<Board>`, board view only. Not in
digest, archive, or trash — those are review surfaces, not working ones.

- A drop target via `pragmatic-drag-and-drop`, the adapter `Board.jsx` already uses.
  Dropping a card lands it at the drop position, not the end.
- Chips are draggable among themselves to reorder.
- **Always rendered, even when empty**, as a dashed "drag a card here to prioritise".
  A strip that hid when empty could never be populated, and it matches the existing drawer
  rule that panels state their emptiness rather than vanishing.
- At the cap, the drop target renders disabled with the reason, rather than silently
  ignoring a drop.

Board cards carry a small rank number in their slug row. Without it the two surfaces are
disconnected — twelve cards are on screen and nothing says which four are the stack. This
is the minimum needed to link them, not a second ordering surface: the number is display
only.

**`sortCards` is deliberately left alone.** An earlier draft argued the opposite — that
rank must sort ahead of liveness, or a live session on an unranked task would outrank
your #1. That argument holds only where the badge *is* the priority surface, and it is
not: the strip states the order explicitly, so the board never has to encode it. Making
rank sort ahead of liveness would also mean every reorder reshuffles the columns, so
the board would jump while you were dragging chips above it. The board keeps answering
"what stage is everything at"; the strip answers "what next". Neither has to do both.

Reordering is optimistic in the client, reconciled by the existing SSE `changed`
broadcast.

## 8. `cmc ls`

Gains a `PRI` column, and ranked tasks sort above unranked ones.

The dashboard is not the only place state gets checked; the terminal is, often more. A
dashboard-only stack would answer "what next" in the surface you consult less. Cost is a
few lines of `jq` in `cli/cmc.sh`.

The file-fallback path in `cmc ls` (used when the server is down) is left alone. It reads
frontmatter with `awk` and prints slug and status only; extending it is not worth the
parsing.

## 9. Concurrency

Two dashboard tabs reordering simultaneously is last-write-wins on the whole list. Not
guarded: this is a single-user loopback tool, the window is the width of one HTTP request,
and the damage is a wrong order the user can see and fix by dragging. A version token
would add a conflict path to exercise a race that costs one drag to repair.

## 10. Testing

| Concern | Test |
|---|---|
| Durability | `priority` round-trips DB → frontmatter → `reindex` → DB |
| Invariant | reorder assigns exactly `1..n` by position |
| Validation | rejects duplicate id, unknown id, `done` task, over-cap |
| The `updated_at` trap | reorder leaves `updated_at` untouched on every task it writes |
| Auto-clear | `done`, archive, and trash each drop the task |
| Compaction | dropping a middle-ranked task leaves no gap |
| No rank restore | `unarchiveTask` returns the task unranked |

The `updated_at` row is the one worth being explicit about: without it, a later refactor
that routes reorder through `updateTask` for tidiness would silently reintroduce the board
and digest reshuffle, and no other test would catch it.

## 11. Files touched

- `server/src/db.js` — migration
- `server/src/taskstore.js` — `rowToFrontmatter`, `reindex`, `dropFromStack`, hooks in
  `updateTask` / `archiveTask` / `softDelete`, `setPriorities`
- `server/src/api.js` — `PUT /api/priority`
- `dashboard/src/components/PriorityStrip.jsx` — new
- `dashboard/src/App.jsx` — render the strip
- `dashboard/src/api.js` — `setPriority(order)`
- `dashboard/src/components/Card.jsx` — rank number
- `cli/cmc.sh` — `PRI` column
- `README.md` — document the stack
- `server/test/taskstore.test.js`, `server/test/api.test.js`

## 12. Out of scope (deliberate)

- Total ranking of all tasks (§2)
- Due dates, estimates, or any second priority signal
- Rank restoration on unarchive (§5)
- Sparse/fractional ranks and a compaction job (§4)
- Optimistic-concurrency tokens (§9)
- Any change to `sortCards` or the board's column ordering (§7)
- Rank in the brief, or the briefer reading it. The brief describes the work; rank is
  scheduling, and it changes far faster than a brief regenerates.
- Rank in the digest or `cmc digest`
