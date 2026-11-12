const test = require('node:test');
const assert = require('node:assert/strict');
const {
  insertChannelMessage, insertDirectMessage, parseAttachmentId, ATTACHMENT_UNAVAILABLE,
} = require('../src/attachments');

function recorder(rows) {
  const calls = [];
  const query = async (sql, params) => {
    calls.push({ sql, params });
    return { rows };
  };
  return { query, calls };
}

test('a message without an attachment is a plain insert that never touches files', async () => {
  const { query, calls } = recorder([{ id: 9 }]);
  const row = await insertChannelMessage(query, { channelId: 1, userId: 2, content: 'hi', replyTo: null });
  assert.deepEqual(row, { id: 9 });
  assert.equal(calls.length, 1);
  assert.doesNotMatch(calls[0].sql, /files/);
  assert.deepEqual(calls[0].params, [1, 2, 'hi', null]);
});

test('claiming an attachment is one statement that requires it to be unattached and owned', async () => {
  const { query, calls } = recorder([{ id: 9, channel_id: 1 }]);
  const row = await insertChannelMessage(query, {
    channelId: 1, userId: 2, content: '', replyTo: null, attachmentId: 77,
  });
  assert.deepEqual(row, { id: 9, channel_id: 1 });
  assert.equal(calls.length, 1, 'claim and insert must be a single atomic statement');
  const { sql, params } = calls[0];
  assert.match(sql, /uploaded_by = \$2/);
  assert.match(sql, /message_id IS NULL AND dm_message_id IS NULL/);
  assert.match(sql, /FOR UPDATE/);
  assert.match(sql, /WHERE \(SELECT COUNT\(\*\) FROM claim\) = \$6/, 'every file must be claimed, or no message');
  assert.deepEqual(params, [1, 2, '', null, [77], 1]);
});

test('when the file cannot be claimed no message is created and null is returned', async () => {
  const { query } = recorder([]);
  assert.equal(await insertChannelMessage(query, { channelId: 1, userId: 2, content: 'x', attachmentId: 5 }), null);
  assert.equal(await insertDirectMessage(query, { senderId: 2, receiverId: 3, content: 'x', attachmentId: 5 }), null);
});

test('direct messages claim the file for the sender and link it as a DM attachment', async () => {
  const { query, calls } = recorder([{ id: 4 }]);
  await insertDirectMessage(query, { senderId: 2, receiverId: 3, content: 'hello', attachmentId: 8 });
  const { sql, params } = calls[0];
  assert.equal(calls.length, 1);
  assert.match(sql, /uploaded_by = \$1/);
  assert.match(sql, /message_id IS NULL AND dm_message_id IS NULL/);
  assert.match(sql, /SET dm_message_id = /);
  assert.deepEqual(params, [2, 3, 'hello', [8], 1]);
});

test('attachment IDs are validated as positive whole numbers', () => {
  assert.deepEqual(parseAttachmentId(undefined), { ok: true, id: null });
  assert.deepEqual(parseAttachmentId(null), { ok: true, id: null });
  assert.deepEqual(parseAttachmentId('12'), { ok: true, id: 12 });
  for (const bad of ['abc', -1, 0, 1.5, {}, [], '1; DROP TABLE files']) {
    assert.equal(parseAttachmentId(bad).ok, false, JSON.stringify(bad));
  }
  assert.match(ATTACHMENT_UNAVAILABLE, /already used/);
});
