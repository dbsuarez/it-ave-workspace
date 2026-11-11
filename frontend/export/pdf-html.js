// The page that is printed to PDF: the canvas as HTML, self-contained (pictures are data: URLs) with a
// strict Content-Security-Policy, because it is loaded in a hidden window with scripts switched off.
// Pure, so it is covered by tests.

const CSS = `
@page { size: A4; margin: 18mm 16mm; }
* { box-sizing: border-box; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { margin: 0; font-family: "Segoe UI", Calibri, Arial, sans-serif; font-size: 11pt; line-height: 1.55; color: #111827; }
h1.doc-title { font-size: 24pt; margin: 0 0 14pt; }
h1 { font-size: 20pt; margin: 18pt 0 6pt; }
h2 { font-size: 16pt; margin: 16pt 0 6pt; }
h3 { font-size: 13.5pt; margin: 14pt 0 5pt; }
h4 { font-size: 12pt; margin: 12pt 0 4pt; }
h1, h2, h3, h4 { line-height: 1.25; break-after: avoid; }
p { margin: 0 0 7pt; }
ul, ol { margin: 0 0 7pt; padding-left: 20pt; }
li > p { margin: 0 0 2pt; }
ul[data-type="taskList"] { list-style: none; padding-left: 2pt; }
ul[data-type="taskList"] li { display: flex; gap: 6pt; align-items: flex-start; }
ul[data-type="taskList"] li > label { flex: 0 0 auto; margin-top: 2pt; }
ul[data-type="taskList"] li[data-checked="true"] > div { color: #6b7280; text-decoration: line-through; }
blockquote { margin: 0 0 8pt; padding: 1pt 12pt; border-left: 3pt solid #d1d5db; color: #4b5563; }
pre { margin: 0 0 8pt; padding: 8pt 10pt; background: #f3f4f6; border-radius: 4pt; font: 9.5pt Consolas, monospace; white-space: pre-wrap; break-inside: avoid; }
code { padding: 0 2pt; background: #f3f4f6; border-radius: 2pt; font-family: Consolas, monospace; font-size: 0.92em; }
pre code { padding: 0; background: none; }
hr { border: 0; border-top: 1pt solid #d1d5db; margin: 14pt 0; }
a { color: #6d28d9; text-decoration: none; }
table { border-collapse: collapse; width: 100%; margin: 0 0 10pt; table-layout: fixed; break-inside: auto; }
tr { break-inside: avoid; }
th, td { border: 1pt solid #d1d5db; padding: 4pt 8pt; vertical-align: top; text-align: left; overflow-wrap: anywhere; }
th { background: #f3f4f6; font-weight: 700; }
th p, td p { margin: 0; }
img { display: block; max-width: 100%; height: auto; }
.pic { display: flex; margin: 0 0 8pt; break-inside: avoid; }
.pic[data-align="center"] { justify-content: center; }
.pic[data-align="right"] { justify-content: flex-end; }
div[data-callout] { margin: 0 0 9pt; padding: 8pt 12pt; border: 1pt solid rgba(59,130,246,.5); border-left-width: 4pt; border-radius: 5pt; background: #e8f0fe; break-inside: avoid; }
div[data-callout="note"] { background: #f3f4f6; border-color: #6b7280; }
div[data-callout="tip"] { background: #e7f7ec; border-color: #22c55e; }
div[data-callout="warning"] { background: #fef6dd; border-color: #eab308; }
div[data-callout="danger"] { background: #fde8e8; border-color: #ef4444; }
div[data-callout] > * + * { margin-top: 4pt; }
span[data-mention] { font-weight: 700; color: #6d28d9; }
`;

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function decodeEntities(text) {
  return String(text).replace(/&(amp|lt|gt|quot|#39);/g, (m, name) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" }[name]));
}

// The canvas title is printed on top unless the page already starts with a heading that says the same thing.
function startsWithTitle(bodyHtml, title) {
  const first = /^\s*<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(bodyHtml || '');
  if (!first) return false;
  return decodeEntities(first[1].replace(/<[^>]+>/g, '')).trim() === String(title || '').trim();
}

// bodyHtml is the editor's HTML with each picture already turned into a data: URL.
function buildPrintHtml({ title, bodyHtml, showTitle = true }) {
  if (startsWithTitle(bodyHtml, title)) showTitle = false;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">
<title>${escapeHtml(title || 'Canvas')}</title>
<style>${CSS}</style></head>
<body>${showTitle ? `<h1 class="doc-title">${escapeHtml(title || 'Untitled canvas')}</h1>` : ''}${bodyHtml}</body></html>`;
}

module.exports = { buildPrintHtml, escapeHtml };
