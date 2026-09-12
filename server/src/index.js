import { existsSync } from 'node:fs';
import { loadConfig } from './config.js';
import { createPaths } from './paths.js';
import { openDb } from './db.js';
import { reindex, migrateLegacyStatuses } from './taskstore.js';
import { reindexPrs } from './prs.js';
import { createGh } from './gh.js';
import { createPrRefresher } from './prrefresher.js';
import { ingestSpool, writeBindings } from './spool.js';
import { buildApp } from './api.js';
import { createBriefer } from './briefer.js';
import { reconcile } from './reconciler.js';

const RECONCILE_INTERVAL_MS = 5 * 60 * 1000;

async function main() {
  const config = loadConfig();
  const paths = createPaths(config.dataDir);
  paths.ensureBaseDirs();
  const db = openDb(paths.dbFile());
  const ctx = { db, paths };

  migrateLegacyStatuses(ctx);
  reindex(ctx); // DB is disposable; files win
  reindexPrs(ctx); // same contract: the watchlist lives in _prs/, not the DB
  ingestSpool(ctx); // replay anything captured while the server was down
  writeBindings(ctx);

  const briefer = createBriefer({ ctx, config });
  const gh = createGh({ config });
  // onChange broadcasts because the sweep is the one writer the user never
  // triggers, so it is the one that most needs to push to an open dashboard.
  const prRefresher = createPrRefresher({
    ctx, config, gh, onChange: () => app.mcBroadcast(),
  });
  const staticRoot = new URL('../../dashboard/dist', import.meta.url).pathname;
  const app = buildApp({
    ctx, config, briefer, prRefresher,
    staticRoot: existsSync(staticRoot) ? staticRoot : null,
  });

  const sweep = () => {
    try {
      reconcile({ ctx, config, briefer });
      // Guarded against overlap inside the refresher: this pass spawns
      // subprocesses, so unlike reconcile() it can still be running when the
      // timer next fires.
      prRefresher.sweep().catch((err) => console.error('pr refresh failed:', err));
      app.mcBroadcast();
    } catch (err) {
      console.error('reconcile failed:', err);
    }
  };
  sweep();
  setInterval(sweep, RECONCILE_INTERVAL_MS);

  // launchd KeepAlive can restart us into a lingering old process; retry the bind.
  for (let attempt = 1; ; attempt++) {
    try {
      await app.listen({ port: config.port, host: '127.0.0.1' });
      break;
    } catch (err) {
      if (err.code !== 'EADDRINUSE' || attempt >= 10) throw err;
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
  console.log(`mission-control listening on http://127.0.0.1:${config.port}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
