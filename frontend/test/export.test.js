// Word and PDF export: the document builder and the print page.
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { unzipSync, strFromU8 } = require('fflate');

const dom = new JSDOM('<!doctype html><body></body>', { pretendToBeVisual: true });
for (const key of ['window', 'document', 'navigator', 'Node', 'HTMLElement', 'Element', 'Text', 'DocumentFragment', 'MutationObserver', 'getComputedStyle', 'requestAnimationFrame', 'Range', 'Selection', 'DOMParser', 'XMLSerializer', 'KeyboardEvent', 'Event']) {
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true, writable: true });
}
const { createCanvasEditor } = require('../editor-src/canvas-editor');
const { buildDocx, plainText } = require('../export/docx-builder');
const { buildPrintHtml } = require('../export/pdf-html');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

const MARKDOWN = [
  '# Project plan',
  '',
  'Intro with **bold**, *italic*, ~~gone~~, `code` and a [link](https://example.com/page). Thanks @ann.',
  '',
  '## Tasks',
  '',
  '- [x] Done item',
  '- [ ] Open item',
  '',
  '- bullet one',
  '  - nested bullet',
  '- bullet two',
  '',
  '1. first',
  '2. second',
  '',
  '> a quoted line',
  '',
  '```',
  'const x = 1;',
  '```',
  '',
  '---',
  '',
  '| Name | Owner | Due |',
  '| ------------ | --- | :-: |',
  '| Alpha | Ann | Mon |',
  '',
  '> [!warning] Careful',
  '> Back up first.',
  '',
  '![banner](file:7 "50% center")',
  '',
  '![missing](file:99)',
  '',
].join('\n');

function documentJson(markdown = MARKDOWN) {
  const element = document.createElement('div');
  document.body.appendChild(element);
  const editor = createCanvasEditor(element, { content: markdown });
  const json = editor.getJSON();
  editor.destroy();
  return json;
}

async function docxParts(options) {
  const buffer = await buildDocx(options);
  const files = unzipSync(new Uint8Array(buffer));
  return { files, text: (name) => strFromU8(files[name]) };
}

test('a full canvas becomes a valid Word file with every block type', async () => {
  const { files, text } = await docxParts({
    title: 'Project plan',
    doc: documentJson(),
    images: { 7: { data: PNG, width: 400, height: 200 } },
  });
  for (const part of ['[Content_Types].xml', 'word/document.xml', 'word/styles.xml', 'word/numbering.xml', 'word/_rels/document.xml.rels']) {
    assert.ok(files[part], `${part} is in the package`);
  }
  const xml = text('word/document.xml');
  // well-formed XML
  const parsed = new DOMParser().parseFromString(xml, 'application/xml');
  assert.equal(parsed.getElementsByTagName('parsererror').length, 0, 'document.xml is well formed');

  assert.match(xml, /Project plan/);
  assert.match(xml, /w:pStyle w:val="Heading1"/, 'headings use heading styles');
  assert.match(xml, /w:pStyle w:val="Heading2"/);
  assert.match(xml, /<w:b\/>/, 'bold');
  assert.match(xml, /<w:i\/>/, 'italic');
  assert.match(xml, /<w:strike\/>/, 'strikethrough');
  assert.match(xml, /Consolas/, 'code font');
  assert.match(xml, /@ann/, 'a mention stays readable');
  assert.match(xml, /Done item/);
  assert.match(xml, /☑/, 'a ticked task shows a ticked box');
  assert.match(xml, /☐/, 'an open task shows an empty box');
  assert.match(xml, /w:numPr/, 'real list numbering');
  assert.match(xml, /nested bullet/);
  assert.match(xml, /a quoted line/);
  assert.match(xml, /const x = 1;/);
  assert.match(xml, /Alpha/);
  assert.match(xml, /w:tblHeader/, 'the table has a header row');
  assert.match(xml, /w:jc w:val="center"/, 'column alignment');
  assert.ok((xml.match(/<w:tbl>/g) || []).length >= 2, 'a table and a callout box');
  assert.match(xml, /Back up first\./);
  assert.match(xml, /<w:drawing>/, 'the picture is embedded');
  assert.ok(Object.keys(files).some((name) => /^word\/media\/.+\.png$/.test(name)), 'the picture file is in the package');
  assert.match(xml, /\[missing\]/, 'a picture that could not be fetched leaves a note');
  assert.match(text('word/_rels/document.xml.rels'), /https:\/\/example\.com\/page/, 'the link target is kept');
});

