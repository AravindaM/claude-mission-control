import { describe, it, expect } from 'vitest';
import {
  hasSection, sectionOf, spliceSection, normalizeOutput, looksLikeBrief, looksLikeStatus, splitBrief,
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
