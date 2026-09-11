import { applyGhResult, dueForRefresh, getPr } from './prs.js';

/**
 * Re-reads PR status from gh on a schedule.
 *
 * Serial, never parallel: N concurrent subprocesses is rude to the machine and
 * to the API, and this is background work with no deadline.
 */
export function createPrRefresher({ ctx, config, gh, onChange = () => {} }) {
  // The reconciler is setInterval with no overlap guard (index.js), which is
  // safe today only because reconcile() is synchronous and cannot still be
  // running when the timer next fires. This pass spawns subprocesses, so it
  // can be — a second pass starting mid-flight would double every lookup and
  // interleave writes to the same rows.
  //
  // The reset hangs off .finally, not the loop body: briefer.js records a live
  // incident where an empty queue resolved the flag before the outer assignment
  // landed, disabling the whole feature for the process lifetime.
  let running = null;

  async function refreshOne(id) {
    const row = getPr(ctx, id);
    if (!row) return null;
    const result = await gh.fetchPr(row.url);
    const after = applyGhResult(ctx, id, result);
    onChange();
    return after;
  }

  function sweep() {
    if (!running) {
      running = (async () => {
        const due = dueForRefresh(ctx, { refreshHours: config.prRefreshHours });
        for (const row of due) await refreshOne(row.id);
        return due.length;
      })().finally(() => { running = null; });
    }
    return running;
  }

  return {
    sweep,
    // On-demand "check it now". Works even when prRefreshHours is 0 —
    // disabling the schedule disables the schedule, not the feature.
    refreshOne,
    inFlight: () => running != null,
  };
}
