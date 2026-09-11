import { useState } from 'react';
import { patchTask, restoreTrash } from '../api.js';
import { agoLabel } from '../meta.js';

/**
 * Archive, with trash as a filter rather than a sibling tab.
 *
 * Both answer the same question — "what did I put away" — and trash is the
 * rarer half, so a permanent top-level slot for it cost more than it returned.
 * The toggle keeps it one click from where you already are.
 */
export default function ArchiveRail({ archived, trash, now, onOpen }) {
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState('archive');
  const tasks = mode === 'trash' ? trash : archived;
  const filtered = tasks.filter((t) =>
    (t.slug + ' ' + t.title + ' ' + (t.jira_key ?? '')).toLowerCase().includes(query.toLowerCase()));

  return (
    <div className="mx-auto w-full max-w-3xl p-4">
      <div className="mb-3 flex items-center gap-3">
        <h2 className="font-mono text-[18px] font-semibold tracking-[0.25em] text-muted">
          {mode === 'trash' ? 'TRASH' : 'ARCHIVE'} ({filtered.length})
        </h2>
        <button
          onClick={() => setMode(mode === 'trash' ? 'archive' : 'trash')}
          aria-label={mode === 'trash' ? 'back to archive' : 'view trash'}
          // The count rides on the control so a non-empty trash is visible
          // without opening it — otherwise folding the tab away would hide
          // that anything is in there at all.
          className={`mc-tip rounded border px-2 py-0.5 font-mono text-[15px]
            ${mode === 'trash' ? 'border-danger text-danger' : 'border-line text-muted hover:border-muted hover:text-ink'}`}
          data-tip={mode === 'trash' ? 'back to archive' : 'view trash'}
        >
          {mode === 'trash' ? '← archive' : `🗑 trash${trash.length ? ` (${trash.length})` : ''}`}
        </button>
        <input
          placeholder="filter…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="ml-auto w-56 rounded border border-line bg-surface px-2 py-1 text-[18px]"
        />
      </div>
      {filtered.length === 0 && (
        <p className="py-8 text-center font-mono text-[16px] text-muted">
          {mode === 'trash' ? 'trash is empty — deleted tasks purge after 30 days' : 'nothing archived yet'}
        </p>
      )}
      <ul className="divide-y divide-line rounded border border-line bg-surface">
        {filtered.map((t) => (
          <li key={t.id} className="flex items-center gap-3 px-3 py-2">
            <button onClick={() => onOpen(t)} className="min-w-0 flex-1 text-left">
              <span className="block truncate font-mono text-[16px] text-muted">{t.slug}</span>
              <span className="block truncate text-[19px]">{t.title}</span>
            </button>
            <span className="font-mono text-[15px] text-muted">{agoLabel(t.updated_at, now)}</span>
            {mode === 'trash' ? (
              <button onClick={() => restoreTrash(t.id)}
                className="rounded border border-line px-2 py-0.5 text-[16px] hover:border-muted">restore</button>
            ) : (
              <button onClick={() => patchTask(t.id, { archived: false })}
                className="rounded border border-line px-2 py-0.5 text-[16px] hover:border-muted"
                title={`restore to ${t.status_before_archive ?? t.status}`}>
                restore to {t.status_before_archive ?? t.status}
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
