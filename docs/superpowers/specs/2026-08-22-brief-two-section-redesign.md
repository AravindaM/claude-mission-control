# Brief Redesign — Two Cadences, Honest Liveness

Amends §7 (Auto-brief engine) and §5 (Data model) of
`2026-08-20-claude-mission-control-design.md`. Everything not restated here still holds.

## 1. Purpose

Two defects, one shared cause.

**Briefs stop updating.** Across the active tasks, several had never been briefed at all,
most were briefed exactly once and never again, and only the task being developed by hand
was current — because its brief was refreshed manually via `↻`. Work continued on the rest
regardless. A representative task sat at `prompt_count = 13` against
`briefed_prompt_count = 2`: its brief still described the design phase while the session
had long since moved on to a different phase of the work.

**Briefs are the wrong shape.** A single 7.8 KB narrative blends stable scope with
volatile progress, so reading "where is this now" means reading everything, and updating
the status means rewriting the whole document.

The fix for the second is what makes a fix for the first affordable.

## 2. Verified measurements (tested empirically 2026-08-22)

Timed against a real 7.6 MB transcript (43 user turns,
232 assistant turns), model `sonnet`, via the same `claude -p` spawn the briefer uses.

| Shape | Input | Output | Wall clock |
|---|---|---|---|
| Current: whole-transcript full-brief rewrite | 169,458 B (~42k tok) | 11,174 B (~2,794 tok) | **51.8 s** |
| Status-only, 25 KB tail slice | 20,837 B (~5k tok) | 924 B (~231 tok) | **9.9 s** |

- Fixed `claude -p` spawn overhead is **6.4 s** (measured twice: 6.77 s, 5.98 s) for a
  one-token reply. Generation runs ~62 output tokens/second.
- **Output dominates both latency and price.** Sonnet 5 output is 5× input per token
  ($10 vs $2 per MTok, intro through 2026-08-31; $15/$3 after). Shrinking the input from
  42k to 5k tokens saves ~$0.07; shrinking the output from 2,794 to 231 tokens saves
  ~$0.026 *and* 42 seconds.
- Corpus scale over the two measured days: 15 bound sessions, 484 user turns,
  **1,358 assistant turns**, 1.4 MB of extracted turn text.
- `extractConversation` budgets from the tail (`transcript.js:39-47`), so input truncation
  was never the cause of staleness.
- Per-response LLM invocation was evaluated and **rejected**: 1,358 turns × ~50 s of
  full-brief rewrite is ~19 h of serialized generation (the queue at `briefer.js:141-149`
  is single-flight) at ~$45-equivalent. Even with the cheap status-only shape it is
  ~3.7 h and ~$17-equivalent. Cost here is drawn from the user's Claude subscription
  allowance, not API billing, so it competes directly with interactive work.
- `Stop` hook confirmed present. Fires once per completed assistant response. Payload
  carries `session_id`, `cwd`, `transcript_path`, `hook_event_name`, and
  `last_assistant_message`. Its stdout would be injected into context, so the hook branch
  must stay silent — same constraint as `UserPromptSubmit`.
- `claude --resume <id>` reuses **the same `session_id`** and fires
  `SessionEnd(reason: "resume")` before `SessionStart(source: "resume")`.

## 3. Root cause of the staleness

`ended_at` is a one-way latch, and two independent paths set it.

1. `reconciler.js:33-37` declares any session whose transcript mtime is older than
   `GHOST_AFTER_MS` (30 min) ended, stamping `ended_at`. A 30-minute idle gap is normal
   in a tab left open for days.
2. `SessionEnd(reason: "resume")` fires on every `claude --resume`, and because resume
   reuses the session id, `cmc resume` stamps `ended_at` on the very session it revives.

Nothing clears it. The `SessionStart` upsert (`spool.js:63-68`) omits `ended_at` from its
`DO UPDATE SET` list, and the `UserPromptSubmit` handler only touches `prompt_count` and
`last_activity_at`. Meanwhile `reconciler.js:29-32` faithfully advances `last_activity_at`
from transcript mtime, so the row ends up self-contradictory: ended 28 hours before its
last observed activity.

Eligibility then dead-ends at `briefer.js:62-66`:

