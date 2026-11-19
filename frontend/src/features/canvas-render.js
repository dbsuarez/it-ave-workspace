// IT Avenue Workspace - Canvas reading view.
//
// Turns the server's sections (see backend/src/canvasSections.js) into safe HTML: headings, paragraphs,
// lists, interactive checklists, tables, callouts, code, quotes and dividers. All text goes through the
// escaping in format.js first, and only the tags built here are emitted.
//
// Loaded before renderer.js; defines functions only. Also loadable in Node for tests
// (frontend/test/canvas-render.test.js).

const cvFormat = typeof formatInlineText === 'function'
  ? { inline: formatInlineText, block: formatTextBlock, escape: escapeRichText }
  : (() => {
    const f = require('./format.js');
    return { inline: f.formatInlineText, block: f.formatTextBlock, escape: f.escapeRichText };
  })();

const CV_CALLOUT = /^>\s*\[!(info|note|tip|warning|danger)\]\s*(.*)$/i;
const CV_CHECK = /^(\s*(?:[-*+]|\d+[.)])\s+)\[( |x|X)\](\s.*|)$/;
const CV_CALLOUT_ICON = { info: 'i', note: '✎', tip: '✦', warning: '!', danger: '⛔' };

// Font colour and font size are small spans in the text: <span data-color="#rrggbb"> and <span data-size="24">. They can sit inside or
// around bold/italic and inside each other, so they are swapped for markers first, the ordinary formatting runs over the whole text
// (so **<span …>bold red</span>** stays bold), and the markers are turned back into spans (only with a valid colour or size) after.
const CV_SPAN_OPEN = /<span data-(color|size)=["']([^"']*)["']>/gi;

function cvSpanAttrs(kind, value) {
  if (kind.toLowerCase() === 'color') return /^#[0-9a-f]{6}$/i.test(value) ? `data-color="${value.toLowerCase()}" style="color:${value.toLowerCase()}"` : null;
  const size = Math.round(Number(value));
  return /^\d{1,3}$/.test(value) && size >= 8 && size <= 96 ? `data-size="${size}" style="font-size:${size}px"` : null;
}

function cvSpanClose(source, from) {
  const lower = source.toLowerCase();
  let depth = 1;
  let at = from;
  for (;;) {
    const open = lower.indexOf('<span', at);
    const close = lower.indexOf('</span>', at);
    if (close < 0) return -1;
    if (open >= 0 && open < close) { depth += 1; at = open + 5; continue; }
    depth -= 1;
    if (depth === 0) return close;
    at = close + 7;
  }
}

function cvMaskSpans(source, spans) {
  let out = '';
  let at = 0;
  const open = new RegExp(CV_SPAN_OPEN.source, 'gi');
  let match;
  while ((match = open.exec(source))) {
    const attrs = cvSpanAttrs(match[1], match[2]);
    const close = attrs ? cvSpanClose(source, match.index + match[0].length) : -1;
    if (close < 0) continue;
    spans.push(attrs);
    out += `${source.slice(at, match.index)}\uE000${spans.length - 1}\uE001${cvMaskSpans(source.slice(match.index + match[0].length, close), spans)}\uE002`;
    at = close + 7;
    open.lastIndex = at;
  }
  return out + source.slice(at);
}

function cvInline(text, ctx) {
  const spans = [];
  const masked = cvMaskSpans(String(text || '').replace(/[\uE000-\uE002]/g, ''), spans);
  return cvFormat.inline(masked, ctx || {})
    .replace(/\uE000(\d+)\uE001/g, (_, index) => `<span ${spans[Number(index)]}>`)
    .replace(/\uE002/g, '</span>');
}

