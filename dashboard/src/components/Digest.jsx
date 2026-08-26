import { useEffect, useState } from 'react';

import { renderBrief } from '../markdown.js';
import { agoLabel, stageColor } from '../meta.js';
import StageStrip from './StageStrip.jsx';

// The return-from-vacation surface: every active task's full brief on one
// scrollable page, most recently touched first.
export default function Digest({ jiraBase, onOpen }) {
  const [digest, setDigest] = useState(null);

  useEffect(() => {
    fetch('/api/digest').then((r) => r.json()).then(setDigest).catch(() => setDigest({ tasks: [], now: Date.now() }));
  }, []);

  if (!digest) {
    return <p className="p-8 text-center font-mono text-[16px] text-muted">loading digest…</p>;
  }

  return (
    <div className="mx-auto w-full max-w-4xl space-y-4 p-4">
      <p className="font-mono text-[15px] tracking-widest text-muted">
        DIGEST — {digest.tasks.length} ACTIVE TASK{digest.tasks.length === 1 ? '' : 'S'}, NEWEST ACTIVITY FIRST
      </p>
      {digest.tasks.map((t) => (
        <section key={t.id} className="rounded border border-line bg-surface"
          style={{ borderLeft: `4px solid ${stageColor(t.status)}` }}>
          <header className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3">
            <button onClick={() => onOpen(t)} className="font-mono text-[17px] font-semibold hover:text-accent">
              {t.slug}
            </button>
            {t.title !== t.slug && <span className="truncate text-[16px] text-muted">{t.title}</span>}
            <div className="ml-auto flex items-center gap-3">
              {t.jira_key && (
                <a href={`${jiraBase}${t.jira_key}`} target="_blank" rel="noreferrer"
                  className="rounded border border-line px-1.5 font-mono text-[15px] text-accent hover:border-accent">
                  {t.jira_key}
                </a>
              )}
              <span className="font-mono text-[15px] text-muted">{agoLabel(t.last_activity_at, digest.now)}</span>
            </div>
            <div className="w-full max-w-sm">
              <StageStrip task={t} />
            </div>
          </header>
          <div className="brief-md px-4 py-3"
            dangerouslySetInnerHTML={{ __html: renderBrief(t.brief) }} />
        </section>
      ))}
      {digest.tasks.length === 0 && (
        <p className="py-12 text-center font-mono text-[15px] text-muted">no active tasks — the board is clear</p>
      )}
    </div>
  );
}
