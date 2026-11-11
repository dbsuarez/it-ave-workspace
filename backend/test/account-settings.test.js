const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

process.env.DATABASE_URL ||= 'postgres://127.0.0.1/test';
const previousJwtSecret = process.env.JWT_SECRET;
process.env.JWT_SECRET = 'account-settings-test-secret';

const config = require('../src/config');
const dbPath = require.resolve('../src/db');
const previousDbModule = require.cache[dbPath];
let tokenVersion = 0;
const passwordHash = bcrypt.hashSync('current-password', 4);

require.cache[dbPath] = {
  id: dbPath,
  filename: dbPath,
  loaded: true,
  exports: {
    query: async (sql, params) => {
      if (sql.includes('SELECT token_version FROM users')) {
        return { rows: [{ token_version: tokenVersion }] };
      }
      if (sql.includes('SELECT password_hash FROM users')) {
        return { rows: [{ password_hash: passwordHash }] };
      }
      if (sql.includes('UPDATE users') && sql.includes('token_version = token_version +')) {
        tokenVersion += params[2];
        return {
          rows: [{
            id: 1,
            username: 'alice',
            email: params[0] || 'alice@example.com',
            avatar_color: '#123456',
            token_version: tokenVersion,
          }],
        };
      }
      if (sql.includes('UPDATE users')) {
        return {
          rows: [{
            id: 1,
            username: params[0] || 'alice',
            email: 'alice@example.com',
            avatar_color: params[1] || '#123456',
            token_version: tokenVersion,
          }],
        };
      }
      throw new Error('Unexpected account settings query');
    },
  },
};

const app = express();
app.use(express.json());
let socketDisconnects = 0;
app.use((req, res, next) => {
  req.io = {
    in: () => ({
      disconnectSockets: () => { socketDisconnects += 1; },
    }),
  };
  next();
});
app.use('/api/auth', require('../src/routes/auth'));
let server;
let baseUrl;

test.before(async () => {
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
  if (previousJwtSecret === undefined) {
    delete process.env.JWT_SECRET;
  } else {
    process.env.JWT_SECRET = previousJwtSecret;
  }
});

function authHeader(version = tokenVersion) {
  const token = jwt.sign({ userId: 1, username: 'alice', tokenVersion: version }, config.JWT_SECRET);
  return { Authorization: `Bearer ${token}` };
}

test('profile updates validate and return the updated user and session token', async () => {
  const response = await fetch(`${baseUrl}/api/auth/me`, {
    method: 'PATCH',
    headers: { ...authHeader(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'alice-new', avatarColor: '#abcdef' }),
  });
  const data = await response.json();

  assert.equal(response.status, 200);
  assert.equal(data.user.username, 'alice-new');
  assert.equal(data.user.avatarColor, '#abcdef');
  assert.equal(jwt.verify(data.token, config.JWT_SECRET).tokenVersion, tokenVersion);
});

test('account settings require the current password and rotate session tokens on password change', async () => {
  const wrongPassword = await fetch(`${baseUrl}/api/auth/me/account`, {
    method: 'PUT',
    headers: { ...authHeader(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ currentPassword: 'wrong-password', newPassword: 'next-password' }),
  });
  assert.equal(wrongPassword.status, 401);

  const response = await fetch(`${baseUrl}/api/auth/me/account`, {
    method: 'PUT',
    headers: { ...authHeader(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ currentPassword: 'current-password', newPassword: 'next-password' }),
  });
  const data = await response.json();

  assert.equal(response.status, 200);
  assert.equal(jwt.verify(data.token, config.JWT_SECRET).tokenVersion, tokenVersion);
  assert.equal(socketDisconnects, 1);
});

test('password change invalidates tokens from the previous session version', async () => {
  const response = await fetch(`${baseUrl}/api/auth/me`, { headers: authHeader(0) });
  assert.equal(response.status, 403);
  assert.match((await response.json()).error, /Session expired/);
});
