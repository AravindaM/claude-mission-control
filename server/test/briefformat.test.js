import { describe, it, expect } from 'vitest';
import {
  hasSection, sectionOf, spliceSection, normalizeOutput, looksLikeBrief, looksLikeStatus, splitBrief,
  linkifyTickets, harvestLinks,
} from '../src/briefformat.js';

// The shape the generator is asked to produce. Kept here verbatim so a change to
// the prompt that breaks parsing fails a test rather than a brief.
const BRIEF = `## About
The search endpoint returns every match in one response, so a broad query
can time out the client. This adds cursor pagination.

**In scope**
- Cursor pagination on the search endpoint
- A hard maximum page size of 200

**Out of scope**
- Changing the ranking algorithm

**Commands**
- \`npm run bench -- --rows 2000000\`

## Status
- Now: load-testing the cursor path
- Next: update the two client SDKs to follow the cursor
- Branch: api@feature/search-pagination, 3 unpushed
- PRs: #12 green, #14 draft

Offset pagination degraded badly past page 50. Root cause confirmed.

## Decisions
- **Cursor pagination, not offset.**
  Why: offset re-scans the whole result set on every page.
- **Derive the cursor from the sort key, not the row number.**
  Why: row numbers shift when a concurrent write lands mid-scan.

## Invariants
- Never return an unbounded result set, whatever the caller asks for.
- \`search()\` and \`count()\` never share a query plan.

## Links
- [API PR #12](https://github.com/example/repo/pull/12)
`;

describe('sections', () => {
  it('finds sections by name and ignores ones that are absent', () => {
    expect(hasSection(BRIEF, 'About')).toBe(true);
    expect(hasSection(BRIEF, 'Invariants')).toBe(true);
    expect(hasSection(BRIEF, 'Goal')).toBe(false);
  });

  it('reads a section back without bleeding into the next one', () => {
    const about = sectionOf(BRIEF, 'About');
    expect(about).toContain('The search endpoint returns');
    expect(about).toContain('In scope');
    expect(about).not.toContain('Now:');
    expect(sectionOf(BRIEF, 'Links')).toContain('API PR #12');
    expect(sectionOf(BRIEF, 'Goal')).toBe('');
  });
});

describe('spliceSection', () => {
  it('replaces one section and leaves every other byte alone', () => {
    const out = spliceSection(BRIEF, 'Status', '## Status\n- Now: shipped');
    expect(out).toContain('Now: shipped');
    expect(out).not.toContain('Offset pagination degraded');
    expect(sectionOf(out, 'About')).toBe(sectionOf(BRIEF, 'About'));
    expect(sectionOf(out, 'Decisions')).toBe(sectionOf(BRIEF, 'Decisions'));
    expect(sectionOf(out, 'Invariants')).toBe(sectionOf(BRIEF, 'Invariants'));
  });

  it('keeps section order stable so the brief always reads About then Status', () => {
    const out = spliceSection(BRIEF, 'Status', '## Status\n- Now: shipped');
    expect(out.indexOf('## About')).toBeLessThan(out.indexOf('## Status'));
    expect(out.indexOf('## Status')).toBeLessThan(out.indexOf('## Decisions'));
  });

  it('inserts a missing section directly after the opening one', () => {
    const noStatus = '## About\nThe thing.\n\n## Decisions\n- a choice\n';
    const out = spliceSection(noStatus, 'Status', '## Status\n- Now: started');
    expect(out.indexOf('## About')).toBeLessThan(out.indexOf('## Status'));
    expect(out.indexOf('## Status')).toBeLessThan(out.indexOf('## Decisions'));
    expect(out).toContain('- a choice');
  });
});

describe('normalizeOutput', () => {
  it('strips fences and preamble up to the anchor heading', () => {
    const fenced = 'Here you go:\n```markdown\n## Status\n- Now: real content\n```';
    expect(normalizeOutput(fenced, '## Status').startsWith('## Status')).toBe(true);
    expect(normalizeOutput(fenced, '## Status')).toContain('real content');
  });

  it('leaves a far-away anchor alone, so prose about a brief is not mistaken for one', () => {
    const chatty = `${'x'.repeat(500)}\n## Status\nnope`;
    expect(normalizeOutput(chatty, '## Status').startsWith('## Status')).toBe(false);
  });
});

