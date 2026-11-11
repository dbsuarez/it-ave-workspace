const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');

process.env.DATABASE_URL ||= 'postgres://127.0.0.1/test';
const previousJwtSecret = process.env.JWT_SECRET;
process.env.JWT_SECRET = 'canvas2-test-secret';

const config = require('../src/config');
const dbPath = require.resolve('../src/db');
const previousDbModule = require.cache[dbPath];

// In-memory canvas store
const canvases = new Map(); // id -> canvas
const members = new Set();   // "channelId:userId"
const moderators = new Set(); // "channelId:userId"
const collab = new Map();     // "canvasId:userId" -> role
const shares = new Map();     // token -> { canvasId, role }
const superadmins = new Set([99]);
let nextCanvasId = 1;
const emitted = [];

const API = () => (sql, params = []) => {
  if (sql.includes('SELECT token_version FROM users')) return { rows: [{ token_version: 0 }] };
  if (sql.includes('SELECT id, account_type FROM users WHERE id = ANY($1::int[])')) {
    // ensureGuestCanReach - test users are members, no guests
    return { rows: (params[0] || []).map((id) => ({ id, account_type: 'member' })) };
  }
  if (sql.includes('SELECT id FROM users WHERE id = $1')) {
    const id = Number(params[0]);
    return { rows: [{ id }] };
  }
  if (sql.includes('SELECT account_type FROM users WHERE id = $1')) {
    return { rows: [{ account_type: 'member' }] };
  }
  if (sql.includes('CROSS JOIN users u')) {
    const id = Number(params[1]);
    return { rows: members.has(`${params[0]}:${id}`) || superadmins.has(id) ? [{}] : [] };
  }
  if (sql.includes('JOIN users u ON u.id = $2')) {
    const channelId = Number(params[0]);
    const id = Number(params[1]);
    if (superadmins.has(id)) return { rows: [{}] };
    if (moderators.has(`${channelId}:${id}`)) return { rows: [{}] };
    // creator-of-channel shortcut isn't supported by this mock; restrict to moderators and superadmins
    return { rows: [] };
  }
  if (sql.includes('SELECT id, kind, channel_id, dm_user_low, dm_user_high, created_by, title, content')) {
    return { rows: [...canvases.values()].filter((c) => c.id === Number(params[0])) };
  }
  if (sql.includes('WHERE kind = \'channel\' AND channel_id = $1')) {
    return { rows: [...canvases.values()].filter((c) => c.kind === 'channel' && Number(c.channel_id) === Number(params[0])) };
  }
  if (sql.includes('WHERE kind = \'dm\' AND dm_user_low = $1 AND dm_user_high = $2')) {
    return { rows: [...canvases.values()].filter((c) => c.kind === 'dm' && Number(c.dm_user_low) === Number(params[0]) && Number(c.dm_user_high) === Number(params[1])) };
  }
  if (sql.includes('ON CONFLICT (channel_id)')) {
    const channelId = Number(params[0]);
    const title = params[1];
    const userId = params[2];
    const existing = [...canvases.values()].find((c) => c.kind === 'channel' && Number(c.channel_id) === channelId);
    if (existing) return { rows: [] };
    const canvas = { id: nextCanvasId++, kind: 'channel', channel_id: channelId, dm_user_low: null, dm_user_high: null, title, content: '', created_by: userId, created_at: new Date(), updated_at: new Date() };
    canvases.set(canvas.id, canvas);
    return { rows: [canvas] };
  }
  if (sql.includes('ON CONFLICT (dm_user_low, dm_user_high)')) {
    const low = Number(params[0]);
    const high = Number(params[1]);
    const title = params[2];
    const userId = params[3];
    const existing = [...canvases.values()].find((c) => c.kind === 'dm' && Number(c.dm_user_low) === low && Number(c.dm_user_high) === high);
    if (existing) return { rows: [] };
    const canvas = { id: nextCanvasId++, kind: 'dm', channel_id: null, dm_user_low: low, dm_user_high: high, title, content: '', created_by: userId, created_at: new Date(), updated_at: new Date() };
    canvases.set(canvas.id, canvas);
    return { rows: [canvas] };
  }
  if (sql.includes('FROM canvases c') && sql.includes('canvas_collaborators') && sql.includes('kind = \'standalone\'')) {
    const userId = Number(params[0]);
    const mine = [...canvases.values()].filter((c) => c.kind === 'standalone')
      .filter((c) => Number(c.created_by) === userId || collab.has(`${c.id}:${userId}`));
    return { rows: mine.map((c) => ({ ...c, my_role: Number(c.created_by) === userId ? 'owner' : collab.get(`${c.id}:${userId}`) })) };
  }
  if (sql.includes('INSERT INTO canvases (kind, title, content, created_by)')) {
    const canvas = { id: nextCanvasId++, kind: 'standalone', channel_id: null, dm_user_low: null, dm_user_high: null, title: params[0], content: params[1] || '', created_by: params[2], created_at: new Date(), updated_at: new Date() };
    canvases.set(canvas.id, canvas);
    return { rows: [canvas] };
  }
  if (sql.includes('SELECT role FROM canvas_collaborators WHERE canvas_id = $1 AND user_id = $2')) {
    const key = `${params[0]}:${params[1]}`;
    return { rows: collab.has(key) ? [{ role: collab.get(key) }] : [] };
  }
  if (sql.includes('UPDATE canvases')) {
    const id = Number(params[2]);
    const canvas = canvases.get(id);
    if (!canvas) return { rows: [] };
    if (params[0] !== null && params[0] !== undefined) canvas.title = params[0];
    if (params[1] !== null && params[1] !== undefined) canvas.content = params[1];
    canvas.updated_at = new Date();
    return { rows: [canvas] };
  }
  if (sql.includes('DELETE FROM canvases')) {
    canvases.delete(Number(params[0]));
    return { rows: [] };
  }
  if (sql.includes('SELECT u.id, u.username FROM users WHERE LOWER(username) = $1')) {
    // ensureListHasCollaborators / collab listing flow: return deterministic user for any username
    return { rows: [{ id: 42, username: params[0] }] };
  }
  if (sql.includes('LOWER(username) = $1')) {
    const match = String(params[0]).match(/\d+/);
    const id = match ? Number(match[0]) : 42;
    return { rows: [{ id, username: params[0] }] };
  }
  if (sql.includes('INSERT INTO canvas_collaborators')) {
    collab.set(`${params[0]}:${params[1]}`, params[2]);
    return { rows: [] };
  }
  if (sql.includes('DELETE FROM canvas_collaborators')) {
    collab.delete(`${params[0]}:${params[1]}`);
    return { rows: [] };
  }
  if (sql.includes('FROM canvas_collaborators cc')) {
    return { rows: [...collab.entries()].filter(([k]) => k.startsWith(`${params[0]}:`)).map(([k, role]) => ({ id: 42, username: 'guest', role, created_at: new Date() })) };
  }
  if (sql.includes('INSERT INTO canvas_shares')) {
    shares.set(params[1], { canvasId: Number(params[0]), role: params[2] });
    return { rows: [{ id: 1, canvas_id: params[0], token: params[1], role: params[2], created_at: new Date(), expires_at: null }] };
  }
  if (sql.includes('DELETE FROM canvas_shares')) {
    return { rows: [] };
  }
  if (sql.includes('FROM canvas_shares cs')) {
    const row = shares.get(params[0]);
    if (!row) return { rows: [] };
    const canvas = canvases.get(Number(row.canvasId));
    if (!canvas) return { rows: [] };
    return { rows: [{ share_id: 1, role: row.role, canvas_id: row.canvasId, expires_at: null, ...canvas }] };
  }
  if (sql.includes('SELECT id, canvas_id, role FROM canvas_shares WHERE token = $1')) {
    const row = shares.get(params[0]);
    return { rows: row ? [{ id: 1, canvas_id: row.canvasId, role: row.role }] : [] };
  }
  throw new Error(`Unexpected canvas query: ${sql}`);
};

