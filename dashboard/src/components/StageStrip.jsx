import { STAGES, stageColor } from '../meta.js';
import { patchTask } from '../api.js';

// Signature element: the full 8-stage lifecycle as a row of annunciator
// segments; the current stage is lit in its meta-column hue. Clicking a
// segment moves the task there.
export default function StageStrip({ task }) {
  return (
    <div className="flex gap-[3px]" role="radiogroup" aria-label="lifecycle stage">
      {STAGES.map((stage) => {
        const active = stage.key === task.status;
        return (
          <button
            key={stage.key}
            role="radio"
            aria-checked={active}
            data-tip={active ? `${stage.key} (current)` : `move to ${stage.key}`}
            data-no-drag
            onClick={(e) => { e.stopPropagation(); patchTask(task.id, { status: stage.key }); }}
            className="mc-tip h-[22px] flex-1 rounded-[2px] border font-mono text-[11px] leading-none tracking-tight transition-colors"
            style={active
              ? { background: stageColor(stage.key), borderColor: stageColor(stage.key), color: 'var(--bg)', fontWeight: 600 }
              : { background: 'var(--raised)', borderColor: 'var(--line)', color: 'var(--muted)' }}
          >
            {active ? stage.label : ''}
          </button>
        );
      })}
    </div>
  );
}
