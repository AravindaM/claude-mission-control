import { useState } from 'react';
import { agoLabel } from '../meta.js';
import { bindSession, createTask } from '../api.js';

const THEME_CYCLE = ['auto', 'light', 'dark'];

function applyTheme(mode) {
  if (mode === 'auto') {
    delete document.documentElement.dataset.theme;
    localStorage.removeItem('mc-theme');
  } else {
    document.documentElement.dataset.theme = mode;
    localStorage.setItem('mc-theme', mode);
  }
}

function ThemeToggle() {
  const [mode, setMode] = useState(localStorage.getItem('mc-theme') ?? 'auto');
  return (
    <button
      onClick={() => {
        const next = THEME_CYCLE[(THEME_CYCLE.indexOf(mode) + 1) % THEME_CYCLE.length];
        applyTheme(next);
        setMode(next);
      }}
      title="cycle theme: auto → light → dark"
      className="rounded border border-line px-2 py-0.5 font-mono text-[15px] uppercase tracking-widest text-muted hover:border-muted hover:text-ink"
    >
      {mode}
    </button>
  );
}

function TrayPopover({ unassigned, tasks, onClose }) {
  return (
    <div className="absolute right-0 top-full z-50 mt-1 w-[560px] rounded border border-line bg-surface p-2 shadow-lg">
      <div className="mb-1 font-mono text-[15px] tracking-widest text-muted">UNMATCHED SESSIONS</div>
      {unassigned.map((s) => (
        <div key={s.session_uuid} className="flex items-center gap-2 border-t border-line py-1.5 font-mono text-[16px]">
          <span className="text-muted">{s.session_uuid.slice(0, 8)}</span>
          <span className="truncate">{(s.repo_toplevel || s.cwd || '').split('/').pop()}</span>
          <select
            defaultValue=""
            className="ml-auto w-36 rounded border border-line bg-raised px-1 py-0.5 text-[16px]"
            onChange={async (e) => {
              if (e.target.value === '__new__') {
                const title = window.prompt('New task title:');
                if (title) {
                  const task = await createTask({ title, repoPath: s.repo_toplevel || s.cwd });
                  await bindSession(s.session_uuid, { taskId: task.id });
                }
              } else if (e.target.value) {
                await bindSession(s.session_uuid, { taskId: Number(e.target.value) });
              }
              onClose();
            }}
          >
            <option value="" disabled>attach to…</option>
            {tasks.filter((t) => !t.archived).map((t) => (
              <option key={t.id} value={t.id}>{t.slug}</option>
            ))}
            <option value="__new__">+ new task from session</option>
          </select>
        </div>
      ))}
    </div>
  );
}

export default function Header({ state, syncedAt, connected, now, view, setView }) {
  const [trayOpen, setTrayOpen] = useState(false);
  const unassigned = state?.unassigned ?? [];
  const banners = state?.banners ?? [];

  return (
    <header className="border-b border-line bg-surface">
      <div className="flex items-center gap-4 px-4 py-2">
        <h1 className="font-mono text-[19px] font-semibold tracking-[0.3em] text-accent">MISSION CONTROL</h1>

        <nav className="flex gap-1 font-mono text-[16px]">
          {['board', 'digest', 'archive', 'trash'].map((v) => (
            <button key={v} onClick={() => setView(v)}
              className={`rounded px-2 py-0.5 uppercase tracking-widest ${view === v ? 'bg-raised text-ink' : 'text-muted hover:text-ink'}`}>
              {v}
            </button>
          ))}
        </nav>

        <div className="relative ml-auto flex items-center gap-3">
          {unassigned.length > 0 && (
            <button onClick={() => setTrayOpen(!trayOpen)}
              className="rounded border border-accent px-2 py-0.5 font-mono text-[16px] text-accent">
              {unassigned.length} unmatched session{unassigned.length > 1 ? 's' : ''}
            </button>
          )}
          {trayOpen && unassigned.length > 0 && (
            <TrayPopover unassigned={unassigned} tasks={state?.tasks ?? []} onClose={() => setTrayOpen(false)} />
          )}
          <span className={`font-mono text-[16px] ${connected ? 'text-muted' : 'font-semibold text-danger'}`}
            title="dashboard sync status">
            {connected ? `synced ${agoLabel(syncedAt, now)}` : 'DISCONNECTED'}
          </span>
          <ThemeToggle />
        </div>
      </div>

      {banners.map((b) => (
        <div key={b.id} className="border-t border-danger/40 bg-danger/10 px-4 py-1 font-mono text-[16px] text-danger">
          {b.type === 'brief_failed'
            ? `brief generation failed for ${b.slug ?? 'a task'} (${new Date(b.created_at).toLocaleTimeString()}) — retrying automatically; details in the task timeline`
            : `claude binary unreachable (${new Date(b.created_at).toLocaleTimeString()}) — auto-briefs are down, run: cmcctl logs`}
        </div>
      ))}
    </header>
  );
}
