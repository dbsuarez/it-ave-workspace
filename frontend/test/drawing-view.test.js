const test = require('node:test');
const assert = require('node:assert/strict');
const { drawingCardHtml, drawingCardRemovedHtml, drawingListHtml } = require('../src/features/drawing-view');

const drawing = (extra = {}) => ({ id: 7, title: 'Network map', ownerUsername: 'ann', updatedText: '5 min ago', kind: 'channel', role: 'editor', readOnlyReason: null, ...extra });

test('a card shows the title and an Open button for the drawing', () => {
  const html = drawingCardHtml(drawing());
  assert.match(html, /data-drawing-open="7"/);
  assert.match(html, /Network map/);
  assert.match(html, /Open/);
  assert.match(html, /class="drawing-card"/);
});

test('a removed drawing shows a plain notice with nothing to open', () => {
  const html = drawingCardRemovedHtml();
  assert.match(html, /Drawing removed/);
  assert.doesNotMatch(html, /data-drawing-open/);
});

test('every value is escaped, in a card and in a list', () => {
  const evil = drawing({ title: '<img src=x onerror=alert(1)>', ownerUsername: '<script>x</script>', updatedText: '"><b>' });
  for (const html of [drawingCardHtml(evil), drawingListHtml([evil], {})]) {
    assert.doesNotMatch(html, /<img|<script>|<b>/);
    assert.match(html, /&lt;/);
  }
});

test('the list shows title, owner and the time passed in, and opens each drawing', () => {
  const html = drawingListHtml([drawing(), drawing({ id: 8, title: 'Second', ownerUsername: 'bob', updatedText: '2 h ago' })], {});
  assert.deepEqual([...html.matchAll(/data-drawing-open="(\d+)"/g)].map((m) => Number(m[1])), [7, 8]);
  assert.match(html, /ann/);
  assert.match(html, /5 min ago/);
  assert.match(html, /bob/);
});

test('view-only drawings say why: shared as viewer, locked, archived', () => {
  assert.match(drawingListHtml([drawing({ role: 'viewer' })], {}), /View only/);
  assert.match(drawingListHtml([drawing({ role: 'viewer', readOnlyReason: 'locked' })], {}), /Locked/);
  assert.match(drawingListHtml([drawing({ role: 'viewer', readOnlyReason: 'archived' })], {}), /Archived/);
  assert.doesNotMatch(drawingListHtml([drawing()], {}), /View only|Locked|Archived/);
});

test('an empty list shows the message it was given', () => {
  const html = drawingListHtml([], { empty: 'No drawings yet.' });
  assert.match(html, /No drawings yet\./);
  assert.doesNotMatch(html, /data-drawing-open/);
  assert.match(drawingListHtml([], {}), /No drawings/);
});
