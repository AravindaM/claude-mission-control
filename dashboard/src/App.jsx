import { useEffect, useState } from 'react';
import { connect, useStore } from './store.js';
import Header from './components/Header.jsx';
import Board from './components/Board.jsx';
import Drawer from './components/Drawer.jsx';
import ArchiveRail from './components/ArchiveRail.jsx';
import Digest from './components/Digest.jsx';
import GithubBoard from './components/GithubBoard.jsx';

export default function App() {
  const { state, syncedAt, connected } = useStore();
  const [view, setView] = useState('board');
  const [openTaskId, setOpenTaskId] = useState(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => { connect(); }, []);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  if (!state) {
    return (
      <div className="flex h-full items-center justify-center font-mono text-[18px] tracking-[0.3em] text-muted">
        {connected === false ? 'SERVER UNREACHABLE — cmcctl status' : 'CONNECTING…'}
      </div>
    );
  }

  const openTask = openTaskId
    ? [...state.tasks, ...state.trash].find((t) => t.id === openTaskId)
    : null;

  return (
    <div className="flex h-full flex-col">
      <Header state={state} syncedAt={syncedAt} connected={connected} now={now} view={view} setView={setView} />
      <div className="flex min-h-0 flex-1">
        <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
          {view === 'board' && <Board state={state} onOpen={(t) => setOpenTaskId(t.id)} />}
          {view === 'github' && <GithubBoard state={state} now={now} />}
          {view === 'digest' && <Digest jiraBase={state.jiraBase} onOpen={(t) => setOpenTaskId(t.id)} />}
          {/* Trash is a toggle inside archive, not a view of its own. */}
          {view === 'archive' && (
            <ArchiveRail
              archived={state.tasks.filter((t) => t.archived)}
              trash={state.trash}
              now={now}
              onOpen={(t) => setOpenTaskId(t.id)} />
          )}
        </main>
        {openTask && (
          <Drawer task={openTask} now={now} jiraBase={state.jiraBase} onClose={() => setOpenTaskId(null)} />
        )}
      </div>
    </div>
  );
}
