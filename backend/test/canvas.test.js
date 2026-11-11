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
const guests = new Set();       // user ids with account_type 'guest'
const grants = [];              // { canvasId, channelId, role }
const usersByName = new Map();  // username -> { id, username, account_type }
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
    return { rows: [{ account_type: guests.has(Number(params[0])) ? 'guest' : 'member' }] };
  }
  if (sql.includes('SELECT id, username, account_type FROM users WHERE LOWER(username) = $1')) {
    const known = usersByName.get(params[0]);
    return { rows: known ? [known] : [] };
  }
  if (sql.includes('UPDATE canvases SET owner_id = $1 WHERE id = $2')) {
    canvases.get(Number(params[1])).owner_id = Number(params[0]);
    return { rows: [] };
  }
  if (sql.includes('SELECT g.role FROM canvas_channel_grants g')) {
    const rows = grants
      .filter((g) => g.canvasId === Number(params[0]) && members.has(`${g.channelId}:${params[1]}`))
      .map((g) => ({ role: g.role }));
    return { rows };
  }
  if (sql.includes('FROM canvas_channel_grants g JOIN channels c')) {
    return { rows: grants.filter((g) => g.canvasId === Number(params[0])).map((g) => ({ channel_id: g.channelId, name: `chan${g.channelId}`, role: g.role, created_at: new Date() })) };
  }
  if (sql.includes('INSERT INTO canvas_channel_grants')) {
    const existing = grants.find((g) => g.canvasId === Number(params[0]) && g.channelId === Number(params[1]));
    if (existing) existing.role = params[2];
    else grants.push({ canvasId: Number(params[0]), channelId: Number(params[1]), role: params[2] });
    return { rows: [] };
  }
  if (sql.includes('DELETE FROM canvas_channel_grants')) {
    const i = grants.findIndex((g) => g.canvasId === Number(params[0]) && g.channelId === Number(params[1]));
    if (i !== -1) grants.splice(i, 1);
    return { rows: [] };
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
    const canvas = { id: nextCanvasId++, kind: 'channel', channel_id: channelId, dm_user_low: null, dm_user_high: null, title, content: '', created_by: userId, created_at: new Date(), updated_at: new Date(), revision: 1 };
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
    const canvas = { id: nextCanvasId++, kind: 'dm', channel_id: null, dm_user_low: low, dm_user_high: high, title, content: '', created_by: userId, created_at: new Date(), updated_at: new Date(), revision: 1 };
    canvases.set(canvas.id, canvas);
    return { rows: [canvas] };
  }
  if (sql.includes('FROM canvases c') && sql.includes('canvas_collaborators') && sql.includes('kind = \'standalone\'')) {
    const userId = Number(params[0]);
    const mine = [...canvases.values()].filter((c) => c.kind === 'standalone')
      .filter((c) => Number(c.owner_id ?? c.created_by) === userId || collab.has(`${c.id}:${userId}`)
        || grants.some((g) => g.canvasId === c.id && members.has(`${g.channelId}:${userId}`)));
    return { rows: mine };
  }
  if (sql.includes('INSERT INTO canvases (kind, title, content, created_by, owner_id)')) {
    const canvas = { id: nextCanvasId++, kind: 'standalone', channel_id: null, dm_user_low: null, dm_user_high: null, title: params[0], content: params[1] || '', created_by: params[2], owner_id: params[2], created_at: new Date(), updated_at: new Date(), revision: 1 };
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
    // Mirrors "WHERE id = $3 AND ($4::int IS NULL OR revision = $4)"
    if (params[3] !== null && params[3] !== undefined && Number(params[3]) !== canvas.revision) return { rows: [] };
    if (params[0] !== null && params[0] !== undefined) canvas.title = params[0];
    if (params[1] !== null && params[1] !== undefined) canvas.content = params[1];
    canvas.revision += 1;
    canvas.updated_at = new Date();
    return { rows: [canvas] };
  }
  if (sql.includes('FROM canvases WHERE id = $1')) {
    const canvas = canvases.get(Number(params[0]));
    return { rows: canvas ? [canvas] : [] };
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
  guests.clear(); grants.length = 0; usersByName.clear();
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

test('saving with the current baseRevision works and bumps the revision', async () => {
  const created = await (await fetch(`${baseUrl}/api/canvas`, {
    method: 'POST', headers: { ...authHeader(3), 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Rev', content: 'one' }),
  })).json();
  assert.equal(created.canvas.revision, 1);
  const patch = (body, user = 3) => fetch(`${baseUrl}/api/canvas/${created.canvas.id}`, {
    method: 'PATCH', headers: { ...authHeader(user), 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  emitted.length = 0;
  const ok = await patch({ content: 'two', baseRevision: 1 });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).canvas.revision, 2);
  const event = emitted.find((e) => e.event === 'canvas_updated');
  assert.equal(event.payload.revision, 2, 'the live event carries the new revision');
  assert.equal(event.payload.content, 'two');

  // A second save from the old starting point is refused and changes nothing
  const stale = await patch({ content: 'overwrite attempt', baseRevision: 1 });
  assert.equal(stale.status, 409);
  const body = await stale.json();
  assert.equal(body.code, 'revision_conflict');
  assert.equal(body.canvas.content, 'two', 'the response carries the current version');
  assert.equal(body.canvas.revision, 2);
  assert.equal(canvases.get(created.canvas.id).content, 'two', 'nothing was written');

  // Retrying from the revision it was given succeeds
  const retry = await patch({ content: 'three', baseRevision: 2 });
  assert.equal(retry.status, 200);
  assert.equal((await retry.json()).canvas.revision, 3);
});

test('older clients that send no baseRevision still save (last write wins) and bump the revision', async () => {
  const created = await (await fetch(`${baseUrl}/api/canvas`, {
    method: 'POST', headers: { ...authHeader(3), 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Legacy', content: 'a' }),
  })).json();
  const res = await fetch(`${baseUrl}/api/canvas/${created.canvas.id}`, {
    method: 'PATCH', headers: { ...authHeader(3), 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: 'b' }),
  });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).canvas.revision, 2);
});

test('a malformed baseRevision is rejected', async () => {
  const created = await (await fetch(`${baseUrl}/api/canvas`, {
    method: 'POST', headers: { ...authHeader(3), 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Bad', content: '' }),
  })).json();
  for (const bad of [0, -1, 1.5, 'abc', {}]) {
    const res = await fetch(`${baseUrl}/api/canvas/${created.canvas.id}`, {
      method: 'PATCH', headers: { ...authHeader(3), 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'x', baseRevision: bad }),
    });
    assert.equal(res.status, 400, `baseRevision ${JSON.stringify(bad)}`);
  }
  assert.equal(canvases.get(created.canvas.id).content, '');
});

test('share-link edits use the same revision check', async () => {
  const created = await (await fetch(`${baseUrl}/api/canvas`, {
    method: 'POST', headers: { ...authHeader(3), 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Shared rev', content: 'start' }),
  })).json();
  const { share } = await (await fetch(`${baseUrl}/api/canvas/${created.canvas.id}/shares`, {
    method: 'POST', headers: { ...authHeader(3), 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'editor' }),
  })).json();
  const patchShare = (body) => fetch(`${baseUrl}/api/canvas/share/${share.token}`, {
    method: 'PATCH', headers: { ...authHeader(7), 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  assert.equal((await patchShare({ content: 'by link', baseRevision: 1 })).status, 200);
  const stale = await patchShare({ content: 'late', baseRevision: 1 });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).canvas.content, 'by link');
});

async function createStandalone(content) {
  const r = await fetch(`${baseUrl}/api/canvas`, {
    method: 'POST', headers: { ...authHeader(3), 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Sections', content }),
  });
  return (await r.json()).canvas;
}
const sectionPatch = (id, body, user = 3) => fetch(`${baseUrl}/api/canvas/${id}`, {
  method: 'PATCH', headers: { ...authHeader(user), 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

test('sections lookup returns blocks and the revision they belong to', async () => {
  const canvas = await createStandalone('# Plan\n\n- [ ] one\n- [ ] two\n\nDone.');
  const res = await fetch(`${baseUrl}/api/canvas/${canvas.id}/sections?type=checklist`, { headers: authHeader(3) });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.revision, 1);
  assert.equal(body.sections.length, 1);
  assert.equal(body.sections[0].items.length, 2);
  const search = await (await fetch(`${baseUrl}/api/canvas/${canvas.id}/sections?contains=done`, { headers: authHeader(3) })).json();
  assert.equal(search.sections[0].type, 'paragraph');
  const outsider = await fetch(`${baseUrl}/api/canvas/${canvas.id}/sections`, { headers: authHeader(7) });
  assert.equal(outsider.status, 404, 'access rules apply to lookups too');
});

test('a section operation edits one block and bumps the revision', async () => {
  const canvas = await createStandalone('# Plan\n\n- [ ] one\n- [ ] two\n\nDone.');
  const { sections, revision } = await (await fetch(`${baseUrl}/api/canvas/${canvas.id}/sections?type=checklist`, { headers: authHeader(3) })).json();
  emitted.length = 0;
  const res = await sectionPatch(canvas.id, { operation: { op: 'toggle', sectionId: sections[0].id, item: 1 }, baseRevision: revision });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.canvas.content, '# Plan\n\n- [ ] one\n- [x] two\n\nDone.');
  assert.equal(body.canvas.revision, 2);
  assert.equal(emitted.find((e) => e.event === 'canvas_updated').payload.revision, 2);
});

test('an operation needs a baseRevision, and a stale one gets the current canvas back', async () => {
  const canvas = await createStandalone('# A\n\nText');
  const { sections } = await (await fetch(`${baseUrl}/api/canvas/${canvas.id}/sections`, { headers: authHeader(3) })).json();
  const op = { op: 'delete', sectionId: sections[1].id };
  assert.equal((await sectionPatch(canvas.id, { operation: op })).status, 400);
  assert.equal((await sectionPatch(canvas.id, { content: 'x', operation: op, baseRevision: 1 })).status, 400, 'not mixed with content');
  assert.equal((await sectionPatch(canvas.id, { content: '# A\n\nChanged elsewhere', baseRevision: 1 })).status, 200);
  const stale = await sectionPatch(canvas.id, { operation: op, baseRevision: 1 });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).canvas.content, '# A\n\nChanged elsewhere');
  assert.equal(canvases.get(canvas.id).content, '# A\n\nChanged elsewhere', 'nothing was deleted');
});

test('operations respect roles and report a missing section', async () => {
  const canvas = await createStandalone('# A\n\nText');
  const viewerAdd = await fetch(`${baseUrl}/api/canvas/${canvas.id}/collaborators`, {
    method: 'POST', headers: { ...authHeader(3), 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'u4', role: 'viewer' }),
  });
  assert.equal(viewerAdd.status, 200);
  const asViewer = await sectionPatch(canvas.id, { operation: { op: 'insert_at_end', markdown: 'x' }, baseRevision: 1 }, 4);
  assert.equal(asViewer.status, 403, 'viewers cannot edit');
  const missing = await sectionPatch(canvas.id, { operation: { op: 'delete', sectionId: '9-aaaaaa' }, baseRevision: 1 });
  assert.equal(missing.status, 404);
  const unknown = await sectionPatch(canvas.id, { operation: { op: 'explode' }, baseRevision: 1 });
  assert.equal(unknown.status, 400);
});

const jsonHeaders = (user) => ({ ...authHeader(user), 'Content-Type': 'application/json' });

test('the owner is explicit, listed as owner, and ownership can be transferred', async () => {
  const canvas = await createStandalone('mine');
  assert.equal(canvas.ownerId, 3);
  usersByName.set('u4', { id: 4, username: 'u4', account_type: 'member' });
  usersByName.set('gast', { id: 8, username: 'gast', account_type: 'guest' });
  // only the owner can transfer; guests cannot become owner; self-transfer is refused
  assert.equal((await fetch(`${baseUrl}/api/canvas/${canvas.id}/owner`, { method: 'POST', headers: jsonHeaders(4), body: JSON.stringify({ username: 'u4' }) })).status, 404, 'a stranger cannot even see it');
  assert.equal((await fetch(`${baseUrl}/api/canvas/${canvas.id}/owner`, { method: 'POST', headers: jsonHeaders(3), body: JSON.stringify({ username: 'gast' }) })).status, 400);
  assert.equal((await fetch(`${baseUrl}/api/canvas/${canvas.id}/owner`, { method: 'POST', headers: jsonHeaders(3), body: JSON.stringify({ username: 'u3' }) })).status, 404, 'unknown user');
  const ok = await fetch(`${baseUrl}/api/canvas/${canvas.id}/owner`, { method: 'POST', headers: jsonHeaders(3), body: JSON.stringify({ username: 'u4' }) });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).ownerId, 4);
  // the new owner owns it; the old owner is now an editor and can no longer delete or re-share
  const asNew = await (await fetch(`${baseUrl}/api/canvas/${canvas.id}`, { headers: authHeader(4) })).json();
  assert.equal(asNew.canvas.myRole, 'owner');
  const asOld = await (await fetch(`${baseUrl}/api/canvas/${canvas.id}`, { headers: authHeader(3) })).json();
  assert.equal(asOld.canvas.myRole, 'editor');
  assert.equal((await fetch(`${baseUrl}/api/canvas/${canvas.id}`, { method: 'DELETE', headers: authHeader(3) })).status, 403);
  assert.equal((await fetch(`${baseUrl}/api/canvas/${canvas.id}/shares`, { method: 'POST', headers: jsonHeaders(3), body: JSON.stringify({ role: 'viewer' }) })).status, 403);
  assert.equal((await fetch(`${baseUrl}/api/canvas/${canvas.id}`, { method: 'DELETE', headers: authHeader(4) })).status, 200);
});

