import { readFileSync } from 'node:fs';

function textOf(message) {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

function turns(jsonlPath) {
  let raw;
  try {
    raw = readFileSync(jsonlPath, 'utf8');
  } catch {
    return [];
  }
  const result = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type !== 'user' && entry.type !== 'assistant') continue;
    const text = textOf(entry.message).trim();
    if (!text) continue; // tool_result carriers, thinking-only, tool_use-only
    result.push({ role: entry.type, text });
  }
  return result;
}

export function extractConversation(jsonlPath, maxBytes = 200_000) {
  const lines = turns(jsonlPath).map((t) => `${t.role.toUpperCase()}: ${t.text}`);
  // Budget from the tail: the newest exchange matters most for briefs.
  const kept = [];
  let size = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const cost = Buffer.byteLength(lines[i], 'utf8') + 2;
    if (size + cost > maxBytes) break;
    kept.unshift(lines[i]);
    size += cost;
  }
  return kept.join('\n\n');
}

export function countUserTurns(jsonlPath) {
  return turns(jsonlPath).filter((t) => t.role === 'user').length;
}

// Every distilled turn, user and assistant. This is the briefing watermark
// rather than the user-prompt count, so an agentic run that produces hours of
// work off a single prompt still registers as new material.
export function countTurns(jsonlPath) {
  return turns(jsonlPath).length;
}

/**
 * The conversation since a watermark, for folding into an existing brief.
 * @returns {{text: string, endIndex: number, dropped: number}} `endIndex` is the
 *   new watermark — it advances past dropped turns too, since re-reading them
 *   later would not help. `dropped` is how many fresh turns the byte cap cut;
 *   a cap that silently discards work reads as full coverage when it is not.
 */
export function extractTurnsSince(jsonlPath, fromIndex = 0, maxBytes = 60_000) {
  const all = turns(jsonlPath);
  const fresh = all.slice(fromIndex);
  const lines = fresh.map((t) => `${t.role.toUpperCase()}: ${t.text}`);
  // Budget from the tail: for a status line the newest exchange matters most,
  // so overflow is dropped from the oldest end of the fresh material.
  const kept = [];
  let size = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const cost = Buffer.byteLength(lines[i], 'utf8') + 2;
    if (size + cost > maxBytes) break;
    kept.unshift(lines[i]);
    size += cost;
  }
  return { text: kept.join('\n\n'), endIndex: all.length, dropped: fresh.length - kept.length };
}
