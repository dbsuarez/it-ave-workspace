// Customizing the rail: moving a section up or down, between the rail and More, and the dialog's markup. Pure.
const test = require('node:test');
const assert = require('node:assert/strict');
const { railMoveWithin, railTogglePlacement, railCustomizeHtml } = require('../src/features/rail-layout');

const layout = { order: ['home', 'dms', 'files', 'people'], more: ['lists', 'sheets'] };
const labels = { home: 'Home', dms: 'DMs', files: 'Files', people: 'People', lists: 'Lists', sheets: 'Sheets' };

test('a section moves up or down within its own list, and stops at the ends', () => {
  assert.deepEqual(railMoveWithin(layout, 'files', 'up').order, ['home', 'files', 'dms', 'people']);
  assert.deepEqual(railMoveWithin(layout, 'dms', 'down').order, ['home', 'files', 'dms', 'people']);
  assert.deepEqual(railMoveWithin(layout, 'sheets', 'up').more, ['sheets', 'lists']);
  assert.deepEqual(railMoveWithin(layout, 'people', 'down'), layout, 'already last');
  assert.deepEqual(railMoveWithin(layout, 'lists', 'up'), layout, 'already first in More');
  assert.deepEqual(layout, { order: ['home', 'dms', 'files', 'people'], more: ['lists', 'sheets'] }, 'the original is not changed');
});

test('Home stays first on the rail: nothing moves above it and it cannot be moved', () => {
  assert.deepEqual(railMoveWithin(layout, 'dms', 'up'), layout, 'DMs cannot go above Home');
  assert.deepEqual(railMoveWithin(layout, 'home', 'down'), layout);
  assert.deepEqual(railTogglePlacement(layout, 'home'), layout, 'Home cannot go into More');
});

test('a section can be moved from the rail into More (at the end) and back', () => {
  const into = railTogglePlacement(layout, 'files');
  assert.deepEqual(into.order, ['home', 'dms', 'people']);
  assert.deepEqual(into.more, ['lists', 'sheets', 'files']);
  const back = railTogglePlacement(into, 'sheets');
  assert.deepEqual(back.more, ['lists', 'files']);
  assert.deepEqual(back.order, ['home', 'dms', 'people', 'sheets']);
  assert.deepEqual(railTogglePlacement(layout, 'nonsense'), layout);
});

test('the dialog lists the rail and More in order, with move buttons, and Home as always first', () => {
  const html = railCustomizeHtml({ layout, labels });
  assert.match(html, /Customize the rail/);
  assert.match(html, /Everyone/i);
  assert.equal((html.match(/data-rail-key="/g) || []).length > 0, true);
  const homeRow = html.slice(html.indexOf('data-rail-row="home"'), html.indexOf('data-rail-row="dms"'));
  assert.match(homeRow, /Always first/);
  assert.equal(/data-rail-toggle/.test(homeRow), false, 'Home has no move buttons');
  assert.match(html, /data-rail-move="up" data-rail-key="files"/);
  assert.match(html, /data-rail-toggle data-rail-key="files"/);
  assert.ok(html.indexOf('>DMs<') < html.indexOf('>Files<') && html.indexOf('>Files<') < html.indexOf('>People<'), 'in the order of the layout');
  assert.ok(html.indexOf('In the More menu') < html.indexOf('>Lists<'), 'More has its own heading');
  for (const hook of ['data-rail-save', 'data-rail-reset', 'data-rail-close']) assert.match(html, new RegExp(hook));
});

test('labels are escaped and an empty More says so', () => {
  const html = railCustomizeHtml({ layout: { order: ['home', 'dms'], more: [] }, labels: { home: 'Home', dms: '<b>DMs</b>' } });
  assert.equal(html.includes('<b>DMs</b>'), false);
  assert.match(html, /&lt;b&gt;DMs&lt;\/b&gt;/);
  assert.match(html, /Nothing in More/);
});