test('a canvas can be shared with a whole channel, as viewer or editor', async () => {
  const canvas = await createStandalone('for the team');
  // 7 is a member of channel 42 but has no personal grant
  assert.equal((await fetch(`${baseUrl}/api/canvas/${canvas.id}`, { headers: authHeader(7) })).status, 404);
  const grant = await fetch(`${baseUrl}/api/canvas/${canvas.id}/channels/42`, { method: 'PUT', headers: jsonHeaders(3), body: JSON.stringify({ role: 'viewer' }) });
  assert.equal(grant.status, 200);
  const asViewer = await (await fetch(`${baseUrl}/api/canvas/${canvas.id}`, { headers: authHeader(7) })).json();
  assert.equal(asViewer.canvas.myRole, 'viewer');
  assert.equal((await sectionPatch(canvas.id, { content: 'nope', baseRevision: 1 }, 7)).status, 403);
  const listed = await (await fetch(`${baseUrl}/api/canvas/standalone`, { headers: authHeader(7) })).json();
  assert.ok(listed.canvases.some((c) => c.id === canvas.id && c.myRole === 'viewer'), 'it shows in the channel members list');
  // upgrade to editor: members can edit
  await fetch(`${baseUrl}/api/canvas/${canvas.id}/channels/42`, { method: 'PUT', headers: jsonHeaders(3), body: JSON.stringify({ role: 'editor' }) });
  assert.equal((await sectionPatch(canvas.id, { content: 'team edit', baseRevision: 1 }, 7)).status, 200);
  // a non-member of the channel gets nothing from the grant
  assert.equal((await fetch(`${baseUrl}/api/canvas/${canvas.id}`, { headers: authHeader(55) })).status, 404);
  const channels = await (await fetch(`${baseUrl}/api/canvas/${canvas.id}/channels`, { headers: authHeader(3) })).json();
  assert.deepEqual(channels.channels.map((c) => [c.channelId, c.role]), [[42, 'editor']]);
  // revoke
  assert.equal((await fetch(`${baseUrl}/api/canvas/${canvas.id}/channels/42`, { method: 'DELETE', headers: authHeader(3) })).status, 200);
  assert.equal((await fetch(`${baseUrl}/api/canvas/${canvas.id}`, { headers: authHeader(7) })).status, 404);
});

