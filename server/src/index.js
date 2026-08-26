import { existsSync } from 'node:fs';
import { loadConfig } from './config.js';
import { createPaths } from './paths.js';
import { openDb } from './db.js';
import { reindex, migrateLegacyStatuses } from './taskstore.js';
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
  ingestSpool(ctx); // replay anything captured while the server was down
  writeBindings(ctx);

  const briefer = createBriefer({ ctx, config });
  const staticRoot = new URL('../../dashboard/dist', import.meta.url).pathname;
  const app = buildApp({
    ctx, config, briefer,
    staticRoot: existsSync(staticRoot) ? staticRoot : null,
  });

  const sweep = () => {
    try {
      reconcile({ ctx, config, briefer });
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
