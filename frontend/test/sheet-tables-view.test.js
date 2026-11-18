const test = require('node:test');
const assert = require('node:assert/strict');
const { sheetTablesHtml, sheetTableFormHtml, sheetProblemsHtml, columnsFromHeader, feedColumnsFit, feedColumnsFor, sheetFeedPreviewHtml } = require('../src/features/sheet-tables-view');

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

test('a table that feeds Leave says so in the list', () => {
  const html = sheetTablesHtml({ tables: [table({ feeds: 'holidays' }), table({ name: 'plain' })], canEdit: true });
  assert.equal((html.match(/data-sheet-table-feeds/g) || []).length, 1);
  assert.match(html, /Feeds Leave: company holidays/);
});

test('the form offers "feeds Leave" only to people who may use it, with the current choice selected', () => {
  const tabs = [{ id: 'a', name: 'Holidays' }];
  const draft = { name: 'holidays', tabId: 'a', columns: [], isNew: true, feeds: 'credits' };
  const withIt = sheetTableFormHtml({ tabs, draft, canFeed: true });
  assert.match(withIt, /data-table-feeds/);
  assert.match(withIt, /<option value="credits" selected>/);
  assert.equal(/data-table-feeds/.test(sheetTableFormHtml({ tabs, draft, canFeed: false })), false);
});

test('the columns a feed needs are found in any case, and picking a feed gives exactly those columns', () => {
  assert.equal(feedColumnsFit('holidays', [{ name: 'Date', type: 'date' }, { name: 'NAME', type: 'text' }, { name: 'note', type: 'text' }]), true);
  assert.equal(feedColumnsFit('holidays', [{ name: 'date', type: 'text' }, { name: 'name', type: 'text' }]), false);
  assert.equal(feedColumnsFit('credits', [{ name: 'person', type: 'person' }]), false);
  assert.equal(feedColumnsFit('', []), true, 'no feed needs nothing');
  assert.deepEqual(feedColumnsFor('credits').map((c) => [c.name, c.type, c.required]), [['person', 'person', true], ['leave_type', 'text', true], ['year', 'number', true], ['days', 'number', true]]);
  assert.deepEqual(feedColumnsFor('holidays').map((c) => c.name), ['date', 'name']);
});

test('the holidays preview lists what is added, renamed and removed, with the removals stood out', () => {
  const html = sheetFeedPreviewHtml({ feeds: 'holidays', name: 'holidays', preview: {
    years: [2027], unchanged: 4,
    add: [{ day: '2027-12-25', name: 'Christmas <b>' }], rename: [{ day: '2027-04-09', from: 'Valor Day', to: 'Araw ng Kagitingan' }], remove: [{ day: '2027-06-12', name: 'Independence Day' }],
  } });
  assert.match(html, /2027/);
  assert.match(html, /Add \(1\)/);
  assert.match(html, /2027-12-25/);
  assert.match(html, /Christmas &lt;b&gt;/);
  assert.match(html, /Valor Day.*Araw ng Kagitingan/);
  assert.match(html, /<strong[^>]*>Remove \(1\)/);
  assert.match(html, /Independence Day/);
  assert.match(html, /4 stay the same/);
  assert.match(html, /data-sheet-feed-apply="holidays"/);
  assert.match(html, /data-sheet-feed-cancel/);
});

test('the credits preview lists new and changed days and the ones that go back to the default; an empty plan says nothing changes', () => {
  const html = sheetFeedPreviewHtml({ feeds: 'credits', name: 'credits', preview: {
    years: [2027], unchanged: 0,
    set: [{ username: 'ann', typeName: 'Vacation Leave', year: 2027, adjustment: 3, previous: 1 }],
    reset: [{ username: 'cy', typeName: 'Vacation Leave', year: 2027, previous: 2 }],
  } });
  assert.match(html, /ann/);
  assert.match(html, /Vacation Leave 2027: 1 to 3/);
  assert.match(html, /<strong[^>]*>Back to the default \(1\)/);
  assert.match(html, /cy.*2 to none/);
  const none = sheetFeedPreviewHtml({ feeds: 'holidays', name: 'holidays', preview: { years: [2027], unchanged: 5, add: [], rename: [], remove: [] } });
  assert.match(none, /No change to Leave/);
});
