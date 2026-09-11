import { useEffect, useRef, useState } from 'react';
import { draggable, dropTargetForElements, monitorForElements } from '@atlaskit/pragmatic-drag-and-drop/element/adapter';

import { PRIORITY_CAP, stageColor, stageLabel } from '../meta.js';
import { setPriority } from '../api.js';
import { setDragging } from '../store.js';

/**
 * The manually ordered stack, above the board.
 *
 * A horizontal strip rather than a vertical rail because the board's scarce axis
 * is width, not height: the drawer is a fixed 640px and the columns are
 * `flex-1 min-w-0`, so they absorb any new chrome by silently truncating card
 * titles. The columns run mostly empty vertically, so ~80px of height is the
 * cheap thing to spend. See docs/superpowers/specs/2026-09-09-priority-stack-design.md §3.
 */

/** Where a drop lands. Dropping on a chip inserts BEFORE it; the tail appends. */
function insertionIndex(dropTargets, stackLength) {
  for (const t of dropTargets) {
    if (t.data?.type === 'priority-slot') return t.data.index;
    if (t.data?.type === 'priority-tail') return stackLength;
  }
  return null;
}

function Chip({ task, index, rank, onOpen }) {
  const ref = useRef(null);
  const [over, setOver] = useState(false);
  const [lifted, setLifted] = useState(false);

  useEffect(() => {
    const el = ref.current;
    // A chip is both: draggable so it can be reordered, and a drop target so
    // something else can be dropped into its slot.
    const cleanUpDrag = draggable({
      element: el,
      getInitialData: () => ({ type: 'priority-chip', taskId: task.id, index }),
      onDragStart: () => { setDragging(true); setLifted(true); },
      onDrop: () => { setDragging(false); setLifted(false); },
    });
    const cleanUpDrop = dropTargetForElements({
      element: el,
      getData: () => ({ type: 'priority-slot', index }),
      onDragEnter: () => setOver(true),
      onDragLeave: () => setOver(false),
      onDrop: () => setOver(false),
    });
    return () => { cleanUpDrag(); cleanUpDrop(); };
  }, [task.id, index]);

  return (
    <div
      ref={ref}
      role="button"
      tabIndex={0}
      aria-label={`priority ${rank} ${task.slug}`}
      // A chip opens its task like a board tile does. Dragging never fires a
      // click, so the two gestures coexist the way they already do on Card.
      onClick={() => onOpen(task)}
      onKeyDown={(e) => e.key === 'Enter' && onOpen(task)}
      // Capped width so a long slug cannot crowd out the rest of the stack —
      // eight content-sized chips would overflow the strip at 1440px.
      className={`flex w-[210px] shrink-0 cursor-pointer items-center gap-2.5 rounded border bg-surface px-3 py-2.5
        hover:border-muted ${over ? 'border-accent' : 'border-line'} ${lifted ? 'opacity-40' : ''}`}
      style={{ borderLeft: `4px solid ${stageColor(task.status)}` }}
      title={task.title}
    >
      <span className="font-mono text-[20px] font-semibold leading-none text-accent">{rank}</span>
      <div className="min-w-0">
        <div className="truncate font-mono text-[15px]">{task.slug}</div>
        <div className="mt-0.5 flex items-center gap-1.5 font-mono text-[13px] text-muted">
          <span className={task.live_sessions > 0 ? 'text-done' : 'text-muted'}>
            {task.live_sessions > 0 ? '●' : '○'}
          </span>
          {stageLabel(task.status)}
        </div>
      </div>
    </div>
  );
}

