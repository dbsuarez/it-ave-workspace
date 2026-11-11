// Word export: pictures in table cells and paragraphs, and profile cards.
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { unzipSync, strFromU8 } = require('fflate');

const dom = new JSDOM('<!doctype html><body></body>', { pretendToBeVisual: true });
for (const key of ['window', 'document', 'navigator', 'Node', 'HTMLElement', 'Element', 'Text', 'DocumentFragment', 'MutationObserver', 'getComputedStyle', 'requestAnimationFrame', 'Range', 'Selection', 'DOMParser', 'XMLSerializer', 'KeyboardEvent', 'Event']) {
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true, writable: true });
}
const { createCanvasEditor } = require('../editor-src/canvas-editor');
const { buildDocx } = require('../export/docx-builder');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

function documentJson(markdown) {
  const element = document.createElement('div');
  document.body.appendChild(element);
  const editor = createCanvasEditor(element, { content: markdown });
  const json = editor.getJSON();
  editor.destroy();
  return json;
}

async function docxParts(options) {
  const files = unzipSync(new Uint8Array(await buildDocx(options)));
  return { files, text: (name) => strFromU8(files[name]) };
}

test('pictures inside table cells (as in a real canvas) are exported, scaled to the cell', async () => {
  const md = '| left | right |\n| --- | --- |\n| ![shot](file:7 "50% center") | ![other](file:8) |\n| text | more |\n';
  const json = documentJson(md);
  assert.ok(JSON.stringify(json).includes('"image"'), 'the editor keeps pictures that are in cells');
  const { files, text } = await docxParts({
    title: 'x',
    doc: json,
    images: { 7: { data: PNG, width: 1600, height: 800 }, 8: { data: PNG, width: 3000, height: 1500 } },
  });
  const xml = text('word/document.xml');
  assert.equal((xml.match(/<w:drawing>/g) || []).length, 2, 'both pictures are in the file');
  assert.ok(Object.keys(files).some((name) => /^word\/media\//.test(name)));
  // never wider than the table cell (two columns sharing a 600px table: about 300px at most)
  const widths = Array.from(xml.matchAll(/<wp:extent cx="(\d+)"/g)).map((m) => Number(m[1]) / 9525);
  assert.ok(widths.every((w) => w <= 300), `pictures fit their cells, got ${widths.join(', ')}`);
  assert.ok(widths[0] < widths[1], 'a 50% picture is smaller than a full-width one');
});

test('a picture inside a paragraph is exported too, and a missing one leaves its description', async () => {
  const doc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Photo: ' }, { type: 'image', attrs: { src: 'file:7', alt: 'p', width: 25 } }] }] };
  const { text } = await docxParts({ title: 'x', doc, images: { 7: { data: PNG, width: 400, height: 400 } } });
  assert.match(text('word/document.xml'), /<w:drawing>/);
  assert.match(text('word/document.xml'), /Photo: /);
  const gone = await docxParts({ title: 'x', doc, images: {} });
  assert.match(gone.text('word/document.xml'), /\[p\]/);
});

test('a profile card becomes a bordered two-column box with the person’s details', async () => {
  const card = { type: 'profileCard', attrs: { username: 'arcadio', email: 'arcadio@itavenue.ph', jobTitle: 'Technical Project Manager', role: '', status: 'online', statusText: 'In a meeting', color: '#0EA5E9' } };
  const plain = (await docxParts({ title: 'x', doc: { type: 'doc', content: [card] } })).text('word/document.xml');
  for (const piece of ['arcadio', 'Technical Project Manager', 'arcadio@itavenue.ph', 'In a meeting']) assert.ok(plain.includes(piece), piece);
  assert.match(plain, /w:fill="0EA5E9"/, 'the avatar cell uses their color');
  assert.match(plain, /22C55E/, 'a green dot when online');
  assert.match(plain, />A</, 'their initial');
  const photoCard = { ...card, attrs: { ...card.attrs, photo: { base64: PNG.toString('base64'), width: 1, height: 1 } } };
  const withPhoto = (await docxParts({ title: 'x', doc: { type: 'doc', content: [photoCard] } })).text('word/document.xml');
  assert.match(withPhoto, /<w:drawing>/);
  assert.ok(!/>A</.test(withPhoto), 'the photo replaces the initial');
});
