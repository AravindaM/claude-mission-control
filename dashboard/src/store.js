import { useSyncExternalStore } from 'react';
import { fetchState } from './api.js';

// Dumb-resync contract (spec §10): the SSE stream only says "changed";
// truth always comes from a wholesale GET /api/state.

const WATCHDOG_MS = 45_000;

let snapshot = { state: null, syncedAt: null, connected: false };
const listeners = new Set();
let dragging = false;
let pendingWhileDragging = false;
let lastMessageAt = 0;
let source = null;

function emit(patch) {
  snapshot = { ...snapshot, ...patch };
  for (const l of listeners) l();
}

export async function resync() {
  if (dragging) {
    pendingWhileDragging = true;
    return;
  }
  try {
    const state = await fetchState();
    emit({ state, syncedAt: Date.now(), connected: true });
  } catch {
    emit({ connected: false });
  }
}

export function setDragging(on) {
  dragging = on;
  if (!on && pendingWhileDragging) {
    pendingWhileDragging = false;
    resync();
  }
}

function openStream() {
  source?.close();
  source = new EventSource('/api/events');
  lastMessageAt = Date.now();
  source.onopen = () => resync();
  source.addEventListener('hb', () => { lastMessageAt = Date.now(); });
  source.addEventListener('changed', () => {
    lastMessageAt = Date.now();
    resync();
  });
  source.onerror = () => emit({ connected: false });
}

export function connect() {
  openStream();
  // EventSource half-dies silently after laptop sleep; a watchdog plus
  // wake/online listeners make staleness impossible to miss.
  setInterval(() => {
    if (Date.now() - lastMessageAt > WATCHDOG_MS) openStream();
  }, 10_000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') resync();
  });
  window.addEventListener('online', () => openStream());
  resync();
}

export function useStore() {
  return useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    () => snapshot,
  );
}
