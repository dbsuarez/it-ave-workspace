const test = require('node:test');
const assert = require('node:assert/strict');
const { createDrawingStore, memoryDrawingBackend } = require('../src/features/drawing-store');

const record = (extra = {}) => ({ title: 'Map', elements: [{ id: 'a', version: 1, versionNonce: 1, type: 'rectangle' }], files: {}, lastRevision: 3, dirty: false, kind: 'standalone', ...extra });

test('a drawing saved locally comes back the same, and a copy is returned so edits cannot leak into the store', async () => {
  const store = createDrawingStore(memoryDrawingBackend());
  await store.save(7, record());
  const back = await store.load(7);
  assert.equal(back.id, '7');
  assert.equal(back.title, 'Map');
  assert.equal(back.lastRevision, 3);
  assert.ok(back.updatedAt > 0);
  back.elements.push({ id: 'zzz' });
  assert.equal((await store.load(7)).elements.length, 1);
  assert.equal(await store.load(999), undefined);
});

test('number and text ids are the same drawing; list shows all; remove deletes', async () => {
  const store = createDrawingStore(memoryDrawingBackend());
  await store.save(1, record({ title: 'one' }));
  await store.save('local-abc', record({ title: 'draft', dirty: true }));
  assert.equal((await store.load('1')).title, 'one');
  assert.deepEqual((await store.list()).map((r) => r.title).sort(), ['draft', 'one']);
  await store.remove(1);
  assert.deepEqual((await store.list()).map((r) => r.title), ['draft']);
});

test('a draft made offline is renamed to its real id when the server creates it, keeping everything else', async () => {
  const store = createDrawingStore(memoryDrawingBackend());
  await store.save('local-1', record({ title: 'draft', dirty: true }));
  await store.rename('local-1', 42);
  assert.equal(await store.load('local-1'), undefined);
  const moved = await store.load(42);
  assert.equal(moved.id, '42');
  assert.equal(moved.title, 'draft');
  assert.equal(moved.dirty, true);
  await store.rename('missing', 5);
  assert.equal(await store.load(5), undefined, 'renaming nothing creates nothing');
});

test('saving again replaces the record', async () => {
  const store = createDrawingStore(memoryDrawingBackend());
  await store.save(3, record({ title: 'old' }));
  await store.save(3, record({ title: 'new', elements: [] }));
  const back = await store.load(3);
  assert.deepEqual([back.title, back.elements.length], ['new', 0]);
  assert.equal((await store.list()).length, 1);
});
