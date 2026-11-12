const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');

process.env.DATABASE_URL ||= 'postgres://127.0.0.1/test';
const previousJwtSecret = process.env.JWT_SECRET;
process.env.JWT_SECRET = 'moderation-test-secret';

const config = require('../src/config');
const dbPath = require.resolve('../src/db');
const previousDbModule = require.cache[dbPath];
let superadmin = false;
let rolePermissions = [];
let channelModerator = false;
let savedSettings = { default_timeout_minutes: 5, max_timeout_minutes: 10080 };
const queries = [];

require.cache[dbPath] = {
  id: dbPath,
  filename: dbPath,
  loaded: true,
  exports: {
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (sql.includes('SELECT token_version FROM users')) return { rows: [{ token_version: 0 }] };
      if (sql.includes('SELECT is_superadmin FROM users')) return { rows: [{ is_superadmin: superadmin }] };
      if (sql.includes('SELECT is_superadmin, is_hr, account_type FROM users')) return { rows: [{ is_superadmin: superadmin, is_hr: false, account_type: 'member' }] };
      if (sql.includes('FROM roles r')) return { rows: [{ id: 3, builtin_key: 'everyone', permissions: [] }, ...(rolePermissions.length ? [{ id: 9, builtin_key: null, permissions: rolePermissions }] : [])] };
      if (sql.includes('SELECT default_timeout_minutes, max_timeout_minutes')) {
        return { rows: [savedSettings] };
      }
      if (sql.includes('UPDATE moderation_settings')) {
        savedSettings = { default_timeout_minutes: params[0], max_timeout_minutes: params[1] };
        return { rows: [savedSettings] };
      }
      if (sql.includes('SELECT 1') && sql.includes("cm.role = 'moderator'")) {
        return { rows: [superadmin || channelModerator ? {} : null].filter(Boolean) };
      }
      if (sql.includes('AS is_member')) {
        return { rows: [{ is_superadmin: false, is_member: true }] };
      }
      if (sql.includes('INSERT INTO channel_members')) {
        return { rows: [{ user_id: params[1], role: params[2] }] };
      }
      if (sql.includes('INSERT INTO channel_timeouts')) {
        return { rows: [{ id: 8, expires_at: new Date(Date.now() + 300000) }] };
      }
      if (sql.includes('INSERT INTO moderation_audit_log')) return { rows: [] };
      if (sql.includes('LEFT JOIN channel_members cm')) {
        return { rows: [{ is_superadmin: superadmin, channel_id: 7 }] };
      }
      if (sql.includes('INSERT INTO channel_members')) return { rows: [] };
      throw new Error(`Unexpected moderation query: ${sql}`);
    },
  },
};

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  req.io = {};
  next();
});
app.use('/api/moderation', require('../src/routes/moderation'));
let server;
let baseUrl;

test.before(async () => {
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (server) await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  if (previousDbModule) require.cache[dbPath] = previousDbModule;
  else delete require.cache[dbPath];
  if (previousJwtSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = previousJwtSecret;
});

function headers() {
  const token = jwt.sign({ userId: 1, username: 'admin', tokenVersion: 0 }, config.JWT_SECRET);
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

test('moderation settings are restricted to the configured superadmin role', async () => {
  superadmin = false;
  const denied = await fetch(`${baseUrl}/api/moderation/settings`, { headers: headers() });
  assert.equal(denied.status, 403);

  superadmin = true;
  const allowed = await fetch(`${baseUrl}/api/moderation/settings`, { headers: headers() });
  assert.equal(allowed.status, 200);
  assert.deepEqual((await allowed.json()).settings, {
    defaultTimeoutMinutes: 5,
    maxTimeoutMinutes: 10080,
  });
});

test('a role that grants manage_workspace opens the settings for someone who is not an Owner; another permission does not', async () => {
  superadmin = false;
  rolePermissions = ['manage_messages'];
  assert.equal((await fetch(`${baseUrl}/api/moderation/settings`, { headers: headers() })).status, 403);
  rolePermissions = ['manage_workspace'];
  assert.equal((await fetch(`${baseUrl}/api/moderation/settings`, { headers: headers() })).status, 200);
  rolePermissions = [];
});

test('timeout policy validates bounds and persists only valid settings', async () => {
  superadmin = true;
  const invalid = await fetch(`${baseUrl}/api/moderation/settings`, {
    method: 'PUT',
    headers: headers(),
    body: JSON.stringify({ defaultTimeoutMinutes: 10, maxTimeoutMinutes: 5 }),
  });
  assert.equal(invalid.status, 400);

  const valid = await fetch(`${baseUrl}/api/moderation/settings`, {
    method: 'PUT',
    headers: headers(),
    body: JSON.stringify({ defaultTimeoutMinutes: 10, maxTimeoutMinutes: 120 }),
  });
  assert.equal(valid.status, 200);
  assert.deepEqual((await valid.json()).settings, {
    defaultTimeoutMinutes: 10,
    maxTimeoutMinutes: 120,
  });
  assert.ok(queries.some(({ sql }) => sql.includes('INSERT INTO moderation_audit_log')));
});

test('access response exposes moderator channel IDs without granting superadmin status', async () => {
  superadmin = false;
  const response = await fetch(`${baseUrl}/api/moderation/access`, { headers: headers() });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    isSuperadmin: false,
    isHr: false,
    accountType: 'member',
    moderatorChannelIds: [7],
  });
});

test('a normal account cannot assign channel roles through the moderation API', async () => {
  superadmin = false;
  const response = await fetch(`${baseUrl}/api/moderation/channels/7/members/3`, {
    method: 'PUT',
    headers: headers(),
    body: JSON.stringify({ role: 'moderator' }),
  });
  assert.equal(response.status, 403);
  assert.equal(queries.some(({ sql }) => sql.includes('INSERT INTO channel_members')), false);
});

test('Superadmin can grant a channel-scoped moderator role', async () => {
  superadmin = true;
  const response = await fetch(`${baseUrl}/api/moderation/channels/7/members/3`, {
    method: 'PUT',
    headers: headers(),
    body: JSON.stringify({ role: 'moderator' }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { userId: 3, role: 'moderator' });
});

test('channel moderator can apply the configured default timeout and audit it', async () => {
  superadmin = false;
  channelModerator = true;
  savedSettings = { default_timeout_minutes: 5, max_timeout_minutes: 120 };
  const response = await fetch(`${baseUrl}/api/moderation/channels/7/timeouts/3`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ reason: 'Repeated disruption' }),
  });
  assert.equal(response.status, 201);
  assert.ok((await response.json()).timeout.expiresAt);
  const timeoutInsert = queries.find(({ sql }) => sql.includes('INSERT INTO channel_timeouts'));
  assert.equal(timeoutInsert.params[4], 5);
  assert.ok(queries.some(({ sql }) => sql.includes('INSERT INTO moderation_audit_log')));
});