export default function PriorityStrip({ state, onOpen }) {
  const tailRef = useRef(null);
  const [tailOver, setTailOver] = useState(false);
  // Optimistic order, cleared once the write lands (or is rejected). Without it
  // the strip visibly snaps back before the SSE round trip returns.
  const [pending, setPending] = useState(null);

  const byId = new Map(state.tasks.map((t) => [t.id, t]));
  const ranked = state.tasks
    .filter((t) => t.priority != null && !t.archived)
    .sort((a, b) => a.priority - b.priority);
  const stack = (pending ? pending.map((id) => byId.get(id)).filter(Boolean) : ranked);
  const full = stack.length >= PRIORITY_CAP;

  useEffect(() => {
    const el = tailRef.current;
    if (!el) return undefined;
    return dropTargetForElements({
      element: el,
      getData: () => ({ type: 'priority-tail' }),
      onDragEnter: () => setTailOver(true),
      onDragLeave: () => setTailOver(false),
      onDrop: () => setTailOver(false),
    });
  }, []);

  // The monitor is an event handler, not a subscription: it needs the CURRENT
  // stack at drop time, but re-registering it on every reorder would tear down
  // and rebuild a listener mid-gesture. A latest-ref gives it fresh data from a
  // listener registered once.
  // Written in an effect, not during render: the drop handler only ever reads
  // it after a commit, so there is no render that needs it.
  const stackRef = useRef(stack);
  useEffect(() => { stackRef.current = stack; });

  useEffect(() => monitorForElements({
    canMonitor: ({ source }) => ['card', 'priority-chip'].includes(source.data.type),
    onDrop: ({ source, location }) => {
      const stack = stackRef.current;
      const at = insertionIndex(location.current.dropTargets, stack.length);
      const ids = stack.map((t) => t.id);
      const taskId = source.data.taskId;

      // Dropped somewhere that is not the strip. A chip dragged out of the strip
      // is a removal; a card dropped on a column is the board's business.
      if (at == null) {
        if (source.data.type !== 'priority-chip') return;
        const next = ids.filter((id) => id !== taskId);
        setPending(next);
        setPriority(next).catch(() => {}).finally(() => setPending(null));
        return;
      }

      const from = ids.indexOf(taskId);
      const without = ids.filter((id) => id !== taskId);
      // Removing the dragged chip shifts every later slot down by one.
      const target = from !== -1 && from < at ? at - 1 : at;
      if (from === -1 && without.length >= PRIORITY_CAP) return; // at the cap
      const next = [...without.slice(0, target), taskId, ...without.slice(target)];
      if (next.join() === ids.join()) return; // no-op drop, skip the write
      setPending(next);
      setPriority(next).catch(() => {}).finally(() => setPending(null));
    },
  }), []);

  return (
    <section
      aria-label="priority stack"
      className="flex shrink-0 items-stretch gap-3 border-b border-accent/40 px-3 py-3"
      style={{ background: 'color-mix(in oklab, var(--surface) 92%, var(--accent) 8%)' }}
    >
      <div className="flex shrink-0 flex-col justify-center pr-1">
        <h2 className="font-mono text-[14px] font-semibold tracking-[0.18em] text-accent">PRIORITY</h2>
        <span className="font-mono text-[13px] text-muted">{stack.length} of {PRIORITY_CAP}</span>
      </div>

      <div className="flex min-w-0 flex-1 items-stretch gap-2.5 overflow-x-auto">
        {stack.map((task, i) => (
          <Chip key={task.id} task={task} index={i} rank={i + 1} onOpen={onOpen} />
        ))}
        {/* Always present, even when the stack is empty: a drop zone that hid
            when empty could never be populated, and an empty stack is a real
            state worth stating rather than a gap.
            Given a generous minimum width — this is the target you aim a card
            at, and a thin sliver at the end of a row is a fiddly thing to hit. */}
        <div
          ref={tailRef}
          className={`flex min-w-[190px] shrink-0 items-center justify-center rounded border-2 border-dashed px-4
            text-center font-mono text-[13px]
            ${tailOver ? 'border-accent bg-accent/10 text-accent' : 'border-line text-muted'}
            ${full ? 'opacity-50' : ''}`}
        >
          {full
            ? `full — ${PRIORITY_CAP} max`
            : (stack.length === 0 ? 'drag a card here to prioritise' : '+ drop here')}
        </div>
      </div>
    </section>
  );
}
