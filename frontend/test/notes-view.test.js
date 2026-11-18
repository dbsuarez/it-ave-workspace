const test = require('node:test');
const assert = require('node:assert/strict');
const v = require('../src/features/notes-view');

const note = (extra = {}) => ({
  id: 1, title: 'Shopping', content: 'milk\neggs', kind: 'text', items: [], color: 'default', pinned: false, archived: false, trashed: false,
  labelIds: [], images: [], reminder: null, createdAt: '2026-11-10T08:00:00Z', updatedAt: '2026-11-18T08:00:00Z', ...extra,
});
const labels = [{ id: 5, name: 'Work' }, { id: 6, name: 'Home' }];
const at = (day, hour, minute = 0) => new Date(2026, 10, day, hour, minute);

test('there are twelve colours, each with a name and a unique key, starting with the plain one', () => {
  assert.equal(v.NOTE_COLORS.length, 12);
  assert.equal(v.NOTE_COLORS[0].key, 'default');
  assert.equal(new Set(v.NOTE_COLORS.map((c) => c.key)).size, 12);
  assert.ok(v.NOTE_COLORS.every((c) => c.label && /^#[0-9a-f]{6}$/i.test(c.background)));
});

test('a card shows the title and the text, escaped, with the colour as a class and the id for clicks', () => {
  const html = v.noteCardHtml(note({ title: '<b>Hi</b>', content: 'a & b', color: 'yellow' }), { labels });
  assert.match(html, /class="note-card note-color-yellow"/);
  assert.match(html, /data-note-open="1"/);
  assert.match(html, /&lt;b&gt;Hi&lt;\/b&gt;/);
  assert.match(html, /a &amp; b/);
  assert.doesNotMatch(html, /<b>/);
});

test('a checklist card shows its items with ticks, done ones last, and says how many more there are', () => {
  const items = [{ id: 'a', text: 'one', done: true }, { id: 'b', text: 'two', done: false }];
  const html = v.noteCardHtml(note({ kind: 'checklist', content: '', items }), { labels });
  assert.ok(html.indexOf('<span>two</span>') < html.indexOf('<span>one</span>'), 'open items first');
  assert.match(html, /note-item done/);
  const many = Array.from({ length: 12 }, (_, i) => ({ id: String(i), text: `item${i}`, done: false }));
  assert.match(v.noteCardHtml(note({ kind: 'checklist', items: many }), { labels }), /\+ 4 more/);
});

test('a card shows its labels (at most three and a count), its reminder, a picture, and a pin that says what it does', () => {
  const many = [{ id: 1, name: 'A' }, { id: 2, name: 'B' }, { id: 3, name: 'C' }, { id: 4, name: 'D' }];
  const html = v.noteCardHtml(note({ labelIds: [1, 2, 3, 4], reminder: { id: 9, remindAt: at(20, 9).toISOString() }, images: [{ id: 3, mime: 'image/png' }], pinned: true }), { labels: many, now: at(18, 8) });
  assert.equal((html.match(/class="note-chip"/g) || []).length, 3);
  assert.match(html, /\+1/);
  assert.match(html, /class="note-chip note-reminder-chip"/);
  assert.match(html, /<img[^>]*data-note-image="1:3"/);
  assert.doesNotMatch(html, /<img[^>]*src=/, 'pictures are fetched with the sign-in');
  assert.match(html, /data-note-pin[^>]*aria-pressed="true"[^>]*title="Unpin note"/);
  assert.match(v.noteCardHtml(note(), { labels }), /data-note-pin[^>]*aria-pressed="false"[^>]*title="Pin note"/);
});

test('an empty card still looks like a note, and card buttons depend on where the note is', () => {
  assert.match(v.noteCardHtml(note({ title: '', content: '' }), { labels }), /Empty note/);
  assert.match(v.noteCardHtml(note(), { labels }), /data-note-archive/);
  assert.match(v.noteCardHtml(note({ archived: true }), { labels }), /data-note-unarchive/);
  const trashed = v.noteCardHtml(note({ trashed: true }), { labels });
  assert.match(trashed, /data-note-restore/);
  assert.match(trashed, /data-note-delete-forever/);
  assert.doesNotMatch(trashed, /data-note-pin|data-note-palette/);
});

test('each view shows the right notes, newest first, with pinned ones apart', () => {
  const all = [
    note({ id: 1, updatedAt: '2026-11-01T00:00:00Z' }),
    note({ id: 2, updatedAt: '2026-11-05T00:00:00Z', pinned: true }),
    note({ id: 3, updatedAt: '2026-11-09T00:00:00Z' }),
    note({ id: 4, archived: true }),
    note({ id: 5, trashed: true }),
    note({ id: 6, reminder: { id: 1, remindAt: '2027-01-01T00:00:00Z' }, labelIds: [5], updatedAt: '2026-11-03T00:00:00Z' }),
  ];
  const ids = (list) => list.map((n) => n.id);
  const main = v.notesForView(all, { view: 'notes' });
  assert.deepEqual(ids(main.pinned), [2]);
  assert.deepEqual(ids(main.others), [3, 6, 1]);
  assert.deepEqual(ids(v.notesForView(all, { view: 'reminders' }).others), [6]);
  assert.deepEqual(ids(v.notesForView(all, { view: 'archive' }).others), [4]);
  assert.deepEqual(ids(v.notesForView(all, { view: 'trash' }).others), [5]);
  assert.deepEqual(ids(v.notesForView(all, { view: 'label', labelId: 5 }).others), [6]);
  assert.deepEqual(v.notesForView(all, { view: 'archive' }).pinned, [], 'pins only show on the main wall');
});

test('search looks in title, text, checklist items and label names, ignoring case', () => {
  const all = [
    note({ id: 1, title: 'Rack plan', content: '' }),
    note({ id: 2, title: 'x', content: 'Order the SWITCH' }),
    note({ id: 3, title: 'y', kind: 'checklist', content: '', items: [{ id: 'a', text: 'buy cables', done: false }] }),
    note({ id: 4, title: 'z', content: '', labelIds: [5] }),
  ];
  const found = (query) => v.notesForView(all, { view: 'notes', query, labels }).others.map((n) => n.id).sort();
  assert.deepEqual(found('rack'), [1]);
  assert.deepEqual(found('switch'), [2]);
  assert.deepEqual(found('CABLES'), [3]);
  assert.deepEqual(found('work'), [4]);
  assert.deepEqual(found('   '), [1, 2, 3, 4]);
  assert.deepEqual(found('nothing here'), []);
});

test('lines become checklist items and back, dropping empty lines and keeping done state through a round trip', () => {
  const items = v.textToItems('milk\n\n  eggs  \nbread', () => 'id');
  assert.deepEqual(items.map((i) => i.text), ['milk', 'eggs', 'bread']);
  assert.ok(items.every((i) => i.done === false));
  assert.equal(v.itemsToText([{ id: 'a', text: 'one', done: true }, { id: 'b', text: '', done: false }, { id: 'c', text: 'two', done: false }]), 'one\ntwo');
});

test('a note with nothing in it is empty, and a picture or a reminder alone keeps it', () => {
  assert.equal(v.noteIsEmpty({ title: ' ', content: '', kind: 'text', items: [], images: [] }), true);
  assert.equal(v.noteIsEmpty({ title: '', content: '', kind: 'checklist', items: [{ id: 'a', text: '', done: false }], images: [] }), true);
  assert.equal(v.noteIsEmpty({ title: '', content: 'x', kind: 'text', items: [], images: [] }), false);
  assert.equal(v.noteIsEmpty({ title: '', content: '', kind: 'checklist', items: [{ id: 'a', text: 'x', done: false }], images: [] }), false);
  assert.equal(v.noteIsEmpty({ title: '', content: '', kind: 'text', items: [], images: [{ id: 1 }] }), false);
});

test('the edited time says the clock time today and the date otherwise', () => {
  assert.equal(v.noteEditedLabel(at(18, 10, 1).toISOString(), at(18, 15)), 'Edited at 10:01 AM');
  assert.equal(v.noteEditedLabel(at(18, 22, 5).toISOString(), at(18, 23)), 'Edited at 10:05 PM');
  assert.match(v.noteEditedLabel(at(10, 9).toISOString(), at(18, 15)), /^Edited Nov 10$/);
});

test('a reminder reads as today, tomorrow or a date, with the time', () => {
  assert.equal(v.reminderLabel(at(18, 18).toISOString(), at(18, 8)), 'Today, 6:00 PM');
  assert.equal(v.reminderLabel(at(19, 9, 30).toISOString(), at(18, 8)), 'Tomorrow, 9:30 AM');
  assert.equal(v.reminderLabel(at(25, 12).toISOString(), at(18, 8)), 'Nov 25, 12:00 PM');
});

test('the side menu lists the views and the labels, marks the open one and counts nothing it should not', () => {
  const html = v.notesSidebarHtml({ labels, active: { view: 'label', labelId: 6 } });
  assert.match(html, /data-notes-view="notes"/);
  assert.match(html, /data-notes-view="reminders"/);
  assert.match(html, /data-notes-view="archive"/);
  assert.match(html, /data-notes-view="trash"/);
  assert.match(html, /data-notes-label="5"/);
  assert.match(html, /data-notes-label="6"[^>]*aria-current="page"|aria-current="page"[^>]*data-notes-label="6"/);
  assert.match(html, /data-notes-edit-labels/);
  assert.equal((html.match(/aria-current="page"/g) || []).length, 1);
  assert.match(v.notesSidebarHtml({ labels: [{ id: 7, name: '<i>' }], active: { view: 'notes' } }), /&lt;i&gt;/);
});

test('the editor has a title, a body or a checklist, and the toolbar for colour, pin, checklist, reminder, picture, labels, archive and delete', () => {
  const text = v.noteEditorHtml(note({ color: 'blue' }), { labels, now: at(18, 12) });
  assert.match(text, /class="note-editor-card note-color-blue"/);
  assert.match(text, /data-note-title/);
  assert.match(text, /<textarea[^>]*data-note-body/);
  for (const hook of ['data-note-tool="palette"', 'data-note-tool="pin"', 'data-note-tool="checklist"', 'data-note-tool="reminder"', 'data-note-tool="image"', 'data-note-tool="labels"', 'data-note-tool="archive"', 'data-note-tool="trash"', 'data-note-tool="undo"', 'data-note-tool="redo"']) {
    assert.ok(text.includes(hook), hook);
  }
  assert.match(text, /Edited at/);
  const list = v.noteEditorHtml(note({ kind: 'checklist', content: '', items: [{ id: 'a', text: 'one', done: false }, { id: 'b', text: 'two', done: true }] }), { labels });
  assert.doesNotMatch(list, /data-note-body/);
  assert.match(list, /data-note-item="a"/);
  assert.match(list, /data-note-item-add/);
  assert.match(list, /data-note-item-done="b"[^>]*checked/);
});

test('editor values are escaped', () => {
  const html = v.noteEditorHtml(note({ title: '"><script>x</script>', content: '</textarea><img src=x>' }), { labels });
  assert.doesNotMatch(html, /<script>|<img src=x>/);
});

test('the colour picker offers every colour and marks the current one', () => {
  const html = v.noteColorPaletteHtml('green');
  assert.equal((html.match(/data-note-color="/g) || []).length, 12);
  assert.match(html, /data-note-color="green"[^>]*aria-pressed="true"/);
  assert.equal((html.match(/aria-pressed="true"/g) || []).length, 1);
});

test('the label picker lists the labels with a tick for the ones on the note, and can make a new label from what is typed', () => {
  const html = v.noteLabelPickerHtml(labels, [6]);
  assert.match(html, /data-note-label-toggle="6"[^>]*checked/);
  assert.doesNotMatch(html, /data-note-label-toggle="5"[^>]*checked/);
  assert.match(html, /data-note-label-new/);
});
