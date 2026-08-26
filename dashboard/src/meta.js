export const STAGES = [
  { key: 'explore', label: 'EXPL', col: 'prep' },
  { key: 'plan', label: 'PLAN', col: 'prep' },
  { key: 'development', label: 'DEV', col: 'build' },
  { key: 'review', label: 'REVW', col: 'verify' },
  { key: 'testing', label: 'TEST', col: 'verify' },
  { key: 'deploy', label: 'DEPL', col: 'ship' },
  { key: 'done', label: 'DONE', col: 'ship' },
];

export const COLUMNS = [
  { key: 'prep', label: 'PREP', color: 'var(--st-explore)' },
  { key: 'build', label: 'BUILD', color: 'var(--st-development)' },
  { key: 'verify', label: 'VERIFY', color: 'var(--st-testing)' },
  { key: 'ship', label: 'SHIP', color: 'var(--st-done)' },
];

export const columnOf = (status) => STAGES.find((s) => s.key === status)?.col ?? 'prep';
// Each stage has its own hue (CSS var, theme-aware) — used by the tile tint,
// left edge, and lit strip segment.
export const stageColor = (status) => `var(--st-${status})`;
export const tileBackground = (status) => `color-mix(in oklab, var(--surface) calc(100% - var(--tile-mix)), ${stageColor(status)} var(--tile-mix))`;

export function agoLabel(ts, now) {
  if (!ts) return '—';
  const m = Math.max(0, Math.floor((now - ts) / 60000));
  if (m < 1) return 'now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function sortCards(tasks) {
  return [...tasks].sort((a, b) =>
    (b.live_sessions > 0) - (a.live_sessions > 0)
    || (b.last_activity_at ?? 0) - (a.last_activity_at ?? 0)
    || (b.updated_at ?? 0) - (a.updated_at ?? 0));
}
