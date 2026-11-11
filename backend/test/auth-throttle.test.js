const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const bcrypt = require('bcryptjs');

process.env.DATABASE_URL ||= 'postgres://127.0.0.1/test';
const previousJwtSecret = process.env.JWT_SECRET;
process.env.JWT_SECRET = 'throttle-test-secret';

const dbPath = require.resolve('../src/db');
const previousDbModule = require.cache[dbPath];
const PASSWORD = 'correct-horse-1';
const passwordHash = bcrypt.hashSync(PASSWORD, 4);

require.cache[dbPath] = {
  id: dbPath,
  filename: dbPath,
  loaded: true,
  exports: {
    query: async (sql, params = []) => {
      if (sql.includes('FROM users WHERE username = $1')) {
        return params[0] === 'alice'
          ? { rows: [{ id: 1, username: 'alice', email: 'alice@example.test', password_hash: passwordHash,
            avatar_color: '#000000', is_superadmin: false, token_version: 0 }] }
          : { rows: [] };
      }
      if (sql.includes('UPDATE users SET last_seen')) return { rows: [] };
      if (sql.includes('registration_mode')) return { rows: [{ registration_mode: 'invite' }] };
      throw new Error(`Unexpected query: ${sql}`);
    },
  },
};

const { resetAllLimits } = require('../src/authLimits');

const app = express();
app.use(express.json());
app.use('/api/auth', require('../src/routes/auth'));
let server;
let baseUrl;

test.before(async () => {
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.beforeEach(() => resetAllLimits());

test.after(async () => {
  if (server) await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  if (previousDbModule) require.cache[dbPath] = previousDbModule;
  else delete require.cache[dbPath];
  if (previousJwtSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = previousJwtSecret;
});

async function post(path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, headers: response.headers, body: await response.json().catch(() => ({})) };
}
const login = (username, password) => post('/api/auth/login', { username, password });

test('repeated wrong passwords lock that account (even for the right password) but not other accounts', async () => {
  for (let i = 0; i < 8; i += 1) assert.equal((await login('alice', 'wrong-guess')).status, 401);
  const locked = await login('alice', PASSWORD);
  assert.equal(locked.status, 429);
  assert.ok(Number(locked.headers.get('retry-after')) > 0, 'Retry-After tells the caller how long to wait');
  assert.match(locked.body.error, /Too many attempts/);
  assert.equal((await login('bob', 'anything')).status, 401, 'another account is not locked');
});

test('a successful sign-in clears the failure count', async () => {
  for (let i = 0; i < 7; i += 1) assert.equal((await login('alice', 'wrong-guess')).status, 401);
  assert.equal((await login('alice', PASSWORD)).status, 200);
  for (let i = 0; i < 7; i += 1) assert.equal((await login('alice', 'wrong-guess')).status, 401);
  assert.equal((await login('alice', PASSWORD)).status, 200, 'still allowed: counter was reset');
});

test('guessing across many usernames from one address is also capped', async () => {
  for (let i = 0; i < 40; i += 1) assert.equal((await login(`nobody-${i}`, 'guess')).status, 401);
  assert.equal((await login('nobody-40', 'guess')).status, 429);
  assert.equal((await login('alice', PASSWORD)).status, 429, 'the address is blocked for every account');
});

test('an unknown user and a wrong password get the same answer', async () => {
  const unknown = await login('nobody', 'some-password');
  const wrong = await login('alice', 'some-password');
  assert.equal(unknown.status, 401);
  assert.deepEqual(unknown.body, wrong.body);
});

test('non-text credentials are rejected cleanly instead of reaching the database', async () => {
  assert.equal((await post('/api/auth/login', { username: { $ne: '' }, password: 'x' })).status, 400);
  assert.equal((await post('/api/auth/login', { username: 'alice', password: ['x'] })).status, 400);
  assert.equal((await post('/api/auth/login', {})).status, 400);
});

test('sign-up attempts are limited per address', async () => {
  for (let i = 0; i < 15; i += 1) {
    assert.equal((await post('/api/auth/register', { username: `u${i}`, email: `u${i}@x.test`, password: 'short' })).status, 400);
  }
  const limited = await post('/api/auth/register', { username: 'late', email: 'late@x.test', password: 'long-enough-1' });
  assert.equal(limited.status, 429);
});

test('new passwords must be at least 8 characters and differ from the username', async () => {
  const short = await post('/api/auth/register', { username: 'carol', email: 'c@x.test', password: 'abc12' });
  assert.equal(short.status, 400);
  assert.match(short.body.error, /at least 8 characters/);
  const same = await post('/api/auth/register', { username: 'carol-pass-1', email: 'c@x.test', password: 'carol-pass-1' });
  assert.equal(same.status, 400);
  assert.match(same.body.error, /same as your username/);
});
