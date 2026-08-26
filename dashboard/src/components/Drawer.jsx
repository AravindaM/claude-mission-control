import { useEffect, useRef, useState } from 'react';

import { renderBrief, renderInline } from '../markdown.js';
import { fetchBrief, fetchSessions, fetchEvents, patchTask, trashTask, refreshBrief } from '../api.js';
import { agoLabel, stageColor } from '../meta.js';
import StageStrip from './StageStrip.jsx';

function Field({ label, value, onSave }) {
  const [v, setV] = useState(value ?? '');
  useEffect(() => setV(value ?? ''), [value]);
  return (
    <label className="block">
      <span className="font-mono text-[15px] tracking-widest text-muted">{label}</span>
      <input
        value={v}
        onChange={(e) => setV(e.target.value)}
        onBlur={() => v !== (value ?? '') && onSave(v)}
        onKeyDown={(e) => e.key === 'Enter' && e.target.blur()}
        className="mt-0.5 w-full rounded border border-line bg-raised px-2 py-1 text-[18px]"
      />
    </label>
  );
}

function SectionLabel({ children, action }) {
  return (
    <div className="mb-1 flex items-baseline gap-2">
      <h3 className="font-mono text-[15px] tracking-widest text-muted">{children}</h3>
      {action}
    </div>
  );
}

/**
 * What an empty field says. Every panel is always present, so each one has to
 * account for itself — "none recorded" is a fact, a vanished panel is not.
 */
function Empty({ children }) {
  return <p className="font-mono text-[15px] text-muted">{children}</p>;
}

/** One readout cell: a mono caption over its value. */
function Cell({ label, children, wide = false }) {
  return (
    <div className={wide ? 'col-span-3 min-w-0' : 'min-w-0'}>
      <div className="font-mono text-[13px] tracking-widest text-muted">{label}</div>
      <div className="truncate font-mono text-[16px]">{children}</div>
    </div>
  );
}

function MetaReadout({ task, sessions, now, jiraBase }) {
  const live = task.live_sessions > 0;
  const branch = sessions.find((s) => s.git_branch)?.git_branch;
  return (
    <section className="rounded border border-line bg-bg/40 p-3" aria-label="task metadata">
      <div className="grid grid-cols-3 gap-x-3 gap-y-2">
        {/* These three always have a value, so they hold the shape of the panel. */}
        <Cell label="STAGE">
          <span className="inline-block size-2 rounded-[1px] align-middle"
            style={{ background: stageColor(task.status) }} />
          <span className="ml-1.5 align-middle">{task.status}</span>
        </Cell>
        <Cell label="ACTIVE">
          <span className={live ? 'text-done' : 'text-muted'}>{live ? '●' : '○'}</span>
          <span className="ml-1.5">{live ? `${task.live_sessions} live` : 'idle'}</span>
        </Cell>
        <Cell label="LAST ACTIVITY">{agoLabel(task.last_activity_at, now)}</Cell>

        {/* These are often genuinely unset. A row of em-dashes reads like the
            panel is broken, so an absent value simply takes no space. */}
        {task.jira_key && (
          <Cell label="JIRA">
            <a href={`${jiraBase}${task.jira_key}`} target="_blank" rel="noopener noreferrer"
              className="text-accent underline">
              {task.jira_key}
            </a>
          </Cell>
        )}
        {branch && <Cell label="BRANCH">{branch}</Cell>}
        {task.repo_path && (
          <Cell label="REPO">
            <span title={task.repo_path}>{task.repo_path.replace(/^\/Users\/[^/]+/, '~')}</span>
          </Cell>
        )}

        <Cell label="RESUME" wide>
          <span className="text-accent">cmc resume {task.slug}</span>
        </Cell>
      </div>
    </section>
  );
}

/**
 * Links and Invariants are both "a list of things, each possibly long". Real Links
 * entries run to whole paragraphs with embedded anchors, so they get list rows
 * rather than chips — the content decides the container, not the other way round.
 */