```js
if (session.ended_at != null) {
  if (session.brief_generated_at != null) return false;   // permanent
  return countUserTurns(transcript) >= 1;
}
// live re-brief branch below is unreachable once ended_at is set
```

Git history shows the live re-briefing branch (`31ae24b`) landed *after* the ghost closer
(`a4e07a0`), confirmed by `git merge-base --is-ancestor`. The live path has therefore
never executed in production. It went unnoticed because `force: true`
(`api.js:171-183`, the per-tile `↻` and no-arg `/task`) bypasses `eligible()` entirely,
which is why `mission-control` — the task being actively developed by hand — is the only
one with a current brief.

The underlying design error: `ended_at` serves two consumers with incompatible needs. The
dashboard's LIVE count wants a cheap, self-correcting guess. The briefer treated the same
column as an irreversible terminal state. **A field cheap to guess wrong must not gate an
irreversible decision.**

## 4. Brief format

Four sections, two cadences. `BRIEF.md` remains one file: an archived task's brief is its
only record, so splitting it across files would put that guarantee at risk.

```markdown
---
(frontmatter unchanged)
---
## About
<Problem, then what is being changed. PR-description register. No history, no progress.>

Scope: <in-scope, max 4 items>
Out of scope: <notable exclusions>

## Status
<2-4 sentences on where the work actually stands>
- Now: <the one thing in flight>
- Next: <the immediate next action>
- Blockers: <only when a real blocker exists; omit the line otherwise>

## Decisions
- <locked choice + why>

## Links
- <every ticket, PR, important file path>
```

Cadence and budget per section:

| Section | Regenerated | Word cap | Input |
|---|---|---|---|
| `## About` | once, then only on explicit request | 120 | current brief + tail slice |
| `## Status` | every eligible sweep | 120 | `## About` + turns since watermark |
| `## Decisions` | with About, and on archive | — | same as About |
| `## Links` | with About, and on archive | — | same as About |

`## About` is deliberately not auto-refreshed on scope drift. Detecting drift reliably is
the same class of unreliable heuristic rejected earlier in this design work; an explicit refresh button is honest about what it knows.

## 5. Data model

Additive columns via the existing `migrate()` pattern in `db.js`:

```sql
ALTER TABLE sessions ADD COLUMN turn_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN briefed_turn_index INTEGER NOT NULL DEFAULT 0;
```

- `turn_count` — assistant responses observed via `Stop`. Liveness and display only.
- `briefed_turn_index` — count of `turns()` entries already folded in. The slicing
  watermark, and the eligibility signal. It counts **all** distilled turns, not just user
  prompts, so an agentic run that works for hours off a single prompt still registers as
  new material.

`briefed_prompt_count` is retained for the existing display and tests; it no longer gates
eligibility.

**`briefed_transcript_bytes` was specced and then dropped.** It existed to avoid parsing
megabytes of JSONL on every sweep, but parsing all 24 transcripts measures **163 ms**, so
the column bought nothing and added a way to wrongly suppress a brief. Measured before
optimising.

## 6. Liveness and triggers

**New `Stop` branch in `mc-hook.sh`.** Spools the event like every other, then fires one
silent background curl to `POST /api/hooks/turn`. Exits 0. No stdout, ever.

**`POST /api/hooks/turn`** does no LLM work:

- `turn_count = turn_count + 1`
- `last_activity_at = <now>`
- **`ended_at = NULL`** — a session that just produced a response is not ended.

That last line breaks the latch at its source: observed activity revokes a guess.

**Reconciler.** `GHOST_AFTER_MS` stays, and stays advisory. It may set `ended_at`; the
`Stop` hook may clear it. `ended_at` reverts to what §10 of the original spec always
wanted it for — the LIVE column — and stops gating briefing.

**Eligibility** (`briefer.js`) no longer branches on `ended_at`:

```
eligible(session) =
  session.task_id != null
  && transcriptFor(session) exists
  && transcriptBytes > session.briefed_transcript_bytes        // new material
  && now - (brief_generated_at ?? 0) > staleMinutes            // debounce
```

The existing 5-minute sweep at `index.js:41` *is* the debounce; no new timer. A finished,
fully-briefed session fails the third clause naturally, with no latch required.
`force: true` continues to bypass all of it.

