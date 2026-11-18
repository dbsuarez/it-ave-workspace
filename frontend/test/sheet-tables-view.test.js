const test = require('node:test');
const assert = require('node:assert/strict');
const { sheetTablesHtml, sheetTableFormHtml, sheetProblemsHtml, columnsFromHeader } = require('../src/features/sheet-tables-view');

const table = (extra = {}) => ({ name: 'holidays', tabId: 'a', tabName: 'Holidays', columns: [{ name: 'Date', type: 'date', required: true }, { name: 'Name', type: 'text', required: false }], published: null, ...extra });

test('each table is listed with its tab and columns, and says whether it is published', () => {
  const html = sheetTablesHtml({ tables: [table(), table({ name: 'credits', tabName: 'Credits', published: { at: '2026-11-19T10:00:00Z', by: 'hr', rowCount: 12, stale: false }, columns: [{ name: 'Days', type: 'number', required: false }] })], canEdit: true, now: new Date('2026-11-19T10:05:00Z') });
  assert.equal((html.match(/data-sheet-table="/g) || []).length, 2);
  assert.match(html, /holidays/);
  assert.match(html, /Holidays/);
  assert.match(html, /Date \(date\), Name \(text\)/);
  assert.match(html, /Not published/);
  assert.match(html, /Published 5 min ago by hr · 12 rows/);
});

test('a table whose sheet changed since it was published says so', () => {
  const html = sheetTablesHtml({ tables: [table({ published: { at: '2026-11-19T10:00:00Z', by: 'hr', rowCount: 1, stale: true } })], canEdit: true, now: new Date('2026-11-19T10:05:00Z') });
  assert.match(html, /changed since/i);
});

test('editors get Edit, Check, Publish and Remove; viewers only see the list', () => {
  const editor = sheetTablesHtml({ tables: [table()], canEdit: true });
  for (const hook of ['data-sheet-table-edit', 'data-sheet-table-check', 'data-sheet-table-publish', 'data-sheet-table-remove', 'data-sheet-table-new']) assert.ok(editor.includes(hook), hook);
  const viewer = sheetTablesHtml({ tables: [table()], canEdit: false });
  assert.doesNotMatch(viewer, /data-sheet-table-(edit|check|publish|remove|new)/);
  assert.match(sheetTablesHtml({ tables: [], canEdit: true }), /No tables yet/);
});

test('names and tab names are escaped', () => {
  const html = sheetTablesHtml({ tables: [table({ name: 'x', tabName: '<img src=x>', columns: [{ name: '<b>', type: 'text', required: false }] })], canEdit: true });
  assert.doesNotMatch(html, /<img|<b>/);
});

test('the form picks a tab, names the table, and edits the columns with a type and a required box', () => {
  const html = sheetTableFormHtml({ tabs: [{ id: 'a', name: 'Holidays' }, { id: 'b', name: 'Credits' }], draft: { name: 'holidays', tabId: 'b', columns: [{ name: 'Date', type: 'date', required: true }], isNew: true } });
  assert.match(html, /data-table-name[^>]*value="holidays"/);
  assert.match(html, /<option value="b" selected>Credits<\/option>/);
  assert.match(html, /data-table-column-name[^>]*value="Date"/);
  assert.match(html, /<option value="date" selected>/);
  assert.match(html, /data-table-column-required[^>]*checked/);
  assert.match(html, /data-table-add-column/);
  assert.match(html, /data-table-from-header/);
  assert.match(html, /data-table-save/);
  for (const type of ['text', 'number', 'date', 'yesno', 'person']) assert.ok(html.includes(`value="${type}"`), type);
});

test('an existing table cannot be renamed, and a new one can', () => {
  const draft = { name: 'holidays', tabId: 'a', columns: [{ name: 'A', type: 'text', required: false }] };
  assert.match(sheetTableFormHtml({ tabs: [{ id: 'a', name: 'T' }], draft: { ...draft, isNew: false } }), /data-table-name[^>]*readonly/);
  assert.doesNotMatch(sheetTableFormHtml({ tabs: [{ id: 'a', name: 'T' }], draft: { ...draft, isNew: true } }), /data-table-name[^>]*readonly/);
});

test('a check result says all is well with the row count, or lists the problems by row and column', () => {
  assert.match(sheetProblemsHtml({ ok: true, rowCount: 12, problems: [], problemCount: 0 }), /12 rows are good/);
  assert.match(sheetProblemsHtml({ ok: true, rowCount: 1, problems: [], problemCount: 0 }), /1 row is good/);
  const html = sheetProblemsHtml({ ok: false, rowCount: 0, problemCount: 52, problems: [{ row: 3, column: 'Date', message: 'Date "x" is not a real date' }, { row: 1, column: '', message: 'The header row is missing' }] });
  assert.match(html, /Row 3, Date/);
  assert.match(html, /not a real date/);
  assert.match(html, /Row 1/);
  assert.match(html, /and 50 more/);
  assert.match(html, /nothing is published/i);
  assert.doesNotMatch(sheetProblemsHtml({ ok: false, rowCount: 0, problemCount: 1, problems: [{ row: 2, column: '<b>', message: '<script>' }] }), /<script>|<b>/);
});

test('the header row of a tab becomes a list of text columns, up to the first empty cell', () => {
  assert.deepEqual(columnsFromHeader(['Date', ' Name ', 'Days', '', 'ignored']), [
    { name: 'Date', type: 'text', required: false }, { name: 'Name', type: 'text', required: false }, { name: 'Days', type: 'text', required: false },
  ]);
  assert.deepEqual(columnsFromHeader([]), []);
  assert.equal(columnsFromHeader(Array.from({ length: 80 }, (_, i) => `c${i}`)).length, 50);
  assert.deepEqual(columnsFromHeader(['A', 'a', 'B']).map((c) => c.name), ['A', 'B'], 'a repeated name is dropped');
});
