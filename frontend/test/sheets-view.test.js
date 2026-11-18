const test = require('node:test');
const assert = require('node:assert/strict');
const { sheetListHtml, sheetBarHtml } = require('../src/features/sheets-view');

const sheet = (extra = {}) => ({ id: 7, title: 'Holidays 2027', ownerUsername: 'hr', role: 'editor', tabCount: 2, updatedText: '5 min ago', ...extra });

test('the list has a row for each sheet that opens it, with owner, tab count and age, and says so when empty', () => {
  const html = sheetListHtml([sheet(), sheet({ id: 8, title: 'Credits', tabCount: 1 })]);
  assert.equal((html.match(/data-sheet-open="/g) || []).length, 2);
  assert.match(html, /Holidays 2027/);
  assert.match(html, /hr · 2 tabs · 5 min ago/);
  assert.match(html, /1 tab ·/);
  assert.match(sheetListHtml([], { empty: 'Nothing yet.' }), /Nothing yet\./);
});

test('a sheet that is only shared to look at says so, and every value is escaped', () => {
  assert.match(sheetListHtml([sheet({ role: 'viewer' })]), /View only/);
  assert.doesNotMatch(sheetListHtml([sheet()]), /View only/);
  const html = sheetListHtml([sheet({ title: '<img src=x onerror=1>', ownerUsername: '"><b>' })]);
  assert.doesNotMatch(html, /<img|<b>/);
});

test('the top bar has the title, a way back and the save status, and only editors can rename', () => {
  const editor = sheetBarHtml({ sheet: sheet(), status: 'saving' });
  assert.match(editor, /data-sheet-back/);
  assert.match(editor, /Holidays 2027/);
  assert.match(editor, /data-sheet-rename/);
  assert.match(editor, /data-status="saving"[^>]*>Saving\.\.\./);
  const viewer = sheetBarHtml({ sheet: sheet({ role: 'viewer' }), status: 'viewing' });
  assert.doesNotMatch(viewer, /data-sheet-rename/);
  assert.match(viewer, /View only/);
  assert.doesNotMatch(sheetBarHtml({ sheet: sheet({ title: '<script>x</script>' }) }), /<script>/);
});
