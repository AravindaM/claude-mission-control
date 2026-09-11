import { spawn as nodeSpawn } from 'node:child_process';

// gh can hang on a network black hole. In a serial queue one hung child stalls
// every refresh queued behind it, so every spawn is bounded.
const TIMEOUT_MS = 10_000;

const FIELDS = 'number,title,author,state,isDraft,reviewDecision,mergedAt';

/**
 * Reads PR status via the gh CLI.
 *
 * Spawn is injected for the same reason briefer.js injects it: the tests stay
 * hermetic and fast because nothing ever shells out.
 */
export function createGh({ config, spawn = nodeSpawn }) {
  // Resolved once per process: the answer cannot change while we run, and it is
  // needed for every single lookup.
  //
  // The PROMISE is memoised, not a flag plus a value. A `checked` boolean set
  // before the await resolves is a cache stampede: concurrent callers see
  // "already looked up" and read a login that is still undefined, so every PR
  // added in the same breath gets author_is_me = null. POST /api/prs fires its
  // lookup without awaiting, so that is the normal path, not an edge case.
  let viewerPromise = null;

  function run(args) {
    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(config.ghBin ?? 'gh', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (err) {
        resolve({ code: -1, out: '', err: String(err) });
        return;
      }
      let out = '';
      let err = '';
      const timer = setTimeout(() => {
        err += `timed out after ${TIMEOUT_MS}ms`;
        child.kill('SIGKILL');
      }, TIMEOUT_MS);
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { err += d; });
      child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out: '', err: String(e) }); });
      child.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
    });
  }

  function viewer() {
    if (!viewerPromise) {
      viewerPromise = run(['api', 'user', '--jq', '.login'])
        .then(({ code, out }) => (code === 0 && out.trim() ? out.trim() : null));
    }
    return viewerPromise;
  }

  return {
    /**
     * One PR's status. Never throws: a failure is a value, because the caller
     * has to record it against the row rather than abandon the sweep.
     */
    async fetchPr(url) {
      const { code, out, err } = await run(['pr', 'view', url, '--json', FIELDS]);
      if (code !== 0) return { error: (err || `gh exited ${code}`).trim().slice(0, 500) };
      let json;
      try {
        json = JSON.parse(out);
      } catch {
        return { error: `gh returned unparseable json: ${out.slice(0, 120)}` };
      }
      const login = json.author?.login ?? null;
      const me = await viewer();
      return {
        title: json.title ?? null,
        authorLogin: login,
        // null, not false, when we cannot tell — see prs.js applyGhResult.
        isMe: me == null || login == null ? null : login === me,
        state: String(json.state ?? 'OPEN').toLowerCase(),
        reviewDecision: json.reviewDecision || null,
        isDraft: !!json.isDraft,
        mergedAt: json.mergedAt ? Date.parse(json.mergedAt) : null,
      };
    },
    // Exposed so a test can assert the viewer is only resolved once.
    _viewer: viewer,
  };
}
