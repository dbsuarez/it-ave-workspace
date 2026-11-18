const test = require('node:test');
const assert = require('node:assert/strict');
const { mergeSheetData, sheetsEqual } = require('../src/features/sheet-merge');

const tab = (id, name, rows, widths) => ({ id, name, rows, ...(widths ? { widths } : {}) });
const sheet = (...tabs) => ({ tabs });

test('cells I changed stay mine and cells I did not change come from the server, even in the same row', () => {
  const base = sheet(tab('a', 'Data', [['1', '2', '3'], ['x', 'y', 'z']]));
  const mine = sheet(tab('a', 'Data', [['1', 'MINE', '3'], ['x', 'y', 'z']]));
  const theirs = sheet(tab('a', 'Data', [['THEIRS', '2', '3'], ['x', 'y', 'ZED']]));
  const merged = mergeSheetData(base, mine, theirs);
  assert.deepEqual(merged.data.tabs[0].rows, [['THEIRS', 'MINE', '3'], ['x', 'y', 'ZED']]);
  assert.equal(merged.collisions, 0);
});

test('when we both changed the same cell, mine wins and it is counted', () => {
  const base = sheet(tab('a', 'Data', [['old']]));
  const merged = mergeSheetData(base, sheet(tab('a', 'Data', [['mine']])), sheet(tab('a', 'Data', [['theirs']])));
  assert.equal(merged.data.tabs[0].rows[0][0], 'mine');
  assert.equal(merged.collisions, 1);
});

test('both making the same change is not a collision', () => {
  const base = sheet(tab('a', 'Data', [['old']]));
  const merged = mergeSheetData(base, sheet(tab('a', 'Data', [['same']])), sheet(tab('a', 'Data', [['same']])));
  assert.equal(merged.data.tabs[0].rows[0][0], 'same');
  assert.equal(merged.collisions, 0);
});

test('rows or columns they added past my last ones are kept, and mine past theirs too', () => {
  const base = sheet(tab('a', 'Data', [['1']]));
  const mine = sheet(tab('a', 'Data', [['1', 'm-col'], ['m-row']]));
  const theirs = sheet(tab('a', 'Data', [['1'], ['t-row'], ['t-row-2']]));
  const rows = mergeSheetData(base, mine, theirs).data.tabs[0].rows;
  assert.deepEqual(rows[0], ['1', 'm-col']);
  assert.equal(rows[1][0], 'm-row', 'where we both wrote the same cell, mine wins');
  assert.deepEqual(rows[2], ['t-row-2']);
});

test('a tab they added appears, a tab I added stays, and a tab they deleted is dropped with my edits to it counted', () => {
  const base = sheet(tab('a', 'A', [['1']]), tab('b', 'B', [['2']]));
  const mine = sheet(tab('a', 'A', [['1']]), tab('b', 'B', [['mine edit']]), tab('m', 'Mine', [['new']]));
  const theirs = sheet(tab('a', 'A', [['1']]), tab('t', 'Theirs', [['t']]));
  const merged = mergeSheetData(base, mine, theirs);
  assert.deepEqual(merged.data.tabs.map((t) => t.id).sort(), ['a', 'm', 't']);
  assert.equal(merged.collisions, 1, 'my edit to the tab they deleted is lost');
});

test('a tab I renamed keeps my name, otherwise theirs', () => {
  const base = sheet(tab('a', 'Old', [['1']]), tab('b', 'Same', [['1']]));
  const mine = sheet(tab('a', 'Mine', [['1']]), tab('b', 'Same', [['1']]));
  const theirs = sheet(tab('a', 'Theirs', [['1']]), tab('b', 'Renamed by them', [['1']]));
  const names = mergeSheetData(base, mine, theirs).data.tabs.map((t) => t.name);
  assert.deepEqual(names, ['Mine', 'Renamed by them']);
});

test('the tab order follows the server, with my new tabs after it', () => {
  const base = sheet(tab('a', 'A', []), tab('b', 'B', []));
  const mine = sheet(tab('a', 'A', []), tab('b', 'B', []), tab('m', 'M', []));
  const theirs = sheet(tab('b', 'B', []), tab('a', 'A', []));
  assert.deepEqual(mergeSheetData(base, mine, theirs).data.tabs.map((t) => t.id), ['b', 'a', 'm']);
});

test('column widths I changed win', () => {
  const base = sheet(tab('a', 'A', [['1']], [100, 100]));
  const mine = sheet(tab('a', 'A', [['1']], [250, 100]));
  const theirs = sheet(tab('a', 'A', [['1']], [100, 300]));
  assert.deepEqual(mergeSheetData(base, mine, theirs).data.tabs[0].widths, [250, 300]);
});

test('two sheets are equal when their tabs, names and cells are', () => {
  const a = sheet(tab('a', 'A', [['1', '2']], [100]));
  assert.equal(sheetsEqual(a, sheet(tab('a', 'A', [['1', '2']], [100]))), true);
  assert.equal(sheetsEqual(a, sheet(tab('a', 'A', [['1', '3']], [100]))), false);
  assert.equal(sheetsEqual(a, sheet(tab('a', 'B', [['1', '2']], [100]))), false);
});

test('merging leaves its inputs alone', () => {
  const base = sheet(tab('a', 'A', [['1']]));
  const mine = sheet(tab('a', 'A', [['2']]));
  const theirs = sheet(tab('a', 'A', [['3']]));
  const copies = JSON.stringify([base, mine, theirs]);
  mergeSheetData(base, mine, theirs);
  assert.equal(JSON.stringify([base, mine, theirs]), copies);
});
