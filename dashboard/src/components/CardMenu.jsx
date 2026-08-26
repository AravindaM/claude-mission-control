import { useEffect, useRef } from 'react';
import { STAGES } from '../meta.js';
import { patchTask, trashTask } from '../api.js';

export default function CardMenu({ task, at, onClose }) {
  const ref = useRef(null);

  useEffect(() => {
    const close = (e) => { if (!ref.current?.contains(e.target)) onClose(); };
    const esc = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    ref.current?.querySelector('button')?.focus();
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [onClose]);

  const pos = at.anchor
    ? at.anchor.getBoundingClientRect()
    : { left: at.x, top: at.y };

  const item = 'block w-full px-4 py-2 text-left text-[18px] hover:bg-raised';

  return (
    <div
      ref={ref}
      data-no-drag
      className="fixed z-50 w-60 rounded border border-line bg-surface py-1 shadow-lg"
      style={{ left: Math.min(pos.left, window.innerWidth - 190), top: Math.min(pos.top, window.innerHeight - 320) }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="px-3 py-1 font-mono text-[15px] tracking-widest text-muted">MOVE TO</div>
      {STAGES.map((s) => (
        <button key={s.key} className={item} disabled={s.key === task.status}
          onClick={() => { patchTask(task.id, { status: s.key }); onClose(); }}>
          {s.key}{s.key === task.status ? '  ●' : ''}
        </button>
      ))}
      <div className="my-1 border-t border-line" />
      <button className={item} onClick={() => { patchTask(task.id, { archived: true }); onClose(); }}>
        archive <span className="float-right font-mono text-[15px] text-muted">e</span>
      </button>
      <button className={`${item} text-danger`} onClick={() => { trashTask(task.id); onClose(); }}>
        trash <span className="float-right font-mono text-[15px] text-muted">#</span>
      </button>
    </div>
  );
}