test('picture size follows the percentage and never exceeds the page', async () => {
  const sized = await docxParts({ title: 'x', doc: documentJson('![a](file:7 "50%")\n'), images: { 7: { data: PNG, width: 2000, height: 1000 } } });
  const sizedXml = sized.text('word/document.xml');
  const extent = /<wp:extent cx="(\d+)" cy="(\d+)"/.exec(sizedXml);
  const widthPx = Number(extent[1]) / 9525;
  assert.ok(Math.abs(widthPx - 300) < 2, `50% of the page is about 300px, got ${widthPx}`);
  assert.ok(Math.abs(Number(extent[2]) / Number(extent[1]) - 0.5) < 0.01, 'the aspect ratio is kept');
  const big = await docxParts({ title: 'x', doc: documentJson('![a](file:7)\n'), images: { 7: { data: PNG, width: 5000, height: 2500 } } });
  assert.ok(Number(/<wp:extent cx="(\d+)"/.exec(big.text('word/document.xml'))[1]) / 9525 <= 601, 'capped to the page width');
});

test('the canvas title is added unless the page already starts with it', async () => {
  const same = (await docxParts({ title: 'Project plan', doc: documentJson('# Project plan\n\nText\n') })).text('word/document.xml');
  assert.equal((same.match(/Project plan/g) || []).length, 1, 'not repeated');
  const other = (await docxParts({ title: 'Meeting', doc: documentJson('Just text\n') })).text('word/document.xml');
  assert.match(other, /Meeting/);
  assert.match(other, /w:pStyle w:val="Title"/);
});

test('an empty canvas still produces a valid file', async () => {
  const { files } = await docxParts({ title: 'Empty', doc: { type: 'doc', content: [] } });
  assert.ok(files['word/document.xml']);
  const { text } = await docxParts({ title: '', doc: null });
  assert.ok(text('word/document.xml').includes('<w:body>'));
});

test('numbered lists restart at 1 each time', async () => {
  const { text } = await docxParts({ title: 'x', doc: documentJson('1. a\n2. b\n\nText between\n\n1. c\n2. d\n') });
  const numbering = text('word/numbering.xml');
  const instances = numbering.match(/<w:num w:numId/g) || [];
  assert.ok(instances.length >= 3, 'each numbered list has its own numbering instance');
});

test('plainText reads nested content', () => {
  const json = documentJson('Hello **there** @ann\n');
  assert.equal(plainText(json), 'Hello there @ann');
});

test('the print page is self-contained and locked down', () => {
  const html = buildPrintHtml({ title: 'A <b>bold</b> "title"', bodyHtml: '<p>Body</p>' });
  assert.match(html, /<title>A &lt;b&gt;bold&lt;\/b&gt; &quot;title&quot;<\/title>/, 'the title is escaped');
  assert.match(html, /<h1 class="doc-title">A &lt;b&gt;bold&lt;\/b&gt; &quot;title&quot;<\/h1>/);
  assert.match(html, /<p>Body<\/p>/);
  const csp = /Content-Security-Policy" content="([^"]+)"/.exec(html)[1];
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /img-src data:/);
  assert.ok(!/script-src|connect-src|http/.test(csp), 'no scripts and no network');
  assert.ok(!/<script/i.test(html));
  assert.match(html, /@page \{ size: A4/);
  assert.ok(!buildPrintHtml({ title: 'x', bodyHtml: '', showTitle: false }).includes('doc-title">'));
});

test('the print page does not repeat the title when the content starts with it', () => {
  assert.ok(!buildPrintHtml({ title: 'Plan', bodyHtml: '<h1>Plan</h1><p>x</p>' }).includes('doc-title">'));
  assert.ok(!buildPrintHtml({ title: 'Q&A', bodyHtml: '<h1>Q&amp;A</h1>' }).includes('doc-title">'), 'entities are compared decoded');
  assert.ok(buildPrintHtml({ title: 'Plan', bodyHtml: '<h2>Plan</h2>' }).includes('doc-title">'), 'only a first level 1 heading counts');
  assert.ok(buildPrintHtml({ title: 'Plan', bodyHtml: '<p>x</p><h1>Plan</h1>' }).includes('doc-title">'), 'only when it comes first');
});