function BulletList({ items }) {
  return (
    <ul className="space-y-1">
      {items.map((item, i) => (
        <li key={i} className="flex gap-2 text-[17px] leading-snug">
          <span className="shrink-0 text-muted">·</span>
          <span className="brief-row min-w-0" dangerouslySetInnerHTML={{ __html: renderInline(item) }} />
        </li>
      ))}
    </ul>
  );
}

/**
 * A decision's claim gets its own line at full contrast; the reason sits under it,
 * muted and indented. Joined by an em-dash they were one wrapped blob and you
 * could not skim only the claims — which is what you want nine times in ten.
 */
function DecisionList({ items }) {
  return (
    <ul className="space-y-2.5">
      {items.map((d, i) => (
        <li key={i}>
          <div className="brief-row text-[17px] font-medium leading-snug"
            dangerouslySetInnerHTML={{ __html: renderInline(d.claim) }} />
          {d.why && (
            <div className="brief-row mt-0.5 border-l-2 border-line pl-2 text-[15px] leading-snug text-muted"
              dangerouslySetInnerHTML={{ __html: renderInline(d.why) }} />
          )}
        </li>
      ))}
    </ul>
  );
}

/** `In scope` / `Out of scope` / `Commands` — a label over its own short bullets. */
function Groups({ groups }) {
  if (!groups?.length) return null;
  return (
    <div className="mt-2 space-y-2">
      {groups.map((g) => (
        <div key={g.label}>
          <div className="font-mono text-[13px] tracking-widest text-muted">{g.label.toUpperCase()}</div>
          <BulletList items={g.items} />
        </div>
      ))}
    </div>
  );
}

/** Now / Next / Blockers, or Scope / Out of scope — labels aligned in a column. */
function Rows({ fields }) {
  if (!fields?.length) return null;
  return (
    <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
      {fields.map((f) => (
        <div key={f.label} className="contents">
          <dt className="font-mono text-[15px] tracking-widest text-muted">{f.label.toUpperCase()}</dt>
          <dd className="min-w-0 text-[17px] leading-snug"
            dangerouslySetInnerHTML={{ __html: renderInline(f.value) }} />
        </div>
      ))}
    </dl>
  );
}

function RefreshButton({ task, about = false, tip, disabled = false, children }) {
  const [pending, setPending] = useState(false);
  const stamp = useRef(task.updated_at);

  useEffect(() => {
    if (pending && task.updated_at !== stamp.current) setPending(false);
  }, [task.updated_at, pending]);

  return (
    <button
      className="mc-tip ml-auto shrink-0 rounded border border-line px-1.5 font-mono text-[14px] text-muted hover:border-accent hover:text-accent disabled:opacity-40 disabled:hover:border-line disabled:hover:text-muted"
      // A brief is distilled from a transcript, so with no session there is
      // nothing to distil — better to say so than to accept the click and do
      // nothing, which is what the endpoint would return.
      data-tip={pending ? 'regenerating…' : (disabled ? 'no session recorded for this task yet' : tip)}
      disabled={pending || disabled}
      onClick={async () => {
        stamp.current = task.updated_at;
        const res = await refreshBrief(task.id, { about }).catch(() => ({ queued: false }));
        if (res.queued) {
          setPending(true);
          setTimeout(() => setPending(false), 120_000); // failure safety valve
        }
      }}
    >
      {pending ? '…' : children}
    </button>
  );
}