describe('splitBrief', () => {
  it('splits About into prose plus its labelled bullet groups', () => {
    const { about } = splitBrief(BRIEF);
    expect(about.text).toContain('The search endpoint returns');
    expect(about.text).not.toContain('In scope'); // lifted into a group
    expect(about.groups.map((g) => g.label)).toEqual(['In scope', 'Out of scope', 'Commands']);
    expect(about.groups[0].items).toEqual([
      'Cursor pagination on the search endpoint',
      'A hard maximum page size of 200',
    ]);
    expect(about.groups[2].items).toEqual(['`npm run bench -- --rows 2000000`']);
  });

  it('lifts every Status row, including the operational ones', () => {
    const { status } = splitBrief(BRIEF);
    expect(status.fields).toEqual([
      { label: 'Now', value: 'load-testing the cursor path' },
      { label: 'Next', value: 'update the two client SDKs to follow the cursor' },
      { label: 'Branch', value: 'api@feature/search-pagination, 3 unpushed' },
      { label: 'PRs', value: '#12 green, #14 draft' },
    ]);
    expect(status.text).toContain('Offset pagination degraded');
    expect(status.text).not.toContain('Now:');
  });

  it('reads each decision as a claim with its reason kept separate', () => {
    const { decisions } = splitBrief(BRIEF);
    expect(decisions.items).toEqual([
      {
        claim: 'Cursor pagination, not offset.',
        why: 'offset re-scans the whole result set on every page.',
      },
      {
        claim: 'Derive the cursor from the sort key, not the row number.',
        why: 'row numbers shift when a concurrent write lands mid-scan.',
      },
    ]);
  });

  it('accepts a decision with no reason rather than dropping it', () => {
    const { decisions } = splitBrief('## Decisions\n- **A bare claim.**\n- **Another.**\n  Why: because.');
    expect(decisions.items).toEqual([
      { claim: 'A bare claim.', why: '' },
      { claim: 'Another.', why: 'because.' },
    ]);
  });

  it('reads invariants as plain one-liners, since they carry no reason', () => {
    const { invariants } = splitBrief(BRIEF);
    expect(invariants.items).toEqual([
      'Never return an unbounded result set, whatever the caller asks for.',
      '`search()` and `count()` never share a query plan.',
    ]);
  });

  it('returns empty fields for a brief that has no sections at all', () => {
    const s = splitBrief('# Some Task\n\n_No brief yet._');
    expect(s.about.text).toBe('');
    expect(s.about.groups).toEqual([]);
    expect(s.status.fields).toEqual([]);
    expect(s.decisions.items).toEqual([]);
    expect(s.invariants.items).toEqual([]);
    expect(s.links.items).toEqual([]);
  });

  it('still reads a brief written before groups and Why lines existed', () => {
    // Old briefs stay readable until their next About pass rewrites them.
    const legacy = '## About\nOld prose.\n\nScope: a; b\n\n## Decisions\n- A plain old bullet.\n';
    const s = splitBrief(legacy);
    expect(s.about.text).toContain('Old prose');
    expect(s.decisions.items).toEqual([{ claim: 'A plain old bullet.', why: '' }]);
  });
});

