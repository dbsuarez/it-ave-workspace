const test = require('node:test');
const assert = require('node:assert/strict');
const {
  filterSlashItems, slashTrigger, parseSlashLine, applySlashItem, continueList, wrapSelection, SLASH_ITEMS,
} = require('../src/features/canvas-slash');

const item = (id) => SLASH_ITEMS.find((i) => i.id === id);
const apply = (value, cursor, id, options) => applySlashItem(value, cursor, item(id), options);

test('menu opens only for a slash that starts the line', () => {
  assert.deepEqual(slashTrigger('/', 1), { query: '', start: 0, indent: '' });
  assert.equal(slashTrigger('hello /h1', 9), null, 'not mid-sentence');
  assert.equal(slashTrigger('see https://x.com/path', 22), null, 'urls are left alone');
  assert.equal(slashTrigger('first\n/ta', 9).query, 'ta');
  assert.equal(slashTrigger('/h1 text', 8), null, 'a space ends the command word');
  assert.equal(slashTrigger('  /list', 7).indent, '  ');
});

test('filtering ranks exact and prefix matches first', () => {
  assert.equal(filterSlashItems('').length, SLASH_ITEMS.length);
  assert.equal(filterSlashItems('h1')[0].id, 'h1');
  assert.equal(filterSlashItems('list')[0].id, 'list');
  assert.equal(filterSlashItems('tab')[0].id, 'table');
  assert.equal(filterSlashItems('todo')[0].id, 'todo');
  assert.deepEqual(filterSlashItems('zzzz'), []);
});

test('picking an item replaces the slash line', () => {
  assert.equal(apply('/h1', 3, 'h1').value, '# ');
  assert.equal(apply('a\n/list', 7, 'list').value, 'a\n- ');
  assert.equal(apply('/todo', 5, 'todo').value, '- [ ] ');
  const r = apply('/quote\nafter', 6, 'quote');
  assert.equal(r.value, '> \nafter');
  assert.equal(r.selectStart, 2, 'cursor sits after the marker');
});

test('"/h1 text" puts the text into the block', () => {
  const parsed = parseSlashLine('/h1 My plan');
  assert.equal(parsed.item.id, 'h1');
  assert.equal(parsed.text, 'My plan');
  const r = apply('/h1 My plan', 11, 'h1', { text: parsed.text });
  assert.equal(r.value, '# My plan');
  assert.equal(parseSlashLine('/nonsense text'), null);
  assert.equal(parseSlashLine('plain text'), null);
});

test('table, code, callout and divider insert ready-to-use Markdown', () => {
  const table = apply('/table', 6, 'table');
  assert.equal(table.value, '| Column 1 | Column 2 |\n| --- | --- |\n|  |  |');
  assert.equal(table.value.slice(table.selectStart, table.selectEnd), 'Column 1', 'first header cell is selected');
  const code = apply('/code', 5, 'code');
  assert.equal(code.value, '```\n\n```');
  assert.equal(code.selectStart, 4);
  assert.equal(apply('/tip', 4, 'tip').value, '> [!tip]\n> ');
  const hr = apply('/divider', 8, 'divider');
  assert.equal(hr.value, '---\n');
  assert.equal(hr.selectStart, 4);
  const mid = apply('/divider\nnext', 8, 'divider');
  assert.equal(mid.value, '---\nnext');
  assert.equal(mid.selectStart, 4);
  assert.match(apply('/date', 5, 'date', { today: '2026-11-11' }).value, /^2026-11-11$/);
});

test('indentation of a nested line is kept', () => {
  assert.equal(apply('- one\n  /list', 13, 'list').value, '- one\n  - ');
});

test('Enter continues lists and ends them when the item is empty', () => {
  assert.equal(continueList('- one', 5).value, '- one\n- ');
  assert.equal(continueList('3. three', 8).value, '3. three\n4. ');
  assert.equal(continueList('- [x] done', 10).value, '- [x] done\n- [ ] ');
  assert.equal(continueList('  - nested', 10).value, '  - nested\n  - ');
  assert.equal(continueList('- one\n- ', 8).value, '- one\n', 'empty item ends the list');
  assert.equal(continueList('plain', 5), null);
  assert.equal(continueList('- one', 2), null, 'only at the end of the line');
});

