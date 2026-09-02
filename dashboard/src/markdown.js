import { marked } from 'marked';
import DOMPurify from 'dompurify';

const ABSOLUTE = /^(https?:|mailto:)/i;

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName !== 'A') return;
  // A brief's links always point somewhere else, so a relative href is a
  // generator mistake, not a route. `[PLAT-1](PLAT-1)` would otherwise resolve
  // against the dashboard origin and navigate to a 404 on ourselves.
  if (!ABSOLUTE.test(node.getAttribute('href') ?? '')) {
    node.removeAttribute('href');
    node.removeAttribute('target');
    return;
  }
  // Every real link leaves the dashboard — always a new tab.
  node.setAttribute('target', '_blank');
  node.setAttribute('rel', 'noopener noreferrer');
});

export const renderBrief = (md) => DOMPurify.sanitize(marked.parse(md ?? ''));

// For text that already has its own container — a table cell, a list row, a chip
// — so marked does not wrap it in a block element and break the layout.
export const renderInline = (md) => DOMPurify.sanitize(marked.parseInline(md ?? ''));
