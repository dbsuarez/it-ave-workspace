// The left rail an Owner arranges for everyone: which sections are on the rail, in what order, and which sit in the More menu. Pure.
const test = require('node:test');
const assert = require('node:assert/strict');
const { RAIL_KEYS, DEFAULT_RAIL, cleanRailLayout } = require('../src/railLayout');

test('the default rail lists every section once, with Lists in More and Home first', () => {
  assert.deepEqual([...DEFAULT_RAIL.order, ...DEFAULT_RAIL.more].sort(), [...RAIL_KEYS].sort());
  assert.equal(DEFAULT_RAIL.order[0], 'home');
  assert.deepEqual(DEFAULT_RAIL.more, ['lists']);
  for (const key of ['dms', 'knowledgebase', 'sheets', 'people', 'huddle', 'canvas2', 'drawings', 'notes', 'files', 'later', 'activity']) assert.ok(RAIL_KEYS.includes(key), key);
});

test('nothing stored, or nonsense, gives the default', () => {
  for (const input of [undefined, null, {}, 'x', 5, [], { order: 'x', more: 3 }]) assert.deepEqual(cleanRailLayout(input), DEFAULT_RAIL, JSON.stringify(input));
});

test('an arrangement keeps its order and its More list; sections it leaves out are added at the end of the rail', () => {
  const layout = cleanRailLayout({ order: ['home', 'knowledgebase', 'people', 'dms'], more: ['sheets', 'lists'] });
  assert.deepEqual(layout.order.slice(0, 4), ['home', 'knowledgebase', 'people', 'dms']);
  assert.deepEqual(layout.more, ['sheets', 'lists']);
  assert.deepEqual([...layout.order, ...layout.more].sort(), [...RAIL_KEYS].sort(), 'every section is somewhere');
  assert.ok(layout.order.includes('notes') && layout.order.includes('huddle'), 'the ones left out are on the rail');
});

test('unknown names and repeats are dropped, and a section is never in both places', () => {
  const layout = cleanRailLayout({ order: ['home', 'nonsense', 'dms', 'dms', 'files'], more: ['files', 'zzz', 'notes', 'notes'] });
  assert.equal(layout.order.includes('nonsense'), false);
  assert.equal(layout.more.includes('zzz'), false);
  assert.equal(layout.order.filter((k) => k === 'dms').length, 1);
  assert.equal(layout.order.includes('files') && layout.more.includes('files'), false);
  assert.deepEqual([...layout.order, ...layout.more].sort(), [...RAIL_KEYS].sort());
});

test('Home always stays on the rail, first, so nobody can lock themselves out', () => {
  const moved = cleanRailLayout({ order: ['dms', 'people'], more: ['home', 'lists'] });
  assert.equal(moved.order[0], 'home');
  assert.equal(moved.more.includes('home'), false);
  assert.equal(cleanRailLayout({ order: ['dms', 'home'], more: [] }).order[0], 'home');
});
