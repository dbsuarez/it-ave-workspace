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

function cvInline(text, ctx) {
  return cvFormat.inline(text, ctx || {});
}

function cvSplitRow(line) {
  let row = line.trim();
  if (row.startsWith('|')) row = row.slice(1);
  if (row.endsWith('|')) row = row.slice(0, -1);
  return row.split('|').map((cell) => cell.trim());
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
  const align = (i) => (aligns[i] ? ` style="text-align:${aligns[i]}"` : '');
  const header = head.map((cell, i) => `<th${align(i)}>${cvInline(cell, ctx)}</th>`).join('');
  const body = lines.slice(2).map((line) => {
    const cells = cvSplitRow(line).slice(0, head.length);
    while (cells.length < head.length) cells.push('');
    return `<tr>${cells.map((cell, i) => `<td${align(i)}>${cvInline(cell, ctx)}</td>`).join('')}</tr>`;
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
      html = callout ? cvCalloutHtml(callout, text, ctx) : cvFormat.block(text, ctx);
      break;
    }
    case 'list': html = cvFormat.block(text, ctx); break;
    default: html = `<p>${text.split('\n').map((line) => cvInline(line, ctx)).join('<br>')}</p>`;
  }
  return `<div class="cv-block cv-${cvFormat.escape(section.type)}" data-section-id="${cvFormat.escape(section.id)}">${html}</div>`;
}

function renderCanvasSections(sections, ctx = {}) {
  if (!sections || sections.length === 0) return '<p class="cv-empty">This canvas is empty. Switch to Edit to start writing.</p>';
  return sections.map((section) => renderCanvasSection(section, ctx)).join('');
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { renderCanvasSection, renderCanvasSections };
}
