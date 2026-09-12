import { useEffect, useRef, useState } from 'react';
import { draggable } from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
import { STAGES, agoLabel, stageColor, tileBackground } from '../meta.js';
import { patchTask, trashTask, refreshBrief } from '../api.js';
import StageStrip from './StageStrip.jsx';
import CardMenu from './CardMenu.jsx';

function RefreshBriefButton({ task }) {
  const [pending, setPending] = useState(false);
  const briefStamp = useRef(task.updated_at);

  // The regenerated brief bumps updated_at and arrives via SSE resync.
  useEffect(() => {
    if (pending && task.updated_at !== briefStamp.current) setPending(false);
  }, [task.updated_at, pending]);

  return (
    <button
      data-no-drag
      className="mc-tip shrink-0 rounded border border-line px-1.5 font-mono text-[14px] text-muted hover:border-accent hover:text-accent disabled:opacity-40"
      data-tip={pending ? 'brief regenerating…' : 'refresh brief from latest session'}
      disabled={pending}
      onClick={async (e) => {
        e.stopPropagation();
        briefStamp.current = task.updated_at;
        const res = await refreshBrief(task.id).catch(() => ({ queued: false }));
        if (res.queued) {
          setPending(true);
          setTimeout(() => setPending(false), 120_000); // failure safety valve
        }
      }}
    >
      {pending ? '…' : '↻'}
    </button>
  );
}

function shiftStatus(task, dir) {
  const i = STAGES.findIndex((s) => s.key === task.status);
  const next = STAGES[i + dir];
  if (next) patchTask(task.id, { status: next.key });
}

export default function Card({ task, now, jiraBase, onOpen }) {
  const ref = useRef(null);
  const [menuAt, setMenuAt] = useState(null);

  useEffect(() => draggable({
    element: ref.current,
    getInitialData: () => ({ type: 'card', taskId: task.id }),
    canDrag: ({ input }) => !(input.target instanceof Element && input.target.closest('[data-no-drag]')),
  }), [task.id]);

  const live = task.live_sessions > 0;
  const repoName = task.repo_path ? task.repo_path.split('/').pop() : null;

  return (
    <div
      ref={ref}
      tabIndex={0}
      role="button"
      aria-label={`task ${task.slug}`}
      onClick={() => onOpen(task)}
      onContextMenu={(e) => { e.preventDefault(); setMenuAt({ x: e.clientX, y: e.clientY }); }}
      onKeyDown={(e) => {
        if (e.key === 'ArrowLeft') { e.preventDefault(); shiftStatus(task, -1); }
        else if (e.key === 'ArrowRight') { e.preventDefault(); shiftStatus(task, 1); }
        else if (e.key === 'e') patchTask(task.id, { archived: true });
        else if (e.key === '#') trashTask(task.id);
        else if (e.key === 'Enter') onOpen(task);
        else if (e.key === 'm') setMenuAt({ x: 0, y: 0, anchor: ref.current });
      }}
      className="group cursor-pointer rounded border border-line p-4 hover:border-muted"
      style={{
        borderLeft: `4px solid ${stageColor(task.status)}`,
        background: tileBackground(task.status),
      }}
    >
      {/* min-w-0 is load-bearing: a flex item defaults to min-width:auto, which
          for nowrap text is its full content width, so the row refuses to
          shrink and bursts out of a narrow column instead of truncating. */}
      <div className="flex min-w-0 items-center gap-1.5">
        <span
          className={`inline-block size-[11px] shrink-0 rounded-full ${live ? '' : 'opacity-30'}`}
          style={{ background: live ? 'var(--stage-done)' : 'var(--muted)' }}
          title={live ? 'session live' : 'no live session'}
        />
        {/* Display only — the strip states the order, this just says which of
            the twelve cards on screen are the ones in it. The board's own sort
            is deliberately unchanged. */}
        {task.priority != null && (
          <span
            className="grid size-[22px] shrink-0 place-items-center rounded-[3px] bg-accent font-mono text-[16px] font-semibold leading-none text-bg"
            title={`priority ${task.priority}`}
          >
            {task.priority}
          </span>
        )}
        {/* min-w-[4ch], not min-w-0: flex-1 implies basis:0, so the ticket chip
            claimed its content width first and the slug collapsed to nothing.
            A floor guarantees it always renders something identifiable. */}
        <span className="min-w-[4ch] flex-1 truncate font-mono text-[16px] tracking-wide text-muted">
          {task.slug}
        </span>
        {task.jira_key && (
          <a
            href={`${jiraBase}${task.jira_key}`}
            target="_blank" rel="noreferrer" data-no-drag
            onClick={(e) => e.stopPropagation()}
            // Allowed to shrink rather than shrink-0: at the 190px column
            // floor a fixed-width ticket chip plus a rank badge squeezed the
            // slug to zero and it vanished entirely. Both truncate instead.
            className="min-w-0 max-w-[10ch] truncate rounded border border-line px-1 font-mono text-[15px] text-accent hover:border-accent"
          >
            {task.jira_key}
          </a>
        )}
      </div>
      {task.title !== task.slug && (
        <div className="mt-1 line-clamp-2 text-[19px] font-medium leading-snug">{task.title}</div>
      )}
      <div className="mt-2">
        <StageStrip task={task} />
      </div>
      <div className="mt-2 flex min-w-0 items-center gap-2 font-mono text-[15px] text-muted">
        {repoName && <span className="min-w-0 flex-1 truncate">{repoName}</span>}
        <span className="ml-auto shrink-0">{agoLabel(task.last_activity_at, now)}</span>
        <RefreshBriefButton task={task} />
      </div>
      {menuAt && <CardMenu task={task} at={menuAt} onClose={() => setMenuAt(null)} />}
    </div>
  );
}
