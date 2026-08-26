import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { extractConversation, countUserTurns, countTurns, extractTurnsSince } from '../src/transcript.js';

const fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'transcript.jsonl');

describe('extractConversation', () => {
  it('keeps user/assistant text and drops tool results, tool calls, thinking, and noise lines', () => {
    const out = extractConversation(fixture);
    expect(out).toContain('USER: Fix the pagination bug');
    expect(out).toContain('ASSISTANT: The bug is in Paginator line 42');
    expect(out).toContain('USER: Apply the fix and add a test');
    expect(out).toContain('USER: ship it');
    expect(out).not.toContain('GIANT TOOL OUTPUT');
    expect(out).not.toContain('secret reasoning');
    expect(out).not.toContain('queue-operation');
  });

  it('caps output by taking the TAIL of the conversation', () => {
    const out = extractConversation(fixture, 120);
    expect(out.length).toBeLessThanOrEqual(120);
    expect(out).toContain('ship it'); // newest survives
    expect(out).not.toContain('Fix the pagination bug'); // oldest trimmed
  });
});

describe('extractTurnsSince', () => {
  it('returns only the turns after the watermark and reports the new one', () => {
    const all = extractTurnsSince(fixture, 0);
    expect(all.endIndex).toBe(6); // 3 user + 3 assistant turns carry text
    expect(all.text).toContain('Fix the pagination bug');

    const fresh = extractTurnsSince(fixture, 4);
    expect(fresh.endIndex).toBe(6);
    expect(fresh.text).not.toContain('Fix the pagination bug'); // already folded in
    expect(fresh.text).toContain('ship it'); // newest still there
    expect(fresh.dropped).toBe(0);
  });

  it('reports turns the byte cap discarded instead of hiding the loss', () => {
    const out = extractTurnsSince(fixture, 0, 60);
    expect(Buffer.byteLength(out.text)).toBeLessThanOrEqual(60);
    expect(out.text).toContain('ship it'); // budgeted from the tail
    expect(out.dropped).toBeGreaterThan(0); // and it says so
    expect(out.endIndex).toBe(6); // watermark still advances past the dropped turns
  });

  it('returns empty text once the watermark has caught up', () => {
    const out = extractTurnsSince(fixture, 6);
    expect(out.text).toBe('');
    expect(out.endIndex).toBe(6);
    expect(out.dropped).toBe(0);
  });
});

describe('countTurns', () => {
  it('counts every distilled turn, so agentic work with no new prompt still counts', () => {
    expect(countTurns(fixture)).toBe(6);
    expect(countUserTurns(fixture)).toBe(3);
  });
});

describe('countUserTurns', () => {
  it('counts real user prompts, not tool_result carriers', () => {
    expect(countUserTurns(fixture)).toBe(3);
  });

  it('returns 0 for a missing file instead of throwing', () => {
    expect(countUserTurns('/nope/missing.jsonl')).toBe(0);
  });
});