export default function Drawer({ task, now, jiraBase, onClose }) {
  const [brief, setBrief] = useState(null);
  const [raw, setRaw] = useState(false);
  const [sessions, setSessions] = useState([]);
  const [events, setEvents] = useState([]);
  const [allEvents, setAllEvents] = useState(false);

  useEffect(() => {
    fetchBrief(task.id).then(setBrief).catch(() => setBrief({ body: '_brief unavailable_' }));
    fetchSessions(task.id).then(setSessions).catch(() => {});
    fetchEvents(task.id, allEvents ? 500 : 30, allEvents).then(setEvents).catch(() => {});
  }, [task.id, task.updated_at, allEvents]);

  useEffect(() => {
    const esc = (e) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [onClose]);

  const s = brief?.sections;
  // Every field always gets a panel, empty or not: a missing section is
  // information ("nobody has written the scope yet"), and a panel that vanishes
  // when empty makes the drawer a different shape for every task.
  //
  // The exception is content the splitter could not place — an old ## Goal brief,
  // or a hand-written one. That still has to be shown somewhere, or the panel
  // would silently hide the only thing the task has.
  const placeholder = !s || (!s.about.text && !s.about.groups?.length
    && !s.status.text && !s.status.fields.length
    && !s.decisions.items.length && !s.invariants?.items.length && !s.links.items.length);
  const stray = placeholder && brief?.body && !/_No brief yet\._/.test(brief.body)
    ? brief.body
    : null;
  // Briefs are distilled from transcripts; with no session there is nothing to
  // distil, so the refresh controls say so instead of accepting a dead click.
  const noSession = sessions.length === 0;

  return (
    <aside className="flex w-[640px] shrink-0 flex-col border-l border-line bg-surface" aria-label="task detail">
      <header className="flex items-start gap-2 border-b border-line p-4">
        <div className="min-w-0">
          {/* Auto-named tasks often have title === slug, and printing the same
              string twice is the first thing you see. */}
          {task.title.toLowerCase() !== task.slug.toLowerCase() && (
            <div className="font-mono text-[16px] text-muted">{task.slug}</div>
          )}
          <h2 className="text-[22px] font-semibold leading-tight">{task.title}</h2>
        </div>
        <button onClick={onClose} aria-label="close"
          className="ml-auto rounded border border-line px-2 py-0.5 font-mono text-[16px] text-muted hover:border-muted">
          esc
        </button>
      </header>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        <MetaReadout task={task} sessions={sessions} now={now} jiraBase={jiraBase} />
        <StageStrip task={task} />

        {!raw && (
          <>
            {/* Status is the lit panel: it is the section that changes constantly,
                and the question the drawer is opened to answer. */}
            <section className="rounded border border-line bg-raised/60 p-3"
              style={{ borderLeft: `3px solid ${stageColor(task.status)}` }}>
              <SectionLabel action={<RefreshButton task={task} disabled={noSession} tip="refresh status from latest sessions">↻</RefreshButton>}>
                STATUS
              </SectionLabel>
              {/* Rows first: Now/Next/Blockers/Branch/PRs is the reason the panel
                  exists, and it used to sit under 66-91 words of narrative. */}
              <Rows fields={s?.status.fields} />
              {s?.status.text && (
                <div className="brief-md mt-2 border-t border-line pt-2 text-[17px]"
                  dangerouslySetInnerHTML={{ __html: renderBrief(s.status.text) }} />
              )}
              {!s?.status.text && !s?.status.fields.length && (
                <Empty>{noSession
                    ? 'no session yet — run cmc resume, or /task in a terminal'
                    : 'no status yet — press ↻ to write one from the session'}</Empty>
              )}
            </section>

            {/* Links sit directly under Status: together they answer "where is
                this, and where do I go next" — the two reasons to open a task. */}
            <section>
              <SectionLabel>LINKS</SectionLabel>
              {s?.links.items.length
                ? <BulletList items={s.links.items} />
                : <Empty>none recorded</Empty>}
            </section>

            <section>
              <SectionLabel
                action={<RefreshButton task={task} about disabled={noSession} tip="rewrite scope, decisions and links">↻ rewrite</RefreshButton>}>
                ABOUT
              </SectionLabel>
              {s?.about.text
                ? <div className="brief-md" dangerouslySetInnerHTML={{ __html: renderBrief(s.about.text) }} />
                : <Empty>{noSession ? 'nothing to summarise yet' : 'no scope written yet — press ↻ rewrite'}</Empty>}
              <Rows fields={s?.about.fields} />
              <Groups groups={s?.about.groups} />
            </section>

            <section>
              <SectionLabel>DECISIONS</SectionLabel>
              {s?.decisions.items.length
                ? <DecisionList items={s.decisions.items} />
                : <Empty>none recorded</Empty>}
            </section>

            {/* Invariants carry no reason by design — they are things you might
                break by accident, not choices you would argue with. */}
            <section>
              <SectionLabel>INVARIANTS</SectionLabel>
              {s?.invariants?.items.length
                ? <BulletList items={s.invariants.items} />
                : <Empty>none recorded</Empty>}
            </section>

            {/* Content the splitter could not place — an old ## Goal brief, or one
                written by hand. Shown rather than hidden behind the raw toggle. */}
            {stray && (
              <section>
                <SectionLabel
                  action={<RefreshButton task={task} about tip="convert to the current format">↻ convert</RefreshButton>}>
                  UNSTRUCTURED
                </SectionLabel>
                <div className="brief-md rounded border border-line p-3"
                  dangerouslySetInnerHTML={{ __html: renderBrief(stray) }} />
              </section>
            )}
          </>
        )}

        {raw && (
          <div className="brief-md rounded border border-line p-4"
            dangerouslySetInnerHTML={{ __html: renderBrief(brief?.body) }} />
        )}

        <button onClick={() => setRaw(!raw)} className="font-mono text-[15px] text-muted hover:text-accent">
          {raw ? '← back to fields' : 'view raw markdown'}
        </button>

        <section>
          <SectionLabel>SESSIONS ({sessions.length})</SectionLabel>
          <ul className="space-y-1">
            {sessions.map((sess) => (
              <li key={sess.session_uuid} className="flex gap-2 font-mono text-[16px]">
                <span className={sess.ended_at ? 'text-muted' : 'text-done'}>{sess.ended_at ? '○' : '●'}</span>
                <span className="truncate text-muted">{sess.session_uuid.slice(0, 8)}</span>
                <span className="truncate">{sess.git_branch}</span>
                <span className="ml-auto shrink-0 text-muted">{agoLabel(sess.last_activity_at, now)}</span>
              </li>
            ))}
          </ul>
        </section>

        <section>
          <SectionLabel>TIMELINE</SectionLabel>
          <ul className="space-y-0.5">
            {events.map((e) => (
              <li key={e.id} className="flex gap-2 font-mono text-[16px] text-muted">
                <span className="shrink-0">{new Date(e.created_at).toLocaleString()}</span>
                <span className="truncate text-ink">{e.type}</span>
              </li>
            ))}
          </ul>
          {/* Always offered: the default view hides brief saves, so their absence
              is not something the event count can tell you. */}
          <button onClick={() => setAllEvents(!allEvents)}
            className="mt-1 font-mono text-[15px] text-muted hover:text-accent">
            {allEvents ? '← hide brief saves' : 'show every event'}
          </button>
        </section>

        <section className="border-t border-line pt-3">
          <SectionLabel>EDIT</SectionLabel>
          <div className="grid grid-cols-2 gap-2">
            <Field label="TITLE" value={task.title} onSave={(v) => patchTask(task.id, { title: v })} />
            <Field label="JIRA" value={task.jira_key} onSave={(v) => patchTask(task.id, { jira_key: v || null })} />
            <div className="col-span-2">
              <Field label="REPO" value={task.repo_path} onSave={(v) => patchTask(task.id, { repo_path: v || null })} />
            </div>
          </div>
        </section>
      </div>

      <footer className="flex gap-2 border-t border-line p-4">
        <button onClick={() => { patchTask(task.id, { archived: !task.archived }); onClose(); }}
          className="rounded border border-line px-3 py-1 text-[18px] hover:border-muted">
          {task.archived ? 'unarchive' : 'archive'}
        </button>
        <button onClick={() => { trashTask(task.id); onClose(); }}
          className="ml-auto rounded border border-line px-3 py-1 text-[18px] text-danger hover:border-danger">
          trash
        </button>
      </footer>
    </aside>
  );
}
