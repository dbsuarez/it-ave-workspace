// Drawings: how shapes from several people are merged (Excalidraw's rule) and what a drawing may contain.
const test = require('node:test');
const assert = require('node:assert/strict');
const { mergeElements, validateElements, validateScene, MAX_ELEMENTS, MAX_SCENE_BYTES } = require('../src/drawingMerge');

const el = (id, version, versionNonce = 100, extra = {}) => ({ id, type: 'rectangle', version, versionNonce, ...extra });
const byId = (list) => Object.fromEntries(list.map((e) => [e.id, e]));

test('a higher version replaces the current shape, a lower one is ignored', () => {
  const current = [el('a', 3, 10, { x: 1 })];
  const up = mergeElements(current, [el('a', 4, 10, { x: 2 })]);
  assert.equal(byId(up.elements).a.x, 2);
  assert.deepEqual(up.changed.map((e) => e.id), ['a']);
  const down = mergeElements(current, [el('a', 2, 10, { x: 9 })]);
  assert.equal(byId(down.elements).a.x, 1);
  assert.deepEqual(down.changed, []);
});

test('on equal versions the lower versionNonce wins; identical shapes change nothing', () => {
  const current = [el('a', 5, 50, { x: 1 })];
  assert.equal(byId(mergeElements(current, [el('a', 5, 40, { x: 2 })]).elements).a.x, 2, 'lower nonce wins');
  assert.equal(byId(mergeElements(current, [el('a', 5, 60, { x: 3 })]).elements).a.x, 1, 'higher nonce loses');
  assert.deepEqual(mergeElements(current, [el('a', 5, 50, { x: 1 })]).changed, [], 'same shape');
});

test('an unknown id is added at the end; the existing order is kept', () => {
  const merged = mergeElements([el('a', 1), el('b', 1)], [el('c', 1), el('a', 2)]);
  assert.deepEqual(merged.elements.map((e) => e.id), ['a', 'b', 'c']);
  assert.deepEqual(merged.changed.map((e) => e.id).sort(), ['a', 'c']);
});

test('a deleted shape with a higher version replaces a live one and stays in the list, so the deletion reaches everyone', () => {
  const merged = mergeElements([el('a', 1, 10, { isDeleted: false })], [el('a', 2, 10, { isDeleted: true })]);
  assert.equal(merged.elements.length, 1);
  assert.equal(merged.elements[0].isDeleted, true);
  const back = mergeElements(merged.elements, [el('a', 1, 10, { isDeleted: false })]);
  assert.equal(back.elements[0].isDeleted, true, 'an older "alive" copy does not bring it back');
});

test('the same updates in any order always give the same drawing (200 random cases)', () => {
  let seed = 12345;
  const random = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const shuffle = (list) => { const copy = [...list]; for (let i = copy.length - 1; i > 0; i -= 1) { const j = Math.floor(random() * (i + 1)); [copy[i], copy[j]] = [copy[j], copy[i]]; } return copy; };
  const canonical = (list) => JSON.stringify([...list].sort((a, b) => (a.id < b.id ? -1 : 1)));
  for (let round = 0; round < 200; round += 1) {
    const updates = [];
    for (let i = 0; i < 12; i += 1) updates.push([el(`s${Math.floor(random() * 4)}`, Math.floor(random() * 5), Math.floor(random() * 6), { x: Math.floor(random() * 1000), isDeleted: random() < 0.2 })]);
    const apply = (order) => order.reduce((scene, update) => mergeElements(scene, update).elements, []);
    const first = apply(updates);
    const second = apply(shuffle(updates));
    assert.equal(canonical(second), canonical(first), `round ${round}`);
  }
});

test('shapes only one person touched keep everyone\'s work', () => {
  const server = [el('a', 1), el('b', 1)];
  const bob = mergeElements(server, [el('a', 2, 5, { x: 10 })]).elements;
  const ann = mergeElements(bob, [el('b', 2, 5, { x: 20 })]).elements;
  const merged = byId(ann);
  assert.equal(merged.a.x, 10);
  assert.equal(merged.b.x, 20);
});

test('validation refuses what a drawing may not contain, with status 400', () => {
  const refuse = (value, pattern) => assert.throws(() => validateElements(value), (e) => e.status === 400 && pattern.test(e.message));
  refuse('nope', /list/i);
  refuse([{ version: 1, versionNonce: 1, type: 'x' }], /id/i);
  refuse([{ id: 'a', version: 1.5, versionNonce: 1, type: 'x' }], /version/i);
  refuse([{ id: 'a', version: -1, versionNonce: 1, type: 'x' }], /version/i);
  refuse([{ id: 'a', version: 1, versionNonce: 'x', type: 'x' }], /nonce/i);
  refuse([{ id: 'a', version: 1, versionNonce: 1 }], /type/i);
  refuse([{ id: 'x'.repeat(65), version: 1, versionNonce: 1, type: 'x' }], /id/i);
  refuse([null], /shape/i);
  refuse(Array.from({ length: MAX_ELEMENTS + 1 }, (_, i) => el(`e${i}`, 1)), /too many/i);
  assert.equal(validateElements([el('a', 0, 0)]).length, 1, 'version 0 is allowed');
});

test('a scene is cleaned to its elements and the few view settings we keep, and may not exceed 10 MB', () => {
  const scene = validateScene({ elements: [el('a', 1)], appState: { viewBackgroundColor: '#fff', gridSize: 20, collaborators: 'x', anything: 1 } });
  assert.deepEqual(scene.appState, { viewBackgroundColor: '#fff', gridSize: 20 });
  assert.deepEqual(validateScene({ elements: [] }).appState, {});
  assert.throws(() => validateScene({ elements: [el('a', 1, 1, { blob: 'x'.repeat(MAX_SCENE_BYTES) })] }), (e) => e.status === 400 && /large|size|10/i.test(e.message));
  assert.throws(() => validateScene({ elements: [], appState: { gridSize: 'big' } }), (e) => e.status === 400);
  assert.throws(() => validateScene(null), (e) => e.status === 400);
});
