import { useEffect, useRef, useState } from 'react';
import { draggable, dropTargetForElements, monitorForElements } from '@atlaskit/pragmatic-drag-and-drop/element/adapter';

import { agoLabel } from '../meta.js';
import { addPr, setPrOrder, setPrTask, refreshPr, deletePr } from '../api.js';
import { setDragging } from '../store.js';

/**
 * The PR watchlist.
 *
 * Not a kanban. Columns are a projection of (state, author_is_me), both of
 * which come from `gh` — so cards drag only WITHIN a column, to set your own
 * order. Dragging between columns would be asserting a fact GitHub already
 * owns, and would be overwritten by the next hourly sweep.
 */

const COLUMNS = [
  {
    key: 'mine',
    label: 'MINE · AWAITING REVIEW',
    color: 'var(--st-development)',
    match: (p) => p.state === 'open' && p.author_is_me === 1,
    empty: 'nothing of yours is open',
  },
  {
    key: 'review',
    label: 'TO REVIEW · OTHERS',
    color: 'var(--st-review)',
    match: (p) => p.state === 'open' && p.author_is_me === 0,
    empty: 'nothing waiting on you',
  },
  {
    key: 'merged',
    label: 'MERGED',
    color: 'var(--st-done)',
    match: (p) => p.state === 'merged' || p.state === 'closed',
    empty: 'nothing landed yet',
  },
];

// author_is_me is NULL when gh could not tell us who you are. Those cards
// cannot be filed without guessing, and guessing wrong looks entirely
// plausible — so they sit in the open until a refresh resolves them.
const isUnsorted = (p) => p.state === 'open' && p.author_is_me == null;

function reviewBadge(pr) {
  if (pr.is_draft) return { text: 'draft', tone: 'text-muted' };
  if (pr.review_decision === 'APPROVED') return { text: 'approved', tone: 'text-done' };
  if (pr.review_decision === 'CHANGES_REQUESTED') return { text: 'changes requested', tone: 'text-danger' };
  if (pr.review_decision === 'REVIEW_REQUIRED') return { text: 'review required', tone: 'text-accent' };
  return null;
}

