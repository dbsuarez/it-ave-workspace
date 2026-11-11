const test = require('node:test');
const assert = require('node:assert/strict');
const { ccThreads } = require('../src/features/canvas-comments');

test('comments are grouped into threads, oldest first, replies under their thread', () => {
  const comments = [
    { id: 1, parentId: null, body: 'a' },
    { id: 2, parentId: null, body: 'b' },
    { id: 3, parentId: 1, body: 'reply to a' },
    { id: 4, parentId: 1, body: 'second reply' },
  ];
  const threads = ccThreads(comments);
  assert.deepEqual(threads.map((t) => t.root.id), [1, 2]);
  assert.deepEqual(threads[0].replies.map((r) => r.id), [3, 4]);
  assert.deepEqual(threads[1].replies, []);
  assert.deepEqual(ccThreads([]), []);
});