test('only the owner can grant, and only to a channel they belong to', async () => {
  const canvas = await createStandalone('x');
  await fetch(`${baseUrl}/api/canvas/${canvas.id}/collaborators`, { method: 'POST', headers: jsonHeaders(3), body: JSON.stringify({ username: 'u4', role: 'editor' }) });
  const byEditor = await fetch(`${baseUrl}/api/canvas/${canvas.id}/channels/42`, { method: 'PUT', headers: jsonHeaders(4), body: JSON.stringify({ role: 'viewer' }) });
  assert.equal(byEditor.status, 403, 'an editor is not the owner');
  const foreign = await fetch(`${baseUrl}/api/canvas/${canvas.id}/channels/777`, { method: 'PUT', headers: jsonHeaders(3), body: JSON.stringify({ role: 'viewer' }) });
  assert.equal(foreign.status, 403, 'not a member of channel 777');
  const badRole = await fetch(`${baseUrl}/api/canvas/${canvas.id}/channels/42`, { method: 'PUT', headers: jsonHeaders(3), body: JSON.stringify({ role: 'owner' }) });
  assert.equal(badRole.status, 400);
});

test('guests are read-only by default and only edit when granted personally', async () => {
  const canvas = await createStandalone('guest test');
  guests.add(7);
  // channel grant as editor: a guest member is capped at viewer
  await fetch(`${baseUrl}/api/canvas/${canvas.id}/channels/42`, { method: 'PUT', headers: jsonHeaders(3), body: JSON.stringify({ role: 'editor' }) });
  const capped = await (await fetch(`${baseUrl}/api/canvas/${canvas.id}`, { headers: authHeader(7) })).json();
  assert.equal(capped.canvas.myRole, 'viewer');
  assert.equal((await sectionPatch(canvas.id, { content: 'guest edit', baseRevision: 1 }, 7)).status, 403);
  // an explicit personal grant is a deliberate decision and is honoured
  await fetch(`${baseUrl}/api/canvas/${canvas.id}/collaborators`, { method: 'POST', headers: jsonHeaders(3), body: JSON.stringify({ username: 'u7', role: 'editor' }) });
  assert.equal((await sectionPatch(canvas.id, { content: 'granted guest edit', baseRevision: 1 }, 7)).status, 200);
  // channel and DM canvases: guests can read but not edit
  const channelCanvas = await (await fetch(`${baseUrl}/api/canvas/channel/42`, { headers: authHeader(3) })).json();
  assert.equal((await fetch(`${baseUrl}/api/canvas/${channelCanvas.canvas.id}`, { headers: authHeader(7) })).status, 200);
  assert.equal((await sectionPatch(channelCanvas.canvas.id, { content: 'guest edit', baseRevision: channelCanvas.canvas.revision }, 7)).status, 403);
  guests.delete(7);
  assert.equal((await sectionPatch(channelCanvas.canvas.id, { content: 'member edit', baseRevision: channelCanvas.canvas.revision }, 7)).status, 200);
});
