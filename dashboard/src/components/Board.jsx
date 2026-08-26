import { useEffect, useRef, useState } from 'react';
import { dropTargetForElements, monitorForElements } from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
import { COLUMNS, STAGES, columnOf, sortCards } from '../meta.js';
import { patchTask, trashTask } from '../api.js';
import { setDragging } from '../store.js';
import Card from './Card.jsx';

// Dropping on a meta-column lands on its FIRST stage unless the task is
// already inside that column (then its exact stage is kept).
function statusForDrop(task, columnKey) {
  if (columnOf(task.status) === columnKey) return task.status;
  return STAGES.find((s) => s.col === columnKey).key;
}

function Column({ column, tasks, now, jiraBase, onOpen }) {
  const ref = useRef(null);
  const [over, setOver] = useState(false);

  useEffect(() => dropTargetForElements({
    element: ref.current,
    getData: () => ({ type: 'column', column: column.key }),
    onDragEnter: () => setOver(true),
    onDragLeave: () => setOver(false),
    onDrop: () => setOver(false),
  }), [column.key]);

  return (
    <section ref={ref} aria-label={`${column.label} column`}
      className={`flex min-w-0 flex-1 flex-col rounded border bg-surface/40 ${over ? 'border-accent' : 'border-line'}`}>
      <header className="flex items-center gap-2 border-b border-line px-4 py-3">
        <span className="size-[12px] rounded-[2px]" style={{ background: column.color }} />
        <h2 className="font-mono text-[16px] font-semibold tracking-[0.2em]">{column.label}</h2>
        <span className="ml-auto font-mono text-[16px] text-muted">{tasks.length}</span>
      </header>
      <div className="flex flex-col gap-3 overflow-y-auto p-3">
        {tasks.length === 0 && (
          <p className="px-1 py-3 text-center font-mono text-[15px] text-muted">no tasks — drop one here</p>
        )}
        {tasks.map((t) => <Card key={t.id} task={t} now={now} jiraBase={jiraBase} onOpen={onOpen} />)}
      </div>
    </section>
  );
}

function DropBar({ visible }) {
  const archiveRef = useRef(null);
  const trashRef = useRef(null);

  useEffect(() => {
    if (!visible) return undefined;
    const cleanups = [
      dropTargetForElements({ element: archiveRef.current, getData: () => ({ type: 'archive' }) }),
      dropTargetForElements({ element: trashRef.current, getData: () => ({ type: 'trash' }) }),
    ];
    return () => cleanups.forEach((fn) => fn());
  }, [visible]);

  if (!visible) return null;
  return (
    <div className="fixed inset-x-0 bottom-0 z-40 flex h-32 gap-4 border-t border-line bg-bg/95 p-3">
      <div ref={archiveRef}
        className="flex flex-1 items-center justify-center rounded border-2 border-dashed border-muted font-mono text-2xl tracking-[0.25em] text-muted">
        ARCHIVE
      </div>
      <div ref={trashRef}
        className="flex flex-1 items-center justify-center rounded border-2 border-dashed border-danger font-mono text-2xl tracking-[0.25em] text-danger">
        TRASH
      </div>
    </div>
  );
}

export default function Board({ state, onOpen }) {
  const [dragActive, setDragActive] = useState(false);
  const tasksById = new Map(state.tasks.map((t) => [t.id, t]));

  useEffect(() => monitorForElements({
    canMonitor: ({ source }) => source.data.type === 'card',
    onDragStart: () => { setDragging(true); setDragActive(true); },
    onDrop: ({ source, location }) => {
      setDragging(false);
      setDragActive(false);
      const target = location.current.dropTargets[0]?.data;
      const task = tasksById.get(source.data.taskId);
      if (!target || !task) return;
      if (target.type === 'column') patchTask(task.id, { status: statusForDrop(task, target.column) });
      else if (target.type === 'archive') patchTask(task.id, { archived: true });
      else if (target.type === 'trash') trashTask(task.id);
    },
  }), [state]);

  const active = state.tasks.filter((t) => !t.archived);
  return (
    <>
      <div className="flex min-h-0 flex-1 gap-3 p-3">
        {COLUMNS.map((col) => (
          <Column key={col.key} column={col} now={state.now}
            jiraBase={state.jiraBase} onOpen={onOpen}
            tasks={sortCards(active.filter((t) => columnOf(t.status) === col.key))} />
        ))}
      </div>
      <DropBar visible={dragActive} />
    </>
  );
}
