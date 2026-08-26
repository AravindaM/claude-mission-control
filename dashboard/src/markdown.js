import { marked } from 'marked';
import DOMPurify from 'dompurify';

// Every link in a rendered brief leaves the dashboard — always a new tab.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

export const renderBrief = (md) => DOMPurify.sanitize(marked.parse(md ?? ''));

// For text that already has its own container — a table cell, a list row, a chip
// — so marked does not wrap it in a block element and break the layout.
export const renderInline = (md) => DOMPurify.sanitize(marked.parseInline(md ?? ''));