describe('linkifyTickets', () => {
  const base = 'https://example.atlassian.net/browse/';

  it('turns a bare ticket key into a link to the configured tracker', () => {
    expect(linkifyTickets('ACME-42', base))
      .toBe('[ACME-42](https://example.atlassian.net/browse/ACME-42)');
    expect(linkifyTickets('blocked on ACME-42 and ACME-9', base))
      .toBe('blocked on [ACME-42](https://example.atlassian.net/browse/ACME-42) '
        + 'and [ACME-9](https://example.atlassian.net/browse/ACME-9)');
  });

  it('repairs a link whose target is a bare ticket id, not a URL', () => {
    // The generator wrote `[PLAT-1](PLAT-1)`, which the browser resolves against
    // the dashboard's own origin and navigates nowhere.
    expect(linkifyTickets('[ACME-42](ACME-42)', base))
      .toBe('[ACME-42](https://example.atlassian.net/browse/ACME-42)');
    expect(linkifyTickets('- [Ticket ACME-42](ACME-42)', base))
      .toBe('- [Ticket ACME-42](https://example.atlassian.net/browse/ACME-42)');
  });

  it('leaves a key that is already a link alone', () => {
    // Otherwise the label gets rewritten into a nested link and marked breaks.
    const already = '[ACME-42](https://example.atlassian.net/browse/ACME-42)';
    expect(linkifyTickets(already, base)).toBe(already);
    expect(linkifyTickets('[see ACME-42 here](https://example.com/x)', base))
      .toBe('[see ACME-42 here](https://example.com/x)');
  });

  it('leaves keys inside code spans alone', () => {
    expect(linkifyTickets('run `git log ACME-42`', base)).toBe('run `git log ACME-42`');
  });

  it('does nothing without a configured tracker, rather than inventing a URL', () => {
    expect(linkifyTickets('ACME-42', '')).toBe('ACME-42');
    expect(linkifyTickets('ACME-42', undefined)).toBe('ACME-42');
  });

  it('ignores things that only look like keys', () => {
    expect(linkifyTickets('UTF-8 and COVID-19 and A-1', base)).toBe('UTF-8 and COVID-19 and A-1');
  });
});

describe('harvestLinks', () => {
  it('pulls PR and issue URLs out of raw conversation text', () => {
    const text = 'opened https://github.com/acme/api/pull/96 and closed '
      + 'https://github.com/acme/web/issues/12 yesterday';
    expect(harvestLinks(text)).toEqual([
      'https://github.com/acme/api/pull/96',
      'https://github.com/acme/web/issues/12',
    ]);
  });

  it('deduplicates, since a PR gets mentioned dozens of times in one session', () => {
    const text = 'https://github.com/acme/api/pull/96 ... https://github.com/acme/api/pull/96';
    expect(harvestLinks(text)).toEqual(['https://github.com/acme/api/pull/96']);
  });

  it('keeps tracker and dashboard URLs but drops ordinary reading', () => {
    const text = 'see https://acme.atlassian.net/browse/ACME-1 and '
      + 'https://grafana.acme.com/d/abc/overview but not https://stackoverflow.com/q/123 '
      + 'or https://nodejs.org/api/fs.html';
    expect(harvestLinks(text)).toEqual([
      'https://acme.atlassian.net/browse/ACME-1',
      'https://grafana.acme.com/d/abc/overview',
    ]);
  });

  it('strips trailing punctuation that markdown or prose glued on', () => {
    expect(harvestLinks('(https://github.com/acme/api/pull/96).'))
      .toEqual(['https://github.com/acme/api/pull/96']);
  });

  it('caps the list so a noisy transcript cannot flood the prompt', () => {
    const many = Array.from({ length: 40 }, (_, i) => `https://github.com/acme/api/pull/${i}`).join(' ');
    expect(harvestLinks(many).length).toBe(20);
  });

  it('returns nothing for text with no links', () => {
    expect(harvestLinks('no links here at all')).toEqual([]);
    expect(harvestLinks('')).toEqual([]);
  });
});

describe('looksLikeBrief', () => {
  it('accepts the sectioned format and rejects the old one', () => {
    expect(looksLikeBrief(BRIEF)).toBe(true);
    expect(looksLikeBrief('## Goal\nold\n## Next steps\n- x')).toBe(false);
    expect(looksLikeBrief('## About\nno status section here')).toBe(false);
  });

  it('rejects a conversational reply that was never a brief', () => {
    expect(looksLikeBrief('Sure — want me to hand you the one-liner?')).toBe(false);
  });
});

describe('looksLikeStatus', () => {
  it('accepts a bare status fragment', () => {
    expect(looksLikeStatus('## Status\n- Now: x\n- Next: y')).toBe(true);
  });

  it('rejects a fragment that ran on into a whole brief', () => {
    expect(looksLikeStatus('## Status\nx\n\n## Decisions\n- y')).toBe(false);
  });

  it('rejects anything not starting at the Status heading, and anything oversized', () => {
    expect(looksLikeStatus('Here is the status:\n## Status\nx')).toBe(false);
    expect(looksLikeStatus(`## Status\n${'x'.repeat(5000)}`)).toBe(false);
  });
});
