import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const DEFAULTS = {
  port: 47613,
  claudeBin: 'claude', // installer writes the resolved absolute path to config.json
  briefModel: 'sonnet',
  // A routine refresh rewrites only ## Status: ~230 output tokens, ~10s measured,
  // against ~2,800 tokens and ~50s for a whole brief. That is what makes this
  // cadence affordable at all. Never set it exactly to the 5-minute reconcile
  // interval — a sweep firing a hair early fails the strict staleness comparison
  // and slips to the next one, halving the effective cadence.
  staleMinutes: 4,
  // How stale the STABLE half may get. About/Links/Decisions/Invariants used to
  // be rewritten only on a forced refresh or on archive, so a task worked for
  // days carried decisions from its first hour. This runs the full pass roughly
  // every 6th sweep. 28 rather than 30 for the reason above: a threshold that is
  // an exact multiple of the 5-minute tick sits on the same knife-edge.
  // 0 restores the old behaviour — forced refresh and archive only.
  aboutStaleMinutes: 28,
  injectCapBytes: 8192,
  unboundRetentionDays: 30,
  trashRetentionDays: 30,
  // Set this in ~/claude-tasks/.index/config.json to make Jira chips deep-link,
  // e.g. "https://your-org.atlassian.net/browse/". Empty means the key renders
  // as plain text rather than a link to nowhere.
  jiraBase: '',
  // Resolved to an absolute path by the installer, for the same reason claudeBin
  // is: the launchd agent does not inherit a login shell's PATH, so a bare `gh`
  // would work in every manual test and fail only under launchd.
  ghBin: 'gh',
  // Staleness threshold for the PR watchlist sweep. 0 disables the schedule; the
  // per-card refresh still works.
  prRefreshHours: 1,
  prMergedShown: 10,
};

export function loadConfig(env = process.env) {
  const dataDir = env.MC_DATA_DIR || join(homedir(), 'claude-tasks');
  let fileConfig = {};
  try {
    fileConfig = JSON.parse(readFileSync(join(dataDir, '.index', 'config.json'), 'utf8'));
  } catch {
    // No config file yet (pre-install / tests) — defaults apply.
  }
  const cfg = { ...DEFAULTS, ...fileConfig, dataDir };
  if (env.MC_PORT) cfg.port = Number(env.MC_PORT);
  return cfg;
}
