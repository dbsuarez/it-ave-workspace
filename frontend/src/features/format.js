// IT Avenue Workspace - safe rich text for messages.
//
// Supports **bold**, *italic* / _italic_, ~~strikethrough~~, `inline code`,
// ```code blocks```, > quotes, - bullet lists, 1. numbered lists, links, and
// @mentions. Everything is escaped first; only the tags built here are emitted.
//
// Loaded before renderer.js; defines functions only. Also loadable in Node
// for tests (see frontend/test/format.test.js).

function escapeRichText(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function isRichMentionBoundary(char) {
  return char === undefined || !/[A-Za-z0-9_]/.test(char);
}

// "@username" ranges for the given usernames; longer names win.
function findMentionRanges(text, usernames) {
  if (typeof text !== 'string' || !text.includes('@')) return [];
  const lower = text.toLowerCase();
  const ranges = [];
  const names = [...new Set((usernames || []).filter(Boolean))].sort((a, b) => b.length - a.length);
  for (const name of names) {
    const needle = `@${name.toLowerCase()}`;
    let from = 0;
    while (from < lower.length) {
      const start = lower.indexOf(needle, from);
      if (start === -1) break;
      const end = start + needle.length;
      const overlaps = ranges.some((range) => start < range.end && end > range.start);
      if (isRichMentionBoundary(lower[start - 1]) && isRichMentionBoundary(lower[end]) && !overlaps) {
        ranges.push({ start, end, username: name });
      }
      from = end;
    }
  }
  return ranges.sort((a, b) => a.start - b.start);
}

// Emphasis and links on text that is already escaped.
function formatEscapedInline(escaped) {
  return escaped
    .replace(/\bhttps?:\/\/[^\s<]+[^\s<.,;:!?)\]]/g, (url) => {
      // `url` is escaped text; &amp; inside it is correct for an href attribute.
      return `<a class="message-link" href="${url}" data-external-link target="_blank" rel="noopener noreferrer">${url}</a>`;
    })
    .replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>')
    .replace(/~~([^~\n]+?)~~/g, '<s>$1</s>')
    .replace(/(^|[\s(])\*([^*\s][^*\n]*?)\*(?=$|[\s.,;:!?)])/g, '$1<em>$2</em>')
    .replace(/(^|[\s(])_([^_\s][^_\n]*?)_(?=$|[\s.,;:!?)])/g, '$1<em>$2</em>');
}

// One line (no block structure): inline code, mentions, emphasis, links.
function formatInlineText(text, context) {
  const parts = String(text).split(/(`[^`\n]+`)/);
  return parts.map((part) => {
    if (part.length > 2 && part.startsWith('`') && part.endsWith('`')) {
      return `<code class="message-code">${escapeRichText(part.slice(1, -1))}</code>`;
    }
    const ranges = findMentionRanges(part, context.usernames);
    if (!ranges.length) return formatEscapedInline(escapeRichText(part));
    let html = '';
    let cursor = 0;
    for (const range of ranges) {
      html += formatEscapedInline(escapeRichText(part.slice(cursor, range.start)));
      const isMe = range.username.toLowerCase() === (context.me || '').toLowerCase();
      html += `<span class="mention${isMe ? ' mention-me' : ''}">${escapeRichText(part.slice(range.start, range.end))}</span>`;
      cursor = range.end;
    }
    return html + formatEscapedInline(escapeRichText(part.slice(cursor)));
  }).join('');
}

function formatTextBlock(text, context) {
  const lines = text.split('\n');
  const out = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (/^>\s?/.test(line)) {
      const quoted = [];
      while (index < lines.length && /^>\s?/.test(lines[index])) {
        quoted.push(formatInlineText(lines[index].replace(/^>\s?/, ''), context));
        index += 1;
      }
      out.push(`<blockquote class="message-quote">${quoted.join('<br>')}</blockquote>`);
    } else if (/^[-*]\s+\S/.test(line)) {
      const items = [];
      while (index < lines.length && /^[-*]\s+\S/.test(lines[index])) {
        items.push(`<li>${formatInlineText(lines[index].replace(/^[-*]\s+/, ''), context)}</li>`);
        index += 1;
      }
      out.push(`<ul class="message-list">${items.join('')}</ul>`);
    } else if (/^\d{1,3}[.)]\s+\S/.test(line)) {
      const items = [];
      while (index < lines.length && /^\d{1,3}[.)]\s+\S/.test(lines[index])) {
        items.push(`<li>${formatInlineText(lines[index].replace(/^\d{1,3}[.)]\s+/, ''), context)}</li>`);
        index += 1;
      }
      out.push(`<ol class="message-list">${items.join('')}</ol>`);
    } else {
      const plain = [];
      while (index < lines.length && !/^>\s?/.test(lines[index])
        && !/^[-*]\s+\S/.test(lines[index]) && !/^\d{1,3}[.)]\s+\S/.test(lines[index])) {
        plain.push(formatInlineText(lines[index], context));
        index += 1;
      }
      out.push(plain.join('\n'));
    }
  }
  return out.join('');
}

// Full message: fenced code blocks are taken out first, the rest is formatted.
function formatRichText(content, context = {}) {
  const text = String(content ?? '');
  const segments = text.split(/```([\s\S]*?)```/);
  return segments.map((segment, index) => {
    if (index % 2 === 1) {
      const code = segment.replace(/^\n/, '').replace(/\n$/, '');
      return `<pre class="message-code-block"><code>${escapeRichText(code)}</code></pre>`;
    }
    return formatTextBlock(segment, context);
  }).join('');
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { formatRichText, formatInlineText, formatTextBlock, findMentionRanges, escapeRichText };
}