function cvTextBlock(text, ctx) {
  const lines = String(text || '').split('\n');
  const out = [];
  let index = 0;
  while (index < lines.length) {
    if (/^>\s?/.test(lines[index])) {
      const quoted = [];
      while (index < lines.length && /^>\s?/.test(lines[index])) quoted.push(cvInline(lines[index++].replace(/^>\s?/, ''), ctx));
      out.push(`<blockquote class="message-quote">${quoted.join('<br>')}</blockquote>`);
    } else if (/^[-*]\s+\S/.test(lines[index])) {
      const items = [];
      while (index < lines.length && /^[-*]\s+\S/.test(lines[index])) items.push(`<li>${cvInline(lines[index++].replace(/^[-*]\s+/, ''), ctx)}</li>`);
      out.push(`<ul class="message-list">${items.join('')}</ul>`);
    } else if (/^\d{1,3}[.)]\s+\S/.test(lines[index])) {
      const items = [];
      while (index < lines.length && /^\d{1,3}[.)]\s+\S/.test(lines[index])) items.push(`<li>${cvInline(lines[index++].replace(/^\d{1,3}[.)]\s+/, ''), ctx)}</li>`);
      out.push(`<ol class="message-list">${items.join('')}</ol>`);
    } else {
      const plain = [];
      while (index < lines.length && !/^>\s?/.test(lines[index]) && !/^[-*]\s+\S/.test(lines[index]) && !/^\d{1,3}[.)]\s+\S/.test(lines[index])) plain.push(cvInline(lines[index++], ctx));
      out.push(plain.join('\n'));
    }
  }
  return out.join('');
}

function cvSplitRow(line) {
  let row = line.trim();
  if (row.startsWith('|')) row = row.slice(1);
  if (row.endsWith('|')) row = row.slice(0, -1);
  return row.split('|').map((cell) => cell.trim());
}

// A table cell. The editor writes a line break inside a cell as <br> (and an ampersand as &amp;), so those are read back as what they
// mean: lines, and plain text. Consecutive lines that start with "- " (or "* ") become a bullet list. Everything still goes through
// cvInline, which escapes it, so nothing in a cell can become markup.
const CV_CELL_ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&#39;': "'", '&nbsp;': '\u00a0' };

