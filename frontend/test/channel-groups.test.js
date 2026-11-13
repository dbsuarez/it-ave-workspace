const test = require('node:test');
const assert = require('node:assert/strict');
const { isPersonalChannel, splitPersonalChannels } = require('../src/features/channel-groups');

const channel = (id, createdBy, isPersonal = false) => ({ id, name: `c${id}`, createdBy, isPersonal });

test('an explicitly personal channel I created is personal', () => {
  assert.equal(isPersonalChannel(channel(1, 7, true), 7), true);
});

test('ordinary or somebody else\'s channel is not personal to me', () => {
  assert.equal(isPersonalChannel(channel(1, 7, false), 7), false);
  assert.equal(isPersonalChannel(channel(1, 8, true), 7), false);
});

test('splitting keeps the order, and ids may arrive as text', () => {
  const list = [channel(1, 7), channel(2, 7, true), channel(3, 9, true), channel(4, '7', true)];
  const { shared, personal } = splitPersonalChannels(list, 7);
  assert.deepEqual(shared.map((c) => c.id), [1, 3]);
  assert.deepEqual(personal.map((c) => c.id), [2, 4]);
});