require.cache[dbPath] = {
  id: dbPath,
  filename: dbPath,
  loaded: true,
  exports: { query: API() },
};

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  req.io = { to: (room) => ({ emit: (event, payload) => emitted.push({ room, event, payload }) }) };
  next();
});
app.use('/api/canvas', require('../src/routes/canvas'));
let server;
let baseUrl;

test.before(async () => {
  members.add('42:3');
  members.add('42:4');
  members.add('42:7');
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  if (server) await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  canvases.clear(); members.clear(); moderators.clear(); collab.clear(); shares.clear(); emitted.length = 0;
  if (previousDbModule) require.cache[dbPath] = previousDbModule;
  else delete require.cache[dbPath];
  if (previousJwtSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = previousJwtSecret;
});

function authHeader(userId) {
  const token = jwt.sign({ userId, username: `u${userId}` }, config.JWT_SECRET);
  return { Authorization: `Bearer ${token}` };
}

test('channel canvas is auto-created and shared between channel members', async () => {
  const r = await fetch(`${baseUrl}/api/canvas/channel/42`, { headers: authHeader(3) });
  assert.equal(r.status, 200);
  const { canvas } = await r.json();
  assert.equal(canvas.kind, 'channel');
  assert.equal(canvas.channelId, 42);
  // Second request returns same id (idempotent)
  const r2 = await fetch(`${baseUrl}/api/canvas/channel/42`, { headers: authHeader(4) });
  const { canvas: canvas2 } = await r2.json();
  assert.equal(canvas2.id, canvas.id);
});

test('DM canvas pair is unique per user pair', async () => {
  const r = await fetch(`${baseUrl}/api/canvas/dm/7`, { headers: authHeader(3) });
  assert.equal(r.status, 200);
  const { canvas } = await r.json();
  assert.equal(canvas.kind, 'dm');
  // Order doesn't matter for DM uniqueness
  const r2 = await fetch(`${baseUrl}/api/canvas/dm/3`, { headers: authHeader(7) });
  const { canvas: canvas2 } = await r2.json();
  assert.equal(canvas2.id, canvas.id);
});

test('Non-member cannot read channel canvas', async () => {
  const r = await fetch(`${baseUrl}/api/canvas/channel/42`, { headers: authHeader(99) });
  assert.equal(r.status, 200); // superadmin joins
  // But a user not in the channel must fail:
  members.delete('42:7');
  const r2 = await fetch(`${baseUrl}/api/canvas/channel/42`, { headers: authHeader(7) });
  assert.equal(r2.status, 403);
  members.add('42:7');
});

test('Standalone canvas is owner-only; collaborator works', async () => {
  // Create via POST
  const r = await fetch(`${baseUrl}/api/canvas`, {
    method: 'POST', headers: { ...authHeader(3), 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Roadmap', content: 'draft' }),
  });
  assert.equal(r.status, 201);
  const { canvas } = await r.json();
  // Outsider cannot read
  const r2 = await fetch(`${baseUrl}/api/canvas/${canvas.id}`, { headers: authHeader(7) });
  assert.equal(r2.status, 404);
  // Owner can
  const r3 = await fetch(`${baseUrl}/api/canvas/${canvas.id}`, { headers: authHeader(3) });
  assert.equal(r3.status, 200);
  // Add collaborator 7
  const r4 = await fetch(`${baseUrl}/api/canvas/${canvas.id}/collaborators`, {
    method: 'POST', headers: { ...authHeader(3), 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'u7', role: 'editor' }),
  });
  assert.equal(r4.status, 200);
  const r5 = await fetch(`${baseUrl}/api/canvas/${canvas.id}`, { headers: authHeader(7) });
  assert.equal(r5.status, 200);
});

test('Share token opens canvas for non-collab, editor can edit', async () => {
  const r = await fetch(`${baseUrl}/api/canvas`, {
    method: 'POST', headers: { ...authHeader(3), 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Shared', content: '' }),
  });
  const { canvas } = await r.json();
  const share = await fetch(`${baseUrl}/api/canvas/${canvas.id}/shares`, {
    method: 'POST', headers: { ...authHeader(3), 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'editor' }),
  });
  const { share: sh } = await share.json();
  const open = await fetch(`${baseUrl}/api/canvas/share/${sh.token}`, { headers: authHeader(7) });
  assert.equal(open.status, 200);
  // Edit via share
  const updated = await fetch(`${baseUrl}/api/canvas/share/${sh.token}`, {
    method: 'PATCH', headers: { ...authHeader(7), 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: 'hello' }),
  });
  assert.equal(updated.status, 200);
});

test('canvas_updated is emitted on PATCH', async () => {
  const r = await fetch(`${baseUrl}/api/canvas/channel/42`, { headers: authHeader(3) });
  const { canvas } = await r.json();
  emitted.length = 0;
  const patch = await fetch(`${baseUrl}/api/canvas/${canvas.id}`, {
    method: 'PATCH', headers: { ...authHeader(3), 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: 'updated body' }),
  });
  assert.equal(patch.status, 200);
  const evt = emitted.find((e) => e.event === 'canvas_updated');
  assert.ok(evt, 'canvas_updated should be emitted');
  assert.equal(evt.room, `canvas:${canvas.id}`);
});
