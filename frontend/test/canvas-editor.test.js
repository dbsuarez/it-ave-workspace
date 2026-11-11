// The rich-text editor must turn Markdown into a page and back without losing or inventing content.
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const dom = new JSDOM('<!doctype html><body></body>', { pretendToBeVisual: true });
for (const key of ['window', 'document', 'navigator', 'Node', 'HTMLElement', 'Element', 'Text', 'DocumentFragment', 'MutationObserver', 'getComputedStyle', 'requestAnimationFrame', 'Range', 'Selection', 'DOMParser', 'XMLSerializer', 'KeyboardEvent', 'Event']) {
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true, writable: true });
}
const { createCanvasEditor, getCanvasMarkdown, normalizeMarkdown, loadMarkdown } = require('../editor-src/canvas-editor');

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

test('picture size and alignment survive in the standard Markdown title', () => {
  for (const md of [
    'Before\n\n![pic](file:3 "50% center")\n\nAfter\n',
    '![pic](file:3 "75%")\n',
    '![pic](file:3 "right")\n',
    '![pic](file:3)\n',
  ]) {
    assert.equal(roundTrip(md), md);
  }
  // full width is the default and is not written out
  const editor = open('![pic](file:3)\n');
  editor.commands.updateAttributes('image', { width: 100, align: 'left' });
  assert.equal(getCanvasMarkdown(editor), '![pic](file:3)\n');
  editor.destroy();
  const { parseImageTitle, imageTitle } = require('../editor-src/canvas-editor');
  assert.deepEqual(parseImageTitle('50% center'), { width: 50, align: 'center' });
  assert.deepEqual(parseImageTitle('nonsense 500% up'), { width: 100, align: 'left' });
  assert.equal(imageTitle({ width: 25, align: 'right' }), '25% right');
});

test('the picture node exposes its size and alignment to the page', () => {
  const editor = open('![pic](file:3 "50% center")\n');
  const figure = editor.view.dom.querySelector('figure.cw-image');
  assert.equal(figure.getAttribute('data-align'), 'center');
  assert.equal(figure.querySelector('.cw-image-frame').style.width, '50%');
  assert.ok(figure.querySelector('.cw-image-handle'), 'there is a resize handle');
  editor.destroy();
});

test('table cell alignment and header toggles round trip', () => {
  const editor = open('| a | b |\n| :-- | --: |\n| 1 | 2 |\n');
  editor.commands.setTextSelection(editor.state.doc.content.size - 3);
  editor.commands.addRowAfter();
  editor.commands.addColumnAfter();
  const md = getCanvasMarkdown(editor);
  assert.equal(md.trim().split('\n').length, 4, 'a header, a separator and two rows');
  assert.match(md.split('\n')[1], /^\| :-+ \| -+: \| -+ \|$/);
  editor.destroy();
});

test('column widths are kept in the separator row and come back', () => {
  const md = '| a | b | c |\n| ------------ | --- | ------ |\n| 1 | 2 | 3 |\n';
  const editor = open(md);
  const widths = [];
  editor.state.doc.firstChild.firstChild.forEach((cell) => widths.push(cell.attrs.colwidth && cell.attrs.colwidth[0]));
  assert.deepEqual(widths, [120, null, 60], '12 dashes = 120px, 3 dashes = automatic, 6 dashes = 60px');
  const out = getCanvasMarkdown(editor);
  assert.match(out.split('\n')[1], /^\| -{12} \| -{3} \| -{6} \|$/);
  editor.destroy();
  assert.equal(roundTrip(out), out, 'stable on a second pass');
});

test('a table with automatic widths keeps the plain three-dash separator', () => {
  const out = roundTrip('| Milestone | Owner |\n| --- | --- |\n| First | (name) |\n');
  assert.match(out.split('\n')[1], /^\| -{3} \| -{3} \|$/);
});

test('resizing a column in the page changes the saved separator', () => {
  const editor = open('| a | b |\n| --- | --- |\n| 1 | 2 |\n');
  const tr = editor.state.tr;
  editor.state.doc.descendants((node, pos) => {
    if ((node.type.name === 'tableHeader' || node.type.name === 'tableCell') && !node.attrs.colwidth) {
      // the first column of every row becomes 200px wide
    }
  });
  let column = 0;
  editor.state.doc.firstChild.forEach((row, rowOffset) => {
    row.forEach((cell, cellOffset, index) => {
      if (index === 0) tr.setNodeMarkup(1 + rowOffset + 1 + cellOffset, undefined, { ...cell.attrs, colwidth: [200] });
      column += 1;
    });
  });
  editor.view.dispatch(tr);
  assert.match(getCanvasMarkdown(editor).split('\n')[1], /^\| -{20} \| -{3} \|$/);
  editor.destroy();
});

test('auto-fit widths: natural when they fit, shrunk together when they do not, never below the minimum', () => {
  const { fitColumnWidths } = require('../editor-src/canvas-editor');
  assert.deepEqual(fitColumnWidths([100, 150], 600), [100, 150]);
  assert.deepEqual(fitColumnWidths([10, 20], 600), [60, 60], 'tiny columns get the minimum');
  const shrunk = fitColumnWidths([400, 400, 400], 600);
  assert.ok(shrunk.reduce((a, b) => a + b, 0) <= 600);
  assert.ok(shrunk.every((w) => w >= 60 && w === shrunk[0]), 'equal columns stay equal');
  const mixed = fitColumnWidths([60, 500, 300], 500);
  assert.equal(mixed[0], 60, 'a column already at the minimum is left alone');
  assert.ok(mixed.reduce((a, b) => a + b, 0) <= 500);
  assert.ok(mixed[1] > mixed[2], 'the wider column stays wider');
});

