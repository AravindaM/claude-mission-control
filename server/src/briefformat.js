// Pure text handling for BRIEF.md bodies. A brief is four `## ` sections on two
// cadences: About/Decisions/Links are stable and regenerated rarely, Status is
// rewritten often. Keeping the two apart is what makes frequent updates cheap —
// a Status refresh emits ~230 tokens instead of rewriting ~2,800.

const HEADING = /^## /;
const STATUS_MAX_BYTES = 4_000;

const linesOf = (body) => String(body ?? '').split('\n');
const headingIndex = (lines, name) => lines.findIndex((l) => l.trim() === `## ${name}`);

export function hasSection(body, name) {
  return headingIndex(linesOf(body), name) !== -1;
}

/** The section's own lines, heading included, with no bleed into the next one. */
export function sectionOf(body, name) {
  const lines = linesOf(body);
  const start = headingIndex(lines, name);
  if (start === -1) return '';
  const rest = lines.findIndex((l, i) => i > start && HEADING.test(l));
  return lines.slice(start, rest === -1 ? lines.length : rest).join('\n').trim();
}

/**
 * Replace one section, leaving every other byte untouched. A missing section is
 * inserted right after the opening one rather than appended, so the brief always
 * reads About then Status regardless of which pass wrote last.
 */
export function spliceSection(body, name, replacement) {
  const lines = linesOf(body);
  const fresh = String(replacement).trim().split('\n');
  const start = headingIndex(lines, name);

  if (start !== -1) {
    const rest = lines.findIndex((l, i) => i > start && HEADING.test(l));
    const end = rest === -1 ? lines.length : rest;
    return join([...lines.slice(0, start), ...fresh, '', ...lines.slice(end)]);
  }
  // Insert before the second heading; with only one heading there is nothing to
  // come before, so it goes at the end.
  const first = lines.findIndex((l) => HEADING.test(l));
  const second = lines.findIndex((l, i) => i > first && HEADING.test(l));
  if (first === -1 || second === -1) return join([...lines, '', ...fresh]);
  return join([...lines.slice(0, second), ...fresh, '', ...lines.slice(second)]);
}

function join(lines) {
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}

/**
 * Strip code fences and any preamble before `anchor`. The anchor must appear near
 * the top: a model that chatted for 500 characters before producing something
 * heading-shaped was talking about a brief, not writing one, and salvaging that
 * would let prose overwrite the record.
 */
export function normalizeOutput(out, anchor) {
  const body = String(out ?? '').trim()
    .replace(/^```[a-z]*\s*\n/i, '')
    .replace(/\n```\s*$/, '')
    .trim();
  const at = body.indexOf(anchor);
  return at > 0 && at < 400 ? body.slice(at) : body;
}

// Labels the detail panel renders as aligned rows rather than bullets. An
// allowlist, not a pattern: any "- word: value" bullet would swallow ordinary
// prose that happens to contain a colon. Branch and PRs are here because the
// most expensive thing to reconstruct on return is where the code actually is.
const ROW_LABELS = ['Now', 'Next', 'Blockers', 'Branch', 'PRs', 'Scope', 'Out of scope'];
const ROW_LINE = new RegExp(`^\\s*[-·*]?\\s*(${ROW_LABELS.join('|')})\\s*:\\s*(.+)$`, 'i');
const canonical = (label) => ROW_LABELS.find((l) => l.toLowerCase() === label.toLowerCase());

/** Prose plus the labelled rows lifted out of it, each appearing exactly once. */
function proseAndRows(text) {
  const fields = [];
  const prose = [];
  for (const line of linesOf(text)) {
    const row = line.match(ROW_LINE);
    if (row) fields.push({ label: canonical(row[1]), value: row[2].trim() });
    else prose.push(line);
  }
  return { text: prose.join('\n').replace(/\n{3,}/g, '\n\n').trim(), fields };
}

function bulletItems(text) {
  return linesOf(text)
    .map((l) => l.match(/^\s*[-·*]\s+(.+)$/))
    .filter(Boolean)
    .map((m) => m[1].trim());
}

/** A section's content with its own heading line removed. */
export function sectionBody(body, name) {
  return sectionOf(body, name).split('\n').slice(1).join('\n').trim();
}

const BULLET = /^\s*[-·*]\s+(.+)$/;
const GROUP_HEADING = /^\s*\*\*(.+?)\*\*\s*$/;

/**
 * `**Label**` followed by bullets, repeated. Replaces the old single-line
 * `Scope: a; b; c` form — a semicolon chain gives the eye one entry point and
 * hides the rest mid-wrap, where a bullet list gives one per item at x=0.
 */
function groupsOf(text) {
  const groups = [];
  for (const line of linesOf(text)) {
    const heading = line.match(GROUP_HEADING);
    if (heading) { groups.push({ label: heading[1].trim(), items: [] }); continue; }
    const bullet = line.match(BULLET);
    if (bullet && groups.length) groups[groups.length - 1].items.push(bullet[1].trim());
  }
  return groups.filter((g) => g.items.length);
}

/** Prose with the group blocks removed, so nothing is rendered twice. */
function proseWithoutGroups(text) {
  const out = [];
  let inGroup = false;
  for (const line of linesOf(text)) {
    if (GROUP_HEADING.test(line)) { inGroup = true; continue; }
    if (inGroup && (BULLET.test(line) || !line.trim())) continue;
    inGroup = false;
    out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * A decision is a claim plus an optional reason on its own `Why:` line. Splitting
 * them typographically is the point: joined by an em-dash they are one wrapped
 * blob and you cannot skim only the claims, which is what you want nine times
 * out of ten.
 */
function decisionItems(text) {
  const items = [];
  for (const line of linesOf(text)) {
    const bullet = line.match(BULLET);
    if (bullet) {
      items.push({ claim: bullet[1].trim().replace(/^\*\*(.*?)\*\*$/, '$1').trim(), why: '' });
      continue;
    }
    const why = line.match(/^\s+(?:Why|why):\s*(.+)$/);
    if (why && items.length) items[items.length - 1].why = why[1].trim();
  }
  return items;
}

/**
 * The brief as the detail panel needs it. Structured here rather than in the
 * dashboard so the parsing is covered by tests.
 */
export function splitBrief(body) {
  const about = sectionBody(body, 'About');
  return {
    about: { ...proseAndRows(proseWithoutGroups(about)), groups: groupsOf(about) },
    status: proseAndRows(sectionBody(body, 'Status')),
    decisions: { items: decisionItems(sectionBody(body, 'Decisions')) },
    invariants: { items: bulletItems(sectionBody(body, 'Invariants')) },
    links: { items: bulletItems(sectionBody(body, 'Links')) },
  };
}

/** A whole brief: the stable opening section plus a status. */
export function looksLikeBrief(body) {
  return String(body ?? '').startsWith('## About') && hasSection(body, 'Status');
}

/**
 * A status-only fragment. Any second heading means the pass emitted a full brief
 * — prompt-captured — and letting that through would clobber the stable sections
 * it was never asked to touch.
 */
export function looksLikeStatus(body) {
  const text = String(body ?? '');
  if (!text.startsWith('## Status')) return false;
  if (Buffer.byteLength(text) > STATUS_MAX_BYTES) return false;
  return !linesOf(text).slice(1).some((l) => HEADING.test(l));
}
