// The rich-text editor must turn Markdown into a page and back without losing or inventing content.
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const dom = new JSDOM('<!doctype html><body></body>', { pretendToBeVisual: true });
for (const key of ['window', 'document', 'navigator', 'Node', 'HTMLElement', 'Element', 'Text', 'DocumentFragment', 'MutationObserver', 'getComputedStyle', 'requestAnimationFrame', 'Range', 'Selection', 'DOMParser', 'XMLSerializer', 'KeyboardEvent', 'Event']) {
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true, writable: true });
}
const { createCanvasEditor, getCanvasMarkdown, normalizeMarkdown } = require('../editor-src/canvas-editor');

function open(markdown) {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return createCanvasEditor(el, { content: markdown });
}
const roundTrip = (markdown) => {
  const editor = open(markdown);
  const out = getCanvasMarkdown(editor);
  editor.destroy();
  return out;
};

test('plain Markdown blocks come back unchanged', () => {
  for (const md of [
    '# Title\n\n## Sub\n\nText with **bold**, *italic*, `code` and a [link](https://example.com).\n',
    '- one\n- two\n  - nested\n\n1. first\n2. second\n',
    '- [ ] open item\n- [x] done item\n',
    '> a quote\n> second line\n',
    '```js\nconst x = 1;\n\n\nconst y = 2;\n```\n',
    'before\n\n---\n\nafter\n',
    'Intro\n\n![purple test](file:20)\n\nOutro\n',
  ]) {
    assert.equal(roundTrip(md), md);
  }
});

test('a second round trip changes nothing (the saved form is stable)', () => {
  const md = '# Plan\n\n> [!info] Goal\n> Ship it.\n\n## Tasks\n\n- [ ] First\n- [x] Second\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n![pic](file:3)\n';
  const once = roundTrip(md);
  assert.equal(roundTrip(once), once);
});

test('callouts keep their type; a title becomes a bold first line', () => {
  const out = roundTrip('> [!info] Goal\n> One sentence.\n\n> [!danger]\n> Careful.\n');
  assert.match(out, /^> \[!info\]\n> \*\*Goal\*\*/);
  assert.match(out, /> One sentence\./);
  assert.match(out, /> \[!danger\]\n> Careful\./);
  assert.ok(!out.includes('> [!danger]\n> \n'), 'no stray markers');
  const editor = open('> [!tip] Hint\n> Try this.\n');
  const types = [];
  editor.state.doc.descendants((node) => { if (node.type.name === 'callout') types.push(node.attrs.type); });
  assert.deepEqual(types, ['tip']);
  editor.destroy();
});

test('tables stay tables, with alignment, and without stray blank lines', () => {
  const out = roundTrip('| Milestone | Owner |\n| --- | --- |\n| First | (name) |\n| Second | Bob |\n');
  assert.ok(out.startsWith('| Milestone'), 'no leading blank line');
  const rows = out.trim().split('\n');
  assert.equal(rows.length, 4);
  assert.match(rows[1], /^\|[ :-]+\|[ :-]+\|$/);
  assert.match(rows[3], /Second\s*\|\s*Bob\s*\|/);
  const aligned = roundTrip('| a | b | c |\n| :-- | :-: | --: |\n| 1 | 2 | 3 |\n');
  assert.match(aligned.split('\n')[1], /^\| :-+ \| :-+: \| -+: \|$/);
});

test('unsafe content never survives: remote images are text, scripts are dropped', () => {
  const remote = roundTrip('![evil](https://evil.test/a.png)\n');
  assert.ok(!remote.startsWith('![evil]('), 'not an image any more');
  const editor = open('![evil](https://evil.test/a.png)\n');
  assert.equal(editor.view.dom.querySelectorAll('img').length, 0);
  editor.destroy();
  const html = roundTrip('Text <script>alert(1)</script> <img src=x onerror=alert(1)> <b>b</b>\n');
  assert.ok(!/script|onerror|<img/i.test(html));
});

test('a canvas picture renders without any URL, only the file id', () => {
  const editor = open('![logo](file:7)\n');
  const img = editor.view.dom.querySelector('img');
  assert.equal(img.getAttribute('data-cv-file'), '7');
  assert.equal(img.getAttribute('src'), null);
  assert.equal(img.getAttribute('alt'), 'logo');
  editor.destroy();
});

test('an empty page saves as empty text', () => {
  assert.equal(roundTrip(''), '');
  assert.equal(roundTrip('\n\n'), '');
});

test('every template survives a round trip with its structure intact', () => {
  const { CANVAS_TEMPLATES } = require('../src/features/canvas-slash');
  for (const tpl of CANVAS_TEMPLATES) {
    const out = roundTrip(tpl.content);
    assert.equal(roundTrip(out), out, `${tpl.id} is stable`);
    assert.match(out, /^# /, `${tpl.id} keeps its title`);
    for (const word of tpl.content.match(/[A-Z][a-z]{3,}/g) || []) assert.ok(out.includes(word), `${tpl.id} keeps "${word}"`);
  }
});

test('normalizing leaves code fences alone and trims the edges', () => {
  assert.equal(normalizeMarkdown('\n\n# A\n\n\n\nB\n\n\n'), '# A\n\nB\n');
  assert.equal(normalizeMarkdown('```\na\n\n\n\nb\n```'), '```\na\n\n\n\nb\n```\n');
  assert.equal(normalizeMarkdown('   '), '');
});

test('commands used by the toolbar and slash menu produce the expected Markdown', () => {
  const cases = [
    ['ship it', (c) => c.toggleTaskList(), /^- \[ \] ship it/],
    ['ship it', (c) => c.toggleBulletList(), /^- ship it/],
    ['ship it', (c) => c.toggleOrderedList(), /^1\. ship it/],
    ['ship it', (c) => c.setHeading({ level: 2 }), /^## ship it/],
    ['ship it', (c) => c.toggleBlockquote(), /^> ship it/],
    ['ship it', (c) => c.toggleBold(), /^\*\*ship it\*\*/],
    ['ship it', (c) => c.toggleCodeBlock(), /^```\nship it\n```/],
  ];
  for (const [text, run, expected] of cases) {
    const editor = open(text);
    run(editor.chain().selectAll()).run();
    assert.match(getCanvasMarkdown(editor), expected);
    editor.destroy();
  }
  const table = open('');
  table.chain().insertTable({ rows: 2, cols: 2, withHeaderRow: true }).run();
  assert.equal(getCanvasMarkdown(table).trim().split('\n').length, 3, 'a header, a separator and one row');
  table.destroy();
});