function PrCard({ pr, tasks, now, index }) {
  const ref = useRef(null);
  const [over, setOver] = useState(false);
  const [lifted, setLifted] = useState(false);
  const [busy, setBusy] = useState(false);
  const badge = reviewBadge(pr);
  const task = pr.task_id != null ? tasks.find((t) => t.id === pr.task_id) : null;

  useEffect(() => {
    const el = ref.current;
    const stopDrag = draggable({
      element: el,
      getInitialData: () => ({ type: 'pr', prId: pr.id, column: pr.column }),
      canDrag: ({ input }) => !(input.target instanceof Element && input.target.closest('[data-no-drag]')),
      onDragStart: () => { setDragging(true); setLifted(true); },
      onDrop: () => { setDragging(false); setLifted(false); },
    });
    const stopDrop = dropTargetForElements({
      element: el,
      getData: () => ({ type: 'pr-slot', prId: pr.id, column: pr.column, index }),
      onDragEnter: () => setOver(true),
      onDragLeave: () => setOver(false),
      onDrop: () => setOver(false),
    });
    return () => { stopDrag(); stopDrop(); };
  }, [pr.id, pr.column, index]);

  const closed = pr.state === 'closed';

  return (
    <div
      ref={ref}
      className={`cursor-grab rounded border p-3 ${over ? 'border-accent' : 'border-line'} ${lifted ? 'opacity-40' : ''}`}
      style={{ background: 'var(--surface)' }}
    >
      <div className="flex min-w-0 items-center gap-2">
        <a
          href={pr.url} target="_blank" rel="noreferrer" data-no-drag
          className={`min-w-0 flex-1 truncate font-mono text-[15px] hover:text-accent ${closed ? 'text-muted line-through' : 'text-accent'}`}
        >
          {pr.repo}#{pr.number}
        </a>
        {closed && <span className="shrink-0 font-mono text-[12px] text-muted">closed</span>}
        {/* Both card actions live together in the top-right: they are the two
            things you do TO a card, as opposed to the task picker below, which
            is something you set ON it. */}
        <button
          data-no-drag
          className="mc-tip shrink-0 rounded border border-line px-1.5 font-mono text-[13px] text-muted hover:border-accent hover:text-accent disabled:opacity-40"
          data-tip={busy ? 'checking…' : 're-read status from gh'}
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            await refreshPr(pr.id).catch(() => {});
            setBusy(false);
          }}
        >
          {busy ? '…' : '↻'}
        </button>
        <button
          data-no-drag
          className="mc-tip shrink-0 rounded border border-line px-1.5 font-mono text-[13px] text-muted hover:border-danger hover:text-danger"
          data-tip="stop tracking this PR"
          onClick={() => deletePr(pr.id).catch(() => {})}
        >
          ×
        </button>
      </div>

      <div className="mt-1 line-clamp-2 text-[16px] leading-snug">
        {pr.title ?? <span className="text-muted">untitled — ↻ to fetch</span>}
      </div>

      {pr.gh_error && (
        <div className="mt-1 font-mono text-[12px] text-danger" title={pr.gh_error}>
          gh lookup failed{pr.gh_failures >= 5 ? ' — gave up, ↻ to retry' : ' — ↻ to retry'}
        </div>
      )}

      <div className="mt-2 flex min-w-0 items-center gap-2 font-mono text-[13px] text-muted">
        {badge && <span className={`shrink-0 ${badge.tone}`}>{badge.text}</span>}
        {pr.author_login && pr.author_is_me !== 1 && (
          <span className="truncate">@{pr.author_login}</span>
        )}
        <span className="ml-auto shrink-0">{agoLabel(pr.updated_at, now)}</span>
      </div>

      <div className="mt-1.5 flex min-w-0 items-center gap-2" data-no-drag>
        <select
          value={pr.task_id ?? ''}
          onChange={(e) => setPrTask(pr.id, e.target.value ? Number(e.target.value) : null).catch(() => {})}
          className="min-w-0 flex-1 rounded border border-line bg-raised px-1 py-0.5 font-mono text-[13px] text-muted"
        >
          <option value="">no task</option>
          {tasks.filter((t) => !t.archived).map((t) => (
            <option key={t.id} value={t.id}>{t.slug}</option>
          ))}
          {task?.archived && <option value={task.id}>{task.slug} (archived)</option>}
        </select>
      </div>
    </div>
  );
}

function Column({ column, prs, tasks, now }) {
  const ref = useRef(null);
  const [over, setOver] = useState(false);

  useEffect(() => dropTargetForElements({
    element: ref.current,
    getData: () => ({ type: 'pr-column', column: column.key }),
    onDragEnter: () => setOver(true),
    onDragLeave: () => setOver(false),
    onDrop: () => setOver(false),
  }), [column.key]);

  return (
    <section ref={ref} aria-label={`${column.key} column`}
      className={`flex min-w-[240px] flex-1 flex-col rounded border bg-surface/40 ${over ? 'border-accent' : 'border-line'}`}>
      <header className="flex items-center gap-2 border-b border-line px-3 py-2.5">
        <span className="size-[12px] shrink-0 rounded-[2px]" style={{ background: column.color }} />
        <h2 className="truncate font-mono text-[14px] font-semibold tracking-[0.15em]">{column.label}</h2>
        <span className="ml-auto font-mono text-[15px] text-muted">{prs.length}</span>
      </header>
      <div className="flex flex-col gap-2.5 overflow-y-auto p-2.5">
        {/* Always rendered: "nothing waiting on you" is information, a column
            that vanished is not. Same rule as the task drawer's panels. */}
        {prs.length === 0 && (
          <p className="px-1 py-3 text-center font-mono text-[14px] text-muted">{column.empty}</p>
        )}
        {prs.map((pr, i) => (
          <PrCard key={pr.id} pr={pr} tasks={tasks} now={now} index={i} />
        ))}
      </div>
    </section>
  );
}