Config gains `staleMinutes`, replacing `liveBriefMinutes` (default 20). The value is
bounded by generation cost, not by freshness appetite, and was staged accordingly: **15
while briefs were still full rewrites** (~50 s each, single-flight, so a 4-minute cadence
would have spent ~12 minutes of generation per active session per hour), then **4 once only
`## Status` is regenerated** (~10 s).

Never set it to exactly the 5-minute sweep interval: a sweep firing a few milliseconds
early fails the strict `>` comparison and the work slips to the next sweep, halving the
effective cadence.

Eligibility is evaluated per session, since watermarks are per session. The due sessions
are then grouped by task before generation, per §7.1 — a task is briefed once per pass, not
once per session.

## 7. Generation

`transcript.js` gains one function:

```
extractTurnsSince(path, fromIndex, maxBytes) -> { text, endIndex }
```

Tail-budgeted like `extractConversation`, but starting after `fromIndex`, and returning
the new watermark so the caller records exactly what it folded in. When the slice exceeds
the budget it drops from the *head* — the oldest of the new turns — because the newest
material matters most for a status line. Dropped turns are skipped permanently, so the
function must report how many, and the caller records that in the `brief_saved` event. A
cap that silently discards work reads as "fully covered" when it is not.

Two prompts replace the single `INSTRUCTION`. `SYSTEM_ROLE` is unchanged — the archivist
framing must stay in the system prompt, per §2 of the original spec.

- **About pass** — runs when the brief has no `## About` section, or on explicit request.
  Input: current brief + tail slice. Emits `## About`, `## Decisions`, `## Links`.
- **Status pass** — the common case. Input: the brief's `## About` section + turns since
  `briefed_turn_index`. Emits `## Status` only, capped at 120 words, in the
  Now/Next/Blockers shape. On success, splice it into the stored brief and advance both
  watermarks. `## Decisions` is deliberately **not** fed in: it is the largest section and
  including it would roughly double input on the hot path. The cost is that Status may
  occasionally restate a decision; the measured run did not, and re-adding it later is a
  one-line change if it turns out to matter.

Splicing is a section replacement on the parsed brief, not a whole-document rewrite. This
is what buys the 5× latency win: the model never re-emits text it is not changing.

Failure handling is unchanged — `brief_failed` with `rejectedHead`, transcripts retained,
retried by the next sweep. A failed Status pass must not advance the watermarks.

### 7.1 Tasks with several sessions

`## Status` is per-task, but watermarks are per-session, and two tasks already have two
sessions each. Briefing must therefore be **keyed by
task, not by session** — today `enqueue` keys on `session_uuid` (`briefer.js:227-230`),
which would let one task generate two competing Status blocks in a single drain, the
second silently overwriting the first.

The rule:

- A task is due when **any** of its sessions has `transcriptBytes > briefed_transcript_bytes`.
- Input is the concatenated unbriefed tail of every such session, each prefixed with its
  session id so the model can attribute parallel work, subject to one shared byte budget.
- On success, **all** contributing sessions advance their watermarks. On failure, none do.
- The queue dedupes by task id, so a task is never in flight twice.

This also fixes an existing latent bug: `refresh-brief` (`api.js:174-182`) already picks
just the newest-transcript session, so a task worked in two tabs has always had half its
material ignored.

## 8. Validation

Two functions hard-code section names today, not one:

- `looksLikeBrief` (`briefer.js:43-45`) — `startsWith('## Goal') && includes('## Next steps')`.
- `normalizeBriefOutput` (`briefer.js:33-41`) — strips fences, then cuts preamble via
  `indexOf('## Goal')` **only when the match falls within the first 400 chars**.

Both become format-aware, and each gains a fragment variant:

| Path | Normalizer anchor | Accept when |
|---|---|---|
| Full brief | `## About` (same 400-char window) | starts with `## About`, contains `## Status` |
| Status fragment | `## Status` | starts with `## Status`, contains no other `## ` heading, ≤ 4,000 bytes |

The "no other heading" rule is the prompt-capture guard: a Status pass that emits a whole
brief has been captured by the transcript and must be rejected, exactly as today.
`MAX_OUTPUT_BYTES = 100_000` stays for the full-brief path but is far too loose for a
120-word fragment, hence the separate 4,000-byte cap.