test('mentions are one unit, saved as plain @name, and never confused with emails or code', () => {
  const md = 'Hello @ann and @bob_smith, see `@code` or mail ann@example.com.\n';
  const out = roundTrip(md);
  // the email becomes an ordinary mailto link (the editor's autolinking); it is not a mention
  assert.equal(out, 'Hello @ann and @bob_smith, see `@code` or mail [ann@example.com](mailto:ann@example.com).\n');
  assert.equal(roundTrip(out), out, 'stable');
  const editor = open(md);
  const names = [];
  editor.state.doc.descendants((node) => { if (node.type.name === 'mention') names.push(node.attrs.username); });
  assert.deepEqual(names, ['ann', 'bob_smith'], 'only real mentions, not the email or the code');
  editor.destroy();
  assert.equal(roundTrip('Thanks @ann.\n'), 'Thanks @ann.\n', 'a final full stop is not part of the name');
  assert.equal(roundTrip('@ann\n'), '@ann\n');
});

test('a mention alone on its line becomes a profile card, with details from the app', () => {
  globalThis.canvasMentionLookup = (name) => (name === 'ann'
    ? { username: 'ann', email: 'ann@itavenue.ph', jobTitle: 'IT Manager', status: 'online', statusText: 'In a meeting', avatarColor: '#123456', accountType: 'member' }
    : null);
  try {
    const editor = open('@ann\n\nHello @ann and @zed\n');
    const dom = editor.view.dom;
    const solo = dom.querySelectorAll('.cw-mention-solo');
    assert.equal(solo.length, 1, 'only the line with just a mention');
    const card = solo[0].querySelector('.cw-mention-card');
    assert.ok(card, 'the solo mention has a card');
    assert.match(card.textContent, /ann/);
    assert.match(card.textContent, /IT Manager/);
    assert.match(card.textContent, /In a meeting/);
    assert.match(card.textContent, /ann@itavenue\.ph/);
    assert.equal(card.querySelector('.cw-mention-avatar').style.background, 'rgb(18, 52, 86)');
    assert.ok(card.querySelector('.cw-mention-presence.online'), 'a green presence dot for someone online');
    assert.equal(card.querySelector('[data-message-user]'), null, 'no Message button without an id');
    // inline mentions are chips; an unknown person has no card at all
    const inline = dom.querySelectorAll('p:not(.cw-mention-solo) .cw-mention');
    assert.equal(inline.length, 2);
    assert.ok(!inline[1].querySelector('.cw-mention-card'), 'an unknown person is just a chip');
    editor.destroy();
  } finally {
    delete globalThis.canvasMentionLookup;
  }
});

test('a picture inside a table cell is a real, selectable picture, and deleting it can be undone', () => {
  const md = '| a | b |\n| --- | --- |\n| ![shot](file:5 "50%") | text |\n';
  const editor = open(md);
  const pictures = () => { let n = 0; editor.state.doc.descendants((node) => { if (node.type.name === 'image') n += 1; }); return n; };
  assert.equal(pictures(), 1);
  assert.equal(editor.view.dom.querySelectorAll('td img[data-cv-file], th img[data-cv-file]').length, 1);
  let at = -1;
  editor.state.doc.descendants((node, pos) => { if (node.type.name === 'image') at = pos; });
  editor.commands.setNodeSelection(at);
  assert.equal(editor.state.selection.node.type.name, 'image', 'clicking it selects it, so its bar and delete work');
  editor.commands.deleteSelection();
  assert.equal(pictures(), 0);
  assert.ok(!getCanvasMarkdown(editor).includes('file:5'));
  editor.commands.undo();
  assert.equal(pictures(), 1, 'undo brings it back');
  assert.match(getCanvasMarkdown(editor), /!\[shot\]\(file:5 "50%"\)/);
  editor.destroy();
});

test('a picture on its own line behaves the same way and still saves the same Markdown', () => {
  const md = 'Before\n\n![pic](file:3 "50% center")\n\nAfter\n';
  const editor = open(md);
  assert.equal(getCanvasMarkdown(editor), md);
  editor.destroy();
});

test('loading a page is not an undo step', () => {
  const editor = open('# First\n\nOne\n');
  loadMarkdown(editor, '# Second\n\nTwo\n');
  assert.match(getCanvasMarkdown(editor), /Second/);
  editor.commands.undo();
  assert.match(getCanvasMarkdown(editor), /Second/, 'undo does not bring back the previous page');
  // a real edit after loading is undoable, back to the loaded page
  editor.commands.setTextSelection(editor.state.doc.content.size - 1);
  editor.commands.insertContent(' typed');
  assert.match(getCanvasMarkdown(editor), /typed/);
  editor.commands.undo();
  assert.ok(!/typed/.test(getCanvasMarkdown(editor)));
  assert.match(getCanvasMarkdown(editor), /Second/);
  editor.destroy();
});
