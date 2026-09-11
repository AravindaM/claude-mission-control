import { STAGES, stageColor } from '../meta.js';
import { patchTask } from '../api.js';

// Signature element: the full 8-stage lifecycle as a row of annunciator
// segments; the current stage is lit in its meta-column hue. Clicking a
// segment moves the task there.
export default function StageStrip({ task }) {
  return (
    <div className="flex min-w-0 gap-[3px]" role="radiogroup" aria-label="lifecycle stage">
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
            // The lit segment takes a larger share so its label still fits.
            // At eight equal segments a ~172px column gives each ~15px, and a
            // three-character label needs ~20px, so every label clipped.
            // min-w-0 lets a segment shrink below its own label. Without it a
            // button keeps min-width:auto, the strip refuses to compress, and
            // it overflows the card in any narrow column — true at seven
            // stages already, worse at eight.
            className={`mc-tip h-[22px] min-w-0 overflow-hidden rounded-[2px] border font-mono text-[11px] leading-none tracking-tight transition-colors
              ${active ? 'flex-[2.5]' : 'flex-1'}`}
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