test('formatting shortcuts wrap and unwrap the selection', () => {
  assert.equal(wrapSelection('say hi now', 4, 6, 'bold').value, 'say **hi** now');
  assert.equal(wrapSelection('say **hi** now', 4, 10, 'bold').value, 'say hi now');
  assert.equal(wrapSelection('x', 0, 1, 'italic').value, '*x*');
  const link = wrapSelection('see docs', 4, 8, 'link');
  assert.equal(link.value, 'see [docs](https://)');
  assert.equal(link.value.slice(link.selectStart, link.selectEnd), 'https://');
});

const { toolbarAction, TOOLBAR_BUTTONS } = require('../src/features/canvas-slash');

test('toolbar: line buttons set, switch and remove the marker', () => {
  assert.equal(toolbarAction('hello', 5, 5, 'h1').value, '# hello');
  assert.equal(toolbarAction('# hello', 7, 7, 'h1').value, 'hello', 'same button again removes it');
  assert.equal(toolbarAction('# hello', 7, 7, 'h2').value, '## hello', 'a different one switches it');
  assert.equal(toolbarAction('one\ntwo', 5, 5, 'list').value, 'one\n- two', 'only the cursor line changes');
  assert.equal(toolbarAction('- item', 6, 6, 'todo').value, '- [ ] item');
  assert.equal(toolbarAction('4. item', 7, 7, 'numbered').value, 'item');
  assert.equal(toolbarAction('hi', 2, 2, 'quote').value, '> hi');
  assert.equal(toolbarAction('hello', 3, 3, 'h1').selectStart, 5, 'cursor stays on the same character');
});

test('toolbar: block buttons add a block after the current line', () => {
  assert.equal(toolbarAction('intro', 5, 5, 'divider').value, 'intro\n\n---\n');
  assert.equal(toolbarAction('', 0, 0, 'divider').value, '---\n');
  const t = toolbarAction('intro\nmore', 2, 2, 'table');
  assert.equal(t.value, 'intro\n\n| Column 1 | Column 2 |\n| --- | --- |\n|  |  |\nmore');
  assert.equal(t.value.slice(t.selectStart, t.selectEnd), 'Column 1');
  assert.equal(toolbarAction('say hi', 4, 6, 'bold').value, 'say **hi**');
  assert.ok(TOOLBAR_BUTTONS.filter((b) => !b.sep).every((b) => b.id && b.title));
});

const { insertImageBlock } = require('../src/features/canvas-slash');

test('image: /image is in the menu and empties its line', () => {
  assert.equal(filterSlashItems('image')[0].id, 'image');
  assert.equal(filterSlashItems('photo')[0].id, 'image');
  assert.equal(apply('/image', 6, 'image').value, '');
  assert.equal(toolbarAction('text', 4, 4, 'image').value, 'text', 'the toolbar button opens the picker instead');
});

test('image: the uploaded picture becomes its own block', () => {
  assert.equal(insertImageBlock('', 0, 7, 'My Photo.png').value, '![My Photo](file:7)\n');
  assert.equal(insertImageBlock('intro', 5, 7, 'a.png').value, 'intro\n\n![a](file:7)\n');
  assert.equal(insertImageBlock('one\n\ntwo', 4, 3, 'x.jpg').value, 'one\n\n![x](file:3)\n\ntwo', 'an empty line is replaced, neighbours stay separate blocks');
  const r = insertImageBlock('', 0, 7, 'a.png');
  assert.equal(r.selectStart, r.value.length, 'cursor lands after the picture');
  assert.equal(insertImageBlock('', 0, 1, 'we](ird)[.png').value, '![we  ird](file:1)\n', 'brackets in a name cannot break the syntax');
});
