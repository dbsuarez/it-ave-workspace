const test = require('node:test');
const assert = require('node:assert/strict');
const { elementsToSend, mergeElementsLocal, chunkElements, syncStatus, syncStatusText } = require('../src/features/drawing-sync');

const el = (id, version, nonce = 1, extra = {}) => ({ id, type: 'rectangle', version, versionNonce: nonce, ...extra });
const ids = (list) => list.map((e) => e.id).sort();

test('nothing is sent when the server already has everything', () => {
  const same = [el('a', 2), el('b', 1)];
  assert.deepEqual(elementsToSend(same, same.map((e) => ({ ...e }))), []);
  assert.deepEqual(elementsToSend([], same), []);
});

test('new shapes, higher versions and newer deletions are sent; older and equal copies are not', () => {
  const server = [el('a', 2), el('b', 2), el('c', 1)];
  const local = [el('a', 3, 1, { x: 9 }), el('b', 1), el('c', 2, 1, { isDeleted: true }), el('d', 1)];
  assert.deepEqual(ids(elementsToSend(local, server)), ['a', 'c', 'd']);
  assert.equal(elementsToSend(local, server).find((e) => e.id === 'c').isDeleted, true, 'a deletion made offline reaches the server');
});

test('on equal versions the lower nonce is the one that is sent', () => {
  assert.deepEqual(ids(elementsToSend([el('a', 4, 10)], [el('a', 4, 20)])), ['a']);
  assert.deepEqual(elementsToSend([el('a', 4, 30)], [el('a', 4, 20)]), []);
});

test('edits to different shapes made on two sides both survive a merge; a deletion is not undone by an older copy', () => {
  const server = [el('a', 1), el('b', 1)];
  const offline = [el('a', 2, 5, { x: 10 }), el('b', 1)];
  const theirs = [el('a', 1), el('b', 2, 5, { x: 20 })];
  const merged = Object.fromEntries(mergeElementsLocal(offline, theirs).map((e) => [e.id, e]));
  assert.equal(merged.a.x, 10);
  assert.equal(merged.b.x, 20);
  const deleted = mergeElementsLocal([el('z', 3, 1, { isDeleted: true })], [el('z', 2, 1, { isDeleted: false })]);
  assert.equal(deleted[0].isDeleted, true);
  assert.equal(deleted.length, 1, 'the shape is kept, marked deleted');
});

test('the order of a merge keeps the local order and appends new shapes', () => {
  assert.deepEqual(mergeElementsLocal([el('a', 1), el('b', 1)], [el('c', 1), el('a', 1)]).map((e) => e.id), ['a', 'b', 'c']);
});

test('shapes are cut into batches under the size cap, in order, none split or lost', () => {
  const shapes = Array.from({ length: 50 }, (_, i) => el(`s${i}`, 1, 1, { blob: 'x'.repeat(10000) }));
  const batches = chunkElements(shapes, 100000);
  assert.ok(batches.length > 1);
  assert.ok(batches.every((batch) => JSON.stringify(batch).length <= 100000));
  assert.deepEqual(batches.flat().map((e) => e.id), shapes.map((e) => e.id));
  assert.deepEqual(chunkElements([], 1000), []);
  assert.deepEqual(chunkElements([el('big', 1, 1, { blob: 'x'.repeat(5000) })], 100).map((b) => b.length), [1], 'one oversize shape still goes alone');
});

test('the status line has four states and says each in words', () => {
  assert.equal(syncStatus({ online: true, dirty: false, saving: false, denied: false }), 'saved');
  assert.equal(syncStatus({ online: true, dirty: true, saving: false, denied: false }), 'saving');
  assert.equal(syncStatus({ online: true, dirty: false, saving: true, denied: false }), 'saving');
  assert.equal(syncStatus({ online: false, dirty: true, saving: false, denied: false }), 'offline');
  assert.equal(syncStatus({ online: false, dirty: false, saving: false, denied: false }), 'offline');
  assert.equal(syncStatus({ online: true, dirty: true, saving: false, denied: true }), 'cannot-sync');
  assert.equal(syncStatus({ online: false, dirty: true, saving: false, denied: true }), 'cannot-sync', 'losing access beats being offline');
  assert.equal(syncStatusText('saved'), 'Saved');
  assert.equal(syncStatusText('saving'), 'Saving...');
  assert.equal(syncStatusText('offline'), 'Offline: will sync');
  assert.equal(syncStatusText('cannot-sync'), 'Cannot sync');
});