function AddForm() {
  const [url, setUrl] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  return (
    <form
      className="flex items-center gap-2 px-3 pt-3"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!url.trim()) return;
        setBusy(true);
        setError(null);
        try {
          await addPr(url.trim());
          setUrl('');
        } catch {
          setError('not a pull request url');
        }
        setBusy(false);
      }}
    >
      <input
        value={url}
        onChange={(e) => { setUrl(e.target.value); setError(null); }}
        placeholder="paste a pull request url…"
        aria-label="pull request url"
        className={`flex-1 rounded border bg-raised px-2 py-1.5 font-mono text-[15px] outline-none
          ${error ? 'border-danger' : 'border-line focus:border-accent'}`}
      />
      <button
        type="submit" disabled={busy}
        className="shrink-0 rounded border border-line px-3 py-1.5 font-mono text-[15px] text-muted hover:border-accent hover:text-accent disabled:opacity-40"
      >
        {busy ? 'adding…' : 'track'}
      </button>
      {error && <span className="shrink-0 font-mono text-[14px] text-danger">{error}</span>}
    </form>
  );
}

export default function GithubBoard({ state, now }) {
  const all = state.prs ?? [];
  const mergedShown = state.prMergedShown ?? 10;

  useEffect(() => monitorForElements({
    canMonitor: ({ source }) => source.data.type === 'pr',
    onDrop: ({ source, location }) => {
      setDragging(false);
      const slot = location.current.dropTargets.find((t) => t.data?.type === 'pr-slot');
      if (!slot || slot.data.prId === source.data.prId) return;
      // Reordering is only meaningful within a column: the column itself is a
      // projection of gh state, so a cross-column drop is not a thing to honour.
      if (slot.data.column !== source.data.column) return;

      const column = COLUMNS.find((c) => c.key === slot.data.column);
      const members = (state.prs ?? []).filter(column.match).sort((a, b) => a.position - b.position);
      const ids = members.map((p) => p.id);
      const from = ids.indexOf(source.data.prId);
      const without = ids.filter((id) => id !== source.data.prId);
      // Pulling the dragged card out shifts every later slot down by one.
      const target = from !== -1 && from < slot.data.index ? slot.data.index - 1 : slot.data.index;
      const next = [...without.slice(0, target), source.data.prId, ...without.slice(target)];
      if (next.join() !== ids.join()) setPrOrder(next).catch(() => {});
    },
  }), [state]);

  const unsorted = all.filter(isUnsorted).sort((a, b) => a.position - b.position);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <AddForm />

      {unsorted.length > 0 && (
        <section aria-label="unsorted prs" className="mx-3 mt-3 rounded border border-danger/50 p-2.5">
          <div className="mb-1.5 font-mono text-[13px] tracking-widest text-danger">
            AUTHOR UNKNOWN — gh could not say who opened these
          </div>
          <div className="flex flex-wrap gap-2.5">
            {unsorted.map((pr, i) => (
              <div key={pr.id} className="w-[260px]">
                <PrCard pr={pr} tasks={state.tasks} now={now} index={i} />
              </div>
            ))}
          </div>
        </section>
      )}

      <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto p-3">
        {COLUMNS.map((col) => {
          let prs = all.filter(col.match).sort((a, b) => a.position - b.position);
          // Merged grows for the life of the install and nothing the user does
          // removes a card, because nothing here is dragged between columns.
          if (col.key === 'merged') {
            prs = [...prs].sort((a, b) => (b.resolved_at ?? 0) - (a.resolved_at ?? 0)).slice(0, mergedShown);
          }
          return <Column key={col.key} column={col} prs={prs.map((p) => ({ ...p, column: col.key }))}
            tasks={state.tasks} now={now} />;
        })}
      </div>
    </div>
  );
}
