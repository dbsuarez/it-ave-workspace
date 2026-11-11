const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const jwt = require('jsonwebtoken');

process.env.DATABASE_URL ||= 'postgres://127.0.0.1/test';
const previousJwtSecret = process.env.JWT_SECRET;
const previousUploadDir = process.env.UPLOAD_DIR;
process.env.JWT_SECRET = 'files-test-secret';
const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iav-files-test-'));
process.env.UPLOAD_DIR = uploadDir;

const config = require('../src/config');
const dbPath = require.resolve('../src/db');
const previousDbModule = require.cache[dbPath];
const files = new Map();
const emitted = [];
const audits = [];
let channelModerator = false;

function seedFile(id, uploadedBy, filename, context = {}) {
  const file = {
    id,
    uploaded_by: uploadedBy,
    filename,
    message_id: context.messageId || null,
    dm_message_id: context.dmMessageId || null,
    channel_id: context.channelId || null,
    sender_id: context.senderId || null,
    receiver_id: context.receiverId || null,
  };
  files.set(id, file);
  fs.writeFileSync(path.join(uploadDir, filename), `file-${id}`);
  return file;
}

function createClient() {
  return {
    async query(sql, params = []) {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
      if (sql.includes('SELECT f.id, f.filename')) {
        const file = files.get(Number(params[0]));
        return { rows: file ? [{ ...file }] : [] };
      }
      if (sql.includes('SELECT 1') && sql.includes("cm.role = 'moderator'")) {
        return { rows: channelModerator ? [{}] : [] };
      }
      if (sql.includes('INSERT INTO moderation_audit_log')) {
        audits.push({ sql, params });
        return { rows: [] };
      }
      if (sql.includes('SELECT id FROM files WHERE filename')) {
        return {
          rows: [...files.values()].filter((file) =>
            file.filename === params[0] && file.id !== Number(params[1])
          ).map((file) => ({ id: file.id })),
        };
      }
      if (sql.includes('DELETE FROM files')) {
        const file = files.get(Number(params[0]));
        if (!file) return { rows: [] };
        files.delete(file.id);
        return { rows: [{ id: file.id }] };
      }
      throw new Error(`Unexpected transaction query: ${sql}`);
    },
    release() {},
  };
}

require.cache[dbPath] = {
  id: dbPath,
  filename: dbPath,
  loaded: true,
  exports: {
    query: async (sql) => {
      if (sql.includes('SELECT token_version FROM users')) return { rows: [{ token_version: 0 }] };
      throw new Error(`Unexpected files query: ${sql}`);
    },
    pool: { connect: async () => createClient() },
  },
};

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  req.io = {
    to: (room) => ({
      emit: (event, payload) => emitted.push({ room, event, payload }),
    }),
  };
  next();
});
app.use('/api/files', require('../src/routes/files'));
let server;
let baseUrl;

test.before(async () => {
  seedFile(1, 1, 'channel-attachment.txt', { messageId: 10, channelId: 7 });
  seedFile(2, 2, 'other-users-file.txt', { messageId: 11, channelId: 7 });
  seedFile(3, 1, 'dm-attachment.txt', { dmMessageId: 20, senderId: 1, receiverId: 2 });
  seedFile(4, 1, 'unlinked-upload.txt');
  seedFile(5, 2, 'moderated-attachment.txt', { messageId: 12, channelId: 7 });
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (server) await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  if (previousDbModule) {
    require.cache[dbPath] = previousDbModule;
  } else {
    delete require.cache[dbPath];
  }
  if (previousJwtSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = previousJwtSecret;
  if (previousUploadDir === undefined) delete process.env.UPLOAD_DIR;
  else process.env.UPLOAD_DIR = previousUploadDir;
  fs.rmSync(uploadDir, { recursive: true, force: true });
});

function authHeader(userId = 1) {
  const token = jwt.sign({ userId, username: userId === 1 ? 'alice' : 'bob' }, config.JWT_SECRET);
  return { Authorization: `Bearer ${token}` };
}

function deleteFile(fileId, userId = 1, reason) {
  return fetch(`${baseUrl}/api/files/${fileId}`, {
    method: 'DELETE',
    headers: { ...authHeader(userId), 'Content-Type': 'application/json' },
    ...(reason === undefined ? {} : { body: JSON.stringify({ reason }) }),
  });
}

test('uploader can permanently delete a channel attachment and notify the channel', async () => {
  const response = await deleteFile(1);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { deleted: true, fileId: 1 });
  assert.equal(files.has(1), false);
  assert.equal(fs.existsSync(path.join(uploadDir, 'channel-attachment.txt')), false);
  assert.deepEqual(emitted.at(-1), {
    room: 'channel_7',
    event: 'file_deleted',
    payload: { fileId: 1, messageId: 10, dmMessageId: null, channelId: 7 },
  });
});

test('only the uploader can delete a file and an unauthorized attempt preserves it', async () => {
  const response = await deleteFile(2);
  assert.equal(response.status, 403);
  assert.equal(files.has(2), true);
  assert.equal(fs.existsSync(path.join(uploadDir, 'other-users-file.txt')), true);
});

test('deleting a DM attachment notifies both participants', async () => {
  const response = await deleteFile(3);
  assert.equal(response.status, 200);
  assert.deepEqual(emitted.slice(-2).map((entry) => entry.room), ['user_1', 'user_2']);
  assert.equal(files.has(3), false);
  assert.equal(fs.existsSync(path.join(uploadDir, 'dm-attachment.txt')), false);
});

test('uploader can delete an unlinked upload and invalid or missing IDs are rejected', async () => {
  assert.equal((await deleteFile(4)).status, 200);
  assert.equal(fs.existsSync(path.join(uploadDir, 'unlinked-upload.txt')), false);
  assert.equal((await deleteFile('invalid')).status, 400);
  assert.equal((await deleteFile(999)).status, 404);
});

test('channel moderator must provide a reason to delete another member attachment', async () => {
  channelModerator = true;
  const missingReason = await deleteFile(5, 3);
  assert.equal(missingReason.status, 400);
  assert.equal(files.has(5), true);

  const response = await deleteFile(5, 3, 'Policy violation');
  assert.equal(response.status, 200);
  assert.equal(files.has(5), false);
  assert.ok(audits.some(({ sql, params }) => sql.includes("'attachment_deleted'")
    && JSON.parse(params[3]).reason === 'Policy violation'));
  assert.equal(emitted.at(-1).room, 'channel_7');
});