## 9. Migration of existing briefs

Existing briefs are in the old `## Goal` format. No batch migration and no format-version
field: the About pass already triggers on a missing `## About`, so the first eligible
sweep upgrades each brief in place, seeded with its old content. `saveBrief`
(`taskstore.js:162-172`) versions the prior body into `briefs/` first, so every upgrade is
recoverable.

The latched sessions become eligible the moment the `ended_at` gate is removed, so
the upgrade happens without manual intervention.

## 10. Files touched

| File | Change |
|---|---|
| `hooks/mc-hook.sh` | `Stop` branch, silent curl to `/api/hooks/turn` |
| `install/install.sh` | register `Stop` in the jq hook block (~line 36) |
| `server/src/db.js` | three additive columns in `migrate()` |
| `server/src/spool.js` | handle `Stop` in `applySpoolEvent`; clear `ended_at` |
| `server/src/api.js` | `POST /api/hooks/turn`; About-refresh endpoint |
| `server/src/briefer.js` | two-pass generation, eligibility, splice, both validators (`:26`, `:38`, `:44`, `:205`) |
| `server/src/transcript.js` | `extractTurnsSince` |
| `server/src/reconciler.js` | comment only — ghost closer becomes advisory, behaviour unchanged |
| `server/src/config.js` | `staleMinutes` replaces `liveBriefMinutes` |
| `install/seed-demo.sh` | `:24`, `:28` — demo fixture briefs are in the old format |
| `server/test/briefer.test.js` | fixtures at `:15,44,72,84,115,148,155,214`; assertions at `:121`, `:225` |

**Unchanged.** `Digest.jsx` and `cli/cmc.sh:69-74` still render the brief whole, which is
right for a scannable list. `reindex` and `migrateLegacyStatuses` read frontmatter only, so
a body format change is invisible to them. Tiles render no brief text at all.

**Changed after all — the detail panel (§15).** The original survey concluded per-section
UI was an optional refinement because `app.css` styles every heading identically, so the
split "was already visible". Using it proved otherwise: identical styling is exactly what
makes About and Status indistinguishable, and Status sat below three edit fields.

## 11. Testing

Baseline to preserve: **84/84 passing in 598 ms** (`vitest run`, 2026-08-22).

New coverage, TDD:

- A session with `ended_at` set and a prior brief is eligible again once the transcript
  grows — the regression that produced this spec.
- `POST /api/hooks/turn` clears `ended_at` and bumps `turn_count`.
- `extractTurnsSince` returns only turns after the index and reports the correct
  `endIndex`; a byte cap drops from the head of the slice, not the tail.
- Status pass splices into `## Status` and leaves About/Decisions/Links byte-identical.
- A Status pass returning a full brief is rejected and does not advance the watermark.
- An old `## Goal` brief triggers the About pass and ends up in the new format.
- A task with two sessions, both with new material, produces **one** Status pass covering
  both, and advances both watermarks (§7.1).
- Archive `finalize()` still produces a self-contained brief with all links.

## 12. Out of scope

- Per-assistant-response LLM invocation — measured, costed, rejected (§2).
- Auto-detecting scope drift to refresh `## About`.
- Streaming or incrementally appending Status without an LLM.
- Prompt caching. The stable prefix (`SYSTEM_ROLE`, ~80 tokens) is far below the ~1024
  token minimum cacheable prefix, and the CLI gives no breakpoint control.
- Changing the archive contract.
- Backfilling the stale briefs by hand — §9 handles it.
- Per-section UI rendering in the Drawer and Digest (see §10).
- The adjacent defects in §13.

## 13. Adjacent findings, recorded not fixed

Surfaced while surveying consumers. None block this change; two get worse because of it.

- **`plan_file` is silently dropped on every brief save.** `rowToFrontmatter`
  (`taskstore.js:47-60`) regenerates the entire frontmatter from the DB row and does not
  include `plan_file`, yet `briefer.js:80-81` reads `fm.plan_file` to inject the plan into
  the prompt. Any `saveBrief` or `syncFrontmatter` erases a hand-added key. This change
  makes briefs save far more often, so a hand-set `plan_file` will now be destroyed almost
  immediately. Worth fixing first if anyone relies on it.