function cvCellHtml(cell, ctx) {
  const lines = String(cell).split(/<br\s*\/?>/i).map((line) => line.replace(/&(?:amp|lt|gt|quot|apos|nbsp|#39);/g, (entity) => CV_CELL_ENTITIES[entity]));
  if (lines.length === 1) return cvInline(lines[0], ctx);
  const parts = [];
  let items = null;
  let afterText = false;
  for (const line of lines) {
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      (items = items || []).push(`<li>${cvInline(bullet[1], ctx)}</li>`);
      continue;
    }
    if (items) { parts.push(`<ul>${items.join('')}</ul>`); items = null; afterText = false; }
    parts.push(`${afterText ? '<br>' : ''}${cvInline(line, ctx)}`);
    afterText = true;
  }
  if (items) parts.push(`<ul>${items.join('')}</ul>`);
  return parts.join('');
}

function cvTableHtml(text, ctx) {
  const lines = text.split('\n');
  if (lines.length < 2) return `<p>${cvInline(text, ctx)}</p>`;
  const head = cvSplitRow(lines[0]).slice(0, 20);
  const aligns = cvSplitRow(lines[1]).slice(0, 20).map((cell) => {
    const left = cell.startsWith(':');
    const right = cell.endsWith(':');
    return left && right ? 'center' : right ? 'right' : left ? 'left' : '';
  });
  const align = (i, own) => { const value = own || aligns[i]; return value ? ` style="text-align:${value}"` : ''; };
  // a cell may carry its own alignment: <span data-align="center">…</span> around everything in it
  const cell = (tag, raw, i) => {
    const own = /^\s*<span data-align=["'](left|center|right)["']>([\s\S]*)<\/span>\s*$/i.exec(raw);
    return `<${tag}${align(i, own && own[1].toLowerCase())}>${cvCellHtml(own ? own[2] : raw, ctx)}</${tag}>`;
  };
  const header = head.map((raw, i) => cell('th', raw, i)).join('');
  const body = lines.slice(2).map((line) => {
    const cells = cvSplitRow(line).slice(0, head.length);
    while (cells.length < head.length) cells.push('');
    return `<tr>${cells.map((raw, i) => cell('td', raw, i)).join('')}</tr>`;
  }).join('');
  return `<div class="cv-table-wrap"><table class="cv-table"><thead><tr>${header}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function cvChecklistHtml(section, ctx) {
  let item = -1;
  const items = section.text.split('\n').map((line) => {
    const match = CV_CHECK.exec(line);
    if (!match) return `<li class="cv-check-extra">${cvInline(line.trim(), ctx)}</li>`;
    item += 1;
    const checked = match[2] !== ' ';
    const disabled = ctx && ctx.canEdit === false ? ' disabled' : '';
    return `<li class="cv-check${checked ? ' done' : ''}"><label><input type="checkbox" data-cv-toggle="${cvFormat.escape(section.id)}:${item}"${checked ? ' checked' : ''}${disabled}><span>${cvInline(match[3].trim(), ctx)}</span></label></li>`;
  }).join('');
  return `<ul class="cv-checklist">${items}</ul>`;
}

function cvCodeHtml(text) {
  const lines = text.split('\n');
  const language = /^\s{0,3}(?:`{3,}|~{3,})\s*([\w+#.-]*)/.exec(lines[0])?.[1] || '';
  const closed = lines.length > 1 && /^\s{0,3}(?:`{3,}|~{3,})\s*$/.test(lines[lines.length - 1]);
  const code = lines.slice(1, closed ? -1 : undefined).join('\n');
  return `<pre class="cv-code">${language ? `<span class="cv-code-lang">${cvFormat.escape(language)}</span>` : ''}<code>${cvFormat.escape(code)}</code></pre>`;
}

function cvCalloutHtml(match, text, ctx) {
  const kind = match[1].toLowerCase();
  const title = match[2].trim() || kind.charAt(0).toUpperCase() + kind.slice(1);
  const body = text.split('\n').slice(1).map((line) => cvInline(line.replace(/^>\s?/, ''), ctx)).join('<br>');
  return `<div class="cv-callout cv-callout-${kind}" role="note"><span class="cv-callout-icon" aria-hidden="true">${CV_CALLOUT_ICON[kind]}</span><div><strong class="cv-callout-title">${cvInline(title, ctx)}</strong>${body ? `<div class="cv-callout-body">${body}</div>` : ''}</div></div>`;
}

// A line that is only ![name](file:<id>) is a picture stored with the canvas. The <img> is filled in by
// canvas-view.js (it needs the signed-in request), so no URL is ever put in the page here.
const CV_IMAGE = /^!\[([^\]\n]{0,200})\]\(file:(\d{1,10})\)$/;

function cvParagraphHtml(text, ctx) {
  const parts = [];
  let run = [];
  const flush = () => { if (run.length) { parts.push(`<p>${run.join('<br>')}</p>`); run = []; } };
  for (const line of text.split('\n')) {
    const image = CV_IMAGE.exec(line.trim());
    if (image) {
      flush();
      const alt = cvFormat.escape(image[1]);
      parts.push(`<figure class="cv-image"><img data-cv-file="${image[2]}" alt="${alt}"><figcaption>${alt}</figcaption></figure>`);
    } else {
      run.push(cvInline(line, ctx));
    }
  }
  flush();
  return parts.join('');
}

// One section -> HTML. `section` is { id, type, text } from GET /api/canvas/:id/sections?full=true.
function renderCanvasSection(section, ctx = {}) {
  const text = String(section.text || '');
  let html;
  switch (section.type) {
    case 'heading': {
      const level = Math.min(/^\s{0,3}(#{1,6})/.exec(text)?.[1].length || 1, 4);
      const label = text.replace(/^\s{0,3}#{1,6}\s*/, '').replace(/\s+#+\s*$/, '');
      html = `<h${level} class="cv-h">${cvInline(label, ctx)}</h${level}>`;
      break;
    }
    case 'checklist': html = cvChecklistHtml({ ...section, text }, ctx); break;
    case 'table': html = cvTableHtml(text, ctx); break;
    case 'code': html = cvCodeHtml(text); break;
    case 'divider': html = '<hr class="cv-hr">'; break;
    case 'quote': {
      const callout = CV_CALLOUT.exec(text.split('\n')[0]);
      html = callout ? cvCalloutHtml(callout, text, ctx) : cvTextBlock(text, ctx);
      break;
    }
    case 'list': html = cvTextBlock(text, ctx); break;
    default: html = cvParagraphHtml(text, ctx);
  }
  return `<div class="cv-block cv-${cvFormat.escape(section.type)}" data-section-id="${cvFormat.escape(section.id)}">${html}</div>`;
}

function renderCanvasSections(sections, ctx = {}) {
  if (!sections || sections.length === 0) return '<p class="cv-empty">This canvas is empty. Switch to Edit to start writing.</p>';
  return sections.map((section) => renderCanvasSection(section, ctx)).join('');
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { renderCanvasSection, renderCanvasSections, CV_IMAGE };
}
