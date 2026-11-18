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

const { drawingBarHtml, drawingShareHtml } = require('../src/features/drawing-view');

const bar = (extra = {}) => drawingBarHtml({
  drawing: { id: 7, title: 'Network map', kind: 'standalone', role: 'editor', readOnlyReason: null, ownerId: 1 },
  status: 'saved', statusText: 'Saved', present: [{ userId: 2, username: 'bob', color: '#0055ff' }], canShare: true, ...extra,
});

test('the editor bar has a way back, the title, the status, export, and who is here', () => {
  const html = bar();
  assert.match(html, /data-drawing-back/);
  assert.match(html, /Network map/);
  assert.match(html, /data-status="saved"[^>]*>Saved</);
  assert.match(html, /data-drawing-export="png"/);
  assert.match(html, /data-drawing-export="svg"/);
  assert.match(html, /title="bob"[^>]*style="background:#0055ff"/);
});

test('Share and Rename show only when allowed; a viewer sees a view-only banner instead', () => {
  assert.match(bar(), /data-drawing-share/);
  assert.match(bar(), /data-drawing-rename/);
  assert.doesNotMatch(bar({ canShare: false }), /data-drawing-share/);
  const viewer = bar({ drawing: { id: 7, title: 'T', kind: 'channel', role: 'viewer', readOnlyReason: null }, canShare: false });
  assert.match(viewer, /view this drawing but not change it/i);
  assert.doesNotMatch(viewer, /data-drawing-rename/);
  assert.match(bar({ drawing: { id: 7, title: 'T', kind: 'topic', role: 'viewer', readOnlyReason: 'locked' }, canShare: false }), /locked/i);
  assert.match(bar({ drawing: { id: 7, title: 'T', kind: 'channel', role: 'viewer', readOnlyReason: 'archived' }, canShare: false }), /archived/i);
});

test('when it cannot sync the bar says what happens to your work; the status text is shown for every state', () => {
  const html = bar({ status: 'cannot-sync', statusText: 'Cannot sync' });
  assert.match(html, /stay on this computer/i);
  assert.match(html, /data-status="cannot-sync"/);
  assert.match(bar({ status: 'offline', statusText: 'Offline: will sync' }), /Offline: will sync/);
  assert.doesNotMatch(bar(), /stay on this computer/i);
});

test('the bar escapes the title and names, and only a plain hex colour is used for a person', () => {
  const html = bar({
    drawing: { id: 7, title: '<img src=x onerror=1>', kind: 'standalone', role: 'editor' },
    present: [{ userId: 2, username: '<script>x</script>', color: 'red;background:url(x)' }],
  });
  assert.doesNotMatch(html, /<img|<script>/);
  assert.doesNotMatch(html, /background:url/);
  assert.match(html, /&lt;/);
});

test('the Share dialog lists who it is shared with and lets the owner change, remove and add; it can also copy into a channel or topic', () => {
  const html = drawingShareHtml({
    drawing: { id: 7, title: 'Plan' },
    members: [{ userId: 2, username: 'bob', role: 'editor' }, { userId: 3, username: 'cara', role: 'viewer' }],
    people: ['Ann Lee (ann)', 'Bob Ray (bob)'],
    channels: [{ id: 5, name: 'general', kind: 'channel' }, { id: 6, name: 'dept-mis', kind: 'forum' }],
  });
  assert.match(html, /data-drawing-member-role="2"/);
  assert.match(html, /data-drawing-member-remove="3"/);
  assert.match(html, /<option value="editor" selected>Can edit/);
  assert.match(html, /<option value="viewer" selected>Can view/);
  assert.match(html, /<datalist id="drawing-people-options">[\s\S]*Ann Lee \(ann\)/);
  assert.match(html, /data-drawing-add/);
  assert.match(html, /data-drawing-copy-channel/);
  assert.match(html, /<option value="6" data-forum="1">dept-mis/);
  assert.match(html, /data-drawing-copy/);
});

test('the Share dialog escapes everything and shows an empty state with nobody invited', () => {
  const html = drawingShareHtml({ drawing: { id: 7, title: '<b>x</b>' }, members: [{ userId: 2, username: '<i>y</i>', role: 'viewer' }], people: ['<u>z</u>'], channels: [{ id: 5, name: '<s>c</s>', kind: 'channel' }] });
  assert.doesNotMatch(html, /<b>|<i>|<u>|<s>/);
  assert.match(drawingShareHtml({ drawing: { id: 7, title: 'T' }, members: [], people: [], channels: [] }), /Not shared with anyone yet/);
});

test('Delete shows in the bar only when the person may delete the drawing', () => {
  assert.doesNotMatch(bar(), /data-drawing-delete/);
  assert.match(bar({ canDelete: true }), /data-drawing-delete/);
});

test('the top bar has Save file for everyone and Open file only for people who can edit', () => {
  const editor = drawingBarHtml({ drawing: { id: 4, title: 'Map', role: 'editor', readOnlyReason: null } });
  assert.match(editor, /data-drawing-save-file/);
  assert.match(editor, /data-drawing-open-file/);
  const viewer = drawingBarHtml({ drawing: { id: 4, title: 'Map', role: 'viewer', readOnlyReason: null } });
  assert.match(viewer, /data-drawing-save-file/);
  assert.doesNotMatch(viewer, /data-drawing-open-file/);
});
