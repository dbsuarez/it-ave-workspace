const test = require('node:test');
const assert = require('node:assert/strict');
const { isPersonalChannel, splitPersonalChannels } = require('../src/features/channel-groups');

const channel = (id, createdBy, memberCount) => ({ id, name: `c${id}`, createdBy, memberCount });

test('a channel I created that nobody else is in is personal', () => {
  assert.equal(isPersonalChannel(channel(1, 7, 1), 7), true);
  assert.equal(isPersonalChannel(channel(1, 7, 0), 7), true, 'no members listed yet');
});

test('it stops being personal once someone else is in it, or when someone else made it', () => {
  assert.equal(isPersonalChannel(channel(1, 7, 2), 7), false, 'shared with one person');
  assert.equal(isPersonalChannel(channel(1, 8, 1), 7), false, 'made by someone else');
  assert.equal(isPersonalChannel(channel(1, null, 1), 7), false, 'no creator on record');
});

test('splitting keeps the order, and ids may arrive as text', () => {
  const list = [channel(1, 7, 5), channel(2, 7, 1), channel(3, 9, 1), channel(4, '7', 1)];
  const { shared, personal } = splitPersonalChannels(list, 7);
  assert.deepEqual(shared.map((c) => c.id), [1, 3]);
  assert.deepEqual(personal.map((c) => c.id), [2, 4]);
});