- **The 8 KB SessionStart injection cap stops mattering.** `mc-hook.sh:62` truncates with
  `head -c 8192`, which can cut mid-section and mid-UTF-8. Today's briefs run to 7.8 KB, so
  the cap is live. The new format lands around 2-3 KB, so injection becomes lossless
  without touching the cap.
- **Stale docs (since fixed).** The README documented `claude -p --bare`, which
  `briefer.js` deliberately dropped because bare mode breaks Keychain OAuth, and a
  `/task-save` skill that no longer exists and that `install/install.sh` actively unlinks.
  Both were corrected when the README was rewritten for publication.

## 14. Build order — delivered 2026-08-22

1. **Latch fix.** `Stop` hook + registration, `POST /api/hooks/turn`, eligibility without
   `ended_at`. Verified live: all 13 tasks with sessions re-briefed themselves in ~8
   minutes, zero failures.
2. **Watermarks.** `extractTurnsSince`, two columns, per-task queue keying (§7.1).
3. **Two-pass generation.** New format, `briefformat.js`, both validators, fragment
   splice, self-migration. Verified live: every task migrated, zero failures, and
   every brief now fits under the 8 KB injection cap (largest 6.7 KB, was 8.9 KB).

No dashboard or CLI step — §10 established that none was needed.

### What changed against this spec while building it

- **A second bug, unrelated to the latch.** `drain()` left `draining` set to a resolved
  promise whenever it ran on an empty queue, because the async body completed
  synchronously and its own `draining = null` was then overwritten by the assignment. Every
  later job, forced `↻` refreshes included, was silently dropped for the process lifetime,
  and `index.js` sweeps on boot. Either bug alone was enough to freeze briefing, and they
  concealed each other: the latch kept sweeps from queueing work, so sweeps ran empty,
  which poisoned the drain.
- **`briefed_transcript_bytes` dropped** — measured unnecessary (§5).
- **`staleMinutes` staged 15 → 4**, tracking generation cost rather than appetite (§6).
- **An explicit About refresh was missing.** The spec said About regenerates "only on
  explicit request" but never specified the request. Without it a polluted About is
  permanent, since the routine path skips that pass whenever the section exists.
  `POST /api/tasks/:id/refresh-brief` now takes `{about: true}`.
- **The About prompt needed to say *why*, not just *what*.** 13 of 14 migrated tasks
  produced a clean PR-description About; the one whose input brief was most status-heavy
  carried progress across. Naming the giveaway words and explaining that Status owns
  progress fixed it on re-run.

## 15. Detail panel — fields, not a markdown blob (2026-08-24)

The brief was one rendered blob under a `BRIEF` heading, with every section styled the
same, sitting below the resume hint and three edit fields. Two consequences: the split
between stable and volatile content was invisible, and the answer to "where is this now"
was the last thing you reached.

**`GET /api/tasks/:id/brief` now also returns `sections`**, built by `splitBrief` in
`briefformat.js`. The structuring is server-side so the parsing has tests; the dashboard
only renders. `body` is retained for the raw view and for briefs the splitter finds nothing
in. `splitBrief` lifts `Now`/`Next`/`Blockers` and `Scope`/`Out of scope` out of their
sections into `{label, value}` rows, matching against an allowlist rather than a
`- word: value` pattern — any such pattern swallows ordinary prose containing a colon.

**Panel order** is metadata readout → stage strip → Status → About → Decisions → Links →
Sessions → Timeline → Edit.

- **Status is the lit panel**: stage-hued 3px left edge, raised background, refresh
  control. It is the section that changes constantly and the question the panel is opened
  to answer, so it carries the visual weight. About sits below as quiet prose with a
  separate `↻ rewrite` that triggers the About pass.
- **The readout keeps three guaranteed cells** — stage, active, last activity — and renders
  Jira, branch and repo only when set. A fixed grid showed three em-dashes in a row on
  tasks with no Jira or repo, which reads as a broken panel rather than an empty field.
- **`view raw markdown`** toggles back to the whole document; a brief with no recognisable
  sections falls back to it automatically rather than showing four empty panels.

Links render as list rows, not chips. Chips assumed short labels; real Links entries run to
whole paragraphs with embedded anchors, so the content chose the container.
