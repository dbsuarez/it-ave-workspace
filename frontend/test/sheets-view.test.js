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

const { sheetShareHtml } = require('../src/features/sheets-view');

test('the bar has export for everyone, import for editors, and share and delete only for the owner', () => {
  const owner = sheetBarHtml({ sheet: sheet(), status: 'saved', isOwner: true });
  for (const hook of ['data-sheet-export', 'data-sheet-import', 'data-sheet-share', 'data-sheet-delete', 'data-sheet-tables']) assert.ok(owner.includes(hook), hook);
  const editor = sheetBarHtml({ sheet: sheet(), status: 'saved', isOwner: false });
  assert.match(editor, /data-sheet-export/);
  assert.match(editor, /data-sheet-import/);
  assert.doesNotMatch(editor, /data-sheet-share|data-sheet-delete/);
  const viewer = sheetBarHtml({ sheet: sheet({ role: 'viewer' }), status: 'viewing', isOwner: false });
  assert.match(viewer, /data-sheet-export/);
  assert.doesNotMatch(viewer, /data-sheet-import|data-sheet-share|data-sheet-delete/);
});

test('the share dialog lists who has access with a role and a remove button, and can add a person with a role', () => {
  const html = sheetShareHtml({ sheet: sheet(), members: [{ userId: 4, username: 'ann', role: 'viewer' }, { userId: 5, username: '<b>bob</b>', role: 'editor' }], people: ['Cara (cara)'] });
  assert.match(html, /Share "Holidays 2027"/);
  assert.match(html, /data-sheet-member-role="4"/);
  assert.match(html, /data-sheet-member-remove="5"/);
  assert.match(html, /<option value="viewer" selected>/);
  assert.doesNotMatch(html, /<b>bob/);
  assert.match(html, /data-sheet-add-person/);
  assert.match(html, /<option value="Cara \(cara\)">/);
  assert.match(sheetShareHtml({ sheet: sheet(), members: [], people: [] }), /Not shared with anyone yet/);
});
