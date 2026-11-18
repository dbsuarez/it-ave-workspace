// Drawings: the REST API (create in a channel, a forum topic or on its own; read, rename, invite, share a copy, delete, images).
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');
const { createScratchDatabase } = require('./helpers/scratchDb');

let scratch; let admin; let server; let baseUrl; let pool; let config;
const ids = {};
const emitted = [];
const fakeIo = { to: (room) => ({ emit: (event, payload) => emitted.push({ room, event, payload }) }), emit: (event, payload) => emitted.push({ room: null, event, payload }), in: () => ({ fetchSockets: async () => [] }) };

test.before(async () => {
  scratch = await createScratchDatabase();
  if (!scratch) return;
  admin = await scratch.open();
  await scratch.applyInit(admin);
  await scratch.applyMigrations(admin);
  process.env.DATABASE_URL = scratch.url;
  process.env.JWT_SECRET = 'drawings-api-secret';
  config = require('../src/config');
  pool = require('../src/db').pool;
  const forums = require('../src/forums');
  const add = async (name, type = 'member') => (await admin.query(
    'INSERT INTO users (username, email, password_hash, account_type) VALUES ($1, $2, $3, $4) RETURNING id', [name, `${name}@x.test`, 'x', type])).rows[0].id;
  for (const name of ['ann', 'bob', 'cara', 'mod', 'ed', 'vi']) ids[name] = await add(`dw-${name}`);
  ids.guest = await add('dw-guest', 'guest');
  ids.head = await add('dw-head');
  ids.mis = (await admin.query("INSERT INTO departments (name, head_id) VALUES ('MIS', $1) RETURNING id", [ids.head])).rows[0].id;
  ids.legal = (await admin.query("INSERT INTO departments (name) VALUES ('Legal') RETURNING id")).rows[0].id;
  for (const [user, dept] of [['ann', 'mis'], ['bob', 'mis'], ['head', 'mis'], ['cara', 'legal']]) await admin.query('INSERT INTO user_departments (user_id, department_id, is_primary) VALUES ($1, $2, TRUE)', [ids[user], ids[dept]]);
  const q = (...a) => admin.query(...a);
  ids.forum = await forums.ensureDepartmentForum(q, ids.mis);
  ids.chan = (await admin.query("INSERT INTO channels (name, slowmode_seconds) VALUES ('dw-chan', 0) RETURNING id")).rows[0].id;
  ids.chan2 = (await admin.query("INSERT INTO channels (name, slowmode_seconds) VALUES ('dw-chan2', 0) RETURNING id")).rows[0].id;
  for (const user of ['ann', 'bob', 'mod', 'guest']) await admin.query('INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2)', [ids.chan, ids[user]]);
  await admin.query("UPDATE channel_members SET role = 'moderator' WHERE channel_id = $1 AND user_id = $2", [ids.chan, ids.mod]);
  await admin.query('INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2)', [ids.chan2, ids.cara]);
  const topic = async (extra) => (await admin.query(`INSERT INTO forum_topics (channel_id, title, created_by ${extra ? ', ' + extra : ''}) VALUES ($1, 'T', $2 ${extra ? ', NOW()' : ''}) RETURNING id`, [ids.forum, ids.ann])).rows[0].id;
  ids.topic = await topic(); ids.lockedTopic = await topic('locked_at');
  ids.otherForum = await forums.ensureDepartmentForum(q, ids.legal);
  ids.otherTopic = (await admin.query("INSERT INTO forum_topics (channel_id, title, created_by) VALUES ($1, 'O', $2) RETURNING id", [ids.otherForum, ids.cara])).rows[0].id;
  const app = express();
  app.use((req, res, next) => { req.io = fakeIo; next(); });
  app.use('/api/drawings', require('../src/routes/drawings'));
  app.use(express.json());
  app.use('/api/messages', require('../src/routes/messages'));
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (pool) await pool.end();
  if (admin) await admin.end();
  if (scratch) await scratch.drop();
});

const skip = (t) => { if (!scratch) { t.skip('no PostgreSQL reachable'); return true; } return false; };
const token = (userId) => jwt.sign({ userId, username: 'u', tokenVersion: 0 }, config.JWT_SECRET);
async function call(user, method, path, body) {
  const response = await fetch(`${baseUrl}/api/${path}`, {
    method, headers: { Authorization: `Bearer ${token(ids[user])}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, json: await response.json().catch(() => ({})), headers: response.headers };
}
const create = (user, body) => call(user, 'POST', 'drawings', body);
const shape = (id, version = 1, nonce = 1) => ({ id, type: 'rectangle', version, versionNonce: nonce, x: 0, y: 0 });
const png = (bytes) => Buffer.alloc(bytes, 1).toString('base64');

test('a standalone drawing: created, titled, listed under mine; blank or long titles and a guest are refused', async (t) => {
  if (skip(t)) return;
  const made = await create('ann', { title: '  Network map  ' });
  assert.equal(made.status, 201, JSON.stringify(made.json));
  assert.equal(made.json.drawing.title, 'Network map');
  assert.equal(made.json.drawing.kind, 'standalone');
  assert.equal(made.json.drawing.role, 'editor');
  assert.equal(made.json.drawing.revision, 1);
  assert.equal(made.json.message, undefined, 'no card for a standalone drawing');
  ids.standalone = made.json.drawing.id;
  assert.equal((await create('ann', { title: '   ' })).status, 400);
  assert.equal((await create('ann', { title: 'x'.repeat(121) })).status, 400);
  assert.equal((await create('ann', { title: 5 })).status, 400);
  assert.equal((await create('ann', { title: 'x', topicId: ids.topic })).status, 400, 'a topic needs its forum');
  assert.equal((await create('guest', { title: 'guest' })).status, 403);
  const mine = await call('ann', 'GET', 'drawings?scope=mine');
  assert.deepEqual(mine.json.drawings.map((d) => d.id), [ids.standalone]);
  assert.deepEqual((await call('bob', 'GET', 'drawings?scope=mine')).json.drawings, []);
  assert.equal((await call('ann', 'GET', 'drawings')).status, 400, 'a list needs a scope or a channel');
});

test('a channel drawing posts a card into the channel and is listed there; an outsider cannot create or list', async (t) => {
  if (skip(t)) return;
  const before = emitted.length;
  const made = await create('ann', { title: 'Sprint board', channelId: ids.chan });
  assert.equal(made.status, 201, JSON.stringify(made.json));
  ids.channelDrawing = made.json.drawing.id;
  assert.equal(made.json.drawing.kind, 'channel');
  const card = (await admin.query('SELECT id, kind, content, channel_id, topic_id FROM messages WHERE id = $1', [made.json.message.id])).rows[0];
  assert.deepEqual([card.kind, card.content, card.channel_id, card.topic_id], ['drawing', 'Sprint board', ids.chan, null]);
  assert.equal((await admin.query('SELECT message_id FROM drawings WHERE id = $1', [ids.channelDrawing])).rows[0].message_id, card.id);
  const seen = emitted.slice(before);
  assert.ok(seen.some((e) => e.event === 'new_message' && e.payload.kind === 'drawing' && e.payload.drawing.id === ids.channelDrawing));
  assert.ok(seen.some((e) => e.event === 'drawing_created' && e.payload.drawingId === ids.channelDrawing));
  assert.equal((await create('cara', { title: 'nope', channelId: ids.chan })).status, 403, 'an outsider');
  assert.equal((await create('guest', { title: 'nope', channelId: ids.chan })).status, 403, 'a guest');
  const list = await call('bob', 'GET', `drawings?channelId=${ids.chan}`);
  assert.deepEqual(list.json.drawings.map((d) => d.id), [ids.channelDrawing]);
  assert.equal(list.json.drawings[0].role, 'editor');
  assert.equal((await call('guest', 'GET', `drawings?channelId=${ids.chan}`)).json.drawings[0].role, 'viewer');
  assert.equal((await call('cara', 'GET', `drawings?channelId=${ids.chan}`)).status, 403);
});

test('a forum drawing needs a topic, lands in that topic, and is refused for outsiders, other forums’ topics and locked topics', async (t) => {
  if (skip(t)) return;
  assert.equal((await create('bob', { title: 'no topic', channelId: ids.forum })).status, 400);
  const before = (await admin.query('SELECT last_activity_at FROM forum_topics WHERE id = $1', [ids.topic])).rows[0].last_activity_at;
  const made = await create('bob', { title: 'Server rack', channelId: ids.forum, topicId: ids.topic });
  assert.equal(made.status, 201, JSON.stringify(made.json));
  ids.topicDrawing = made.json.drawing.id;
  assert.equal(made.json.drawing.topicId, ids.topic);
  assert.equal((await admin.query('SELECT topic_id FROM messages WHERE id = $1', [made.json.message.id])).rows[0].topic_id, ids.topic);
  assert.ok((await admin.query('SELECT last_activity_at FROM forum_topics WHERE id = $1', [ids.topic])).rows[0].last_activity_at > before, 'the topic shows new activity');
  assert.equal((await create('cara', { title: 'x', channelId: ids.forum, topicId: ids.topic })).status, 403, 'another department');
  assert.ok([400, 404].includes((await create('bob', { title: 'x', channelId: ids.forum, topicId: ids.otherTopic })).status), 'a topic of another forum');
  assert.equal((await create('bob', { title: 'x', channelId: ids.forum, topicId: ids.lockedTopic })).status, 409, 'a locked topic');
  assert.equal((await create('guest', { title: 'x', channelId: ids.forum, topicId: ids.topic })).status, 403);
  assert.equal((await create('bob', { title: 'x', channelId: ids.chan, topicId: ids.topic })).status, 400, 'a topic in an ordinary channel');
  const list = await call('bob', 'GET', `drawings?channelId=${ids.forum}&topicId=${ids.topic}`);
  assert.deepEqual(list.json.drawings.map((d) => d.id), [ids.topicDrawing]);
  assert.equal((await call('cara', 'GET', `drawings?channelId=${ids.forum}`)).status, 403);
});

test('the card shows in message history with its drawing; a topic card shows only in its topic', async (t) => {
  if (skip(t)) return;
  const history = await call('bob', 'GET', `messages/${ids.chan}`);
  const card = history.json.messages.find((m) => m.kind === 'drawing');
  assert.equal(card.drawing.id, ids.channelDrawing);
  assert.equal(card.drawing.title, 'Sprint board');
  const topicHistory = await call('bob', 'GET', `messages/${ids.forum}?topicId=${ids.topic}`);
  assert.equal(topicHistory.json.messages.find((m) => m.kind === 'drawing').drawing.id, ids.topicDrawing);
});

test('reading a drawing: the owner gets scene, files, role and people; a viewer gets the role without the people; outsiders and unknown ids are refused', async (t) => {
  if (skip(t)) return;
  const got = await call('ann', 'GET', `drawings/${ids.standalone}`);
  assert.equal(got.status, 200);
  assert.deepEqual(got.json.scene, { elements: [], appState: {} });
  assert.deepEqual(got.json.files, []);
  assert.equal(got.json.role, 'editor');
  assert.deepEqual(got.json.members, []);
  assert.equal((await call('bob', 'GET', `drawings/${ids.standalone}`)).status, 403);
  assert.equal((await call('ann', 'GET', 'drawings/999999')).status, 404);
  assert.equal((await call('ann', 'GET', 'drawings/abc')).status, 400);
  assert.equal((await call('guest', 'GET', `drawings/${ids.channelDrawing}`)).json.role, 'viewer');
  assert.equal((await call('cara', 'GET', `drawings/${ids.channelDrawing}`)).status, 403);
  assert.equal((await call('cara', 'GET', `drawings/${ids.topicDrawing}`)).status, 403);
});

test('renaming needs an editor; invitations are the owner’s and only for standalone drawings', async (t) => {
  if (skip(t)) return;
  assert.equal((await call('ann', 'PATCH', `drawings/${ids.standalone}`, { title: 'Network map v2' })).status, 200);
  assert.equal((await call('ann', 'PATCH', `drawings/${ids.standalone}`, { title: '' })).status, 400);
  assert.equal((await call('bob', 'PATCH', `drawings/${ids.standalone}`, { title: 'hijack' })).status, 403);
  assert.equal((await call('ann', 'PUT', `drawings/${ids.standalone}/members/${ids.ed}`, { role: 'editor' })).status, 200);
  assert.equal((await call('ann', 'PUT', `drawings/${ids.standalone}/members/${ids.vi}`, { role: 'viewer' })).status, 200);
  assert.equal((await call('ed', 'PUT', `drawings/${ids.standalone}/members/${ids.bob}`, { role: 'viewer' })).status, 403, 'an editor cannot invite');
  assert.equal((await call('ann', 'PUT', `drawings/${ids.standalone}/members/${ids.bob}`, { role: 'owner' })).status, 400);
  assert.equal((await call('ann', 'PUT', `drawings/${ids.standalone}/members/${ids.ann}`, { role: 'viewer' })).status, 400, 'not yourself');
  assert.equal((await call('ann', 'PUT', `drawings/${ids.standalone}/members/999999`, { role: 'viewer' })).status, 404);
  assert.equal((await call('ann', 'PUT', `drawings/${ids.channelDrawing}/members/${ids.bob}`, { role: 'viewer' })).status, 400, 'channel drawings follow the channel');
  assert.equal((await call('ed', 'PATCH', `drawings/${ids.standalone}`, { title: 'by editor' })).status, 200);
  assert.equal((await call('vi', 'PATCH', `drawings/${ids.standalone}`, { title: 'by viewer' })).status, 403);
  assert.equal((await call('vi', 'GET', `drawings/${ids.standalone}`)).json.role, 'viewer');
  assert.equal((await call('vi', 'GET', `drawings/${ids.standalone}`)).json.members, undefined, 'only the owner sees who it is shared with');
  const shared = await call('vi', 'GET', 'drawings?scope=shared');
  assert.deepEqual(shared.json.drawings.map((d) => [d.id, d.role]), [[ids.standalone, 'viewer']]);
  const owner = await call('ann', 'GET', `drawings/${ids.standalone}`);
  assert.deepEqual(owner.json.members.map((m) => m.role).sort(), ['editor', 'viewer']);
  assert.equal((await call('ed', 'DELETE', `drawings/${ids.standalone}/members/${ids.vi}`)).status, 403);
  assert.equal((await call('ann', 'DELETE', `drawings/${ids.standalone}/members/${ids.vi}`)).status, 200);
  assert.equal((await call('vi', 'GET', `drawings/${ids.standalone}`)).status, 403, 'removed at once');
});

test('images: an editor uploads, anyone with access downloads the same bytes; bad type, key, size and total are refused; viewers and outsiders cannot', async (t) => {
  if (skip(t)) return;
  const file = (key, bytes = 100, mime = 'image/png') => ({ key, mime, dataBase64: png(bytes) });
  const up = await call('ann', 'POST', `drawings/${ids.standalone}/files`, file('k1', 100));
  assert.equal(up.status, 201, JSON.stringify(up.json));
  assert.equal((await call('ann', 'POST', `drawings/${ids.standalone}/files`, file('k1', 100))).status, 201, 'the same key again is fine (same picture)');
  assert.equal((await call('vi', 'POST', `drawings/${ids.standalone}/files`, file('k2'))).status, 403);
  assert.equal((await call('bob', 'POST', `drawings/${ids.standalone}/files`, file('k2'))).status, 403);
  assert.equal((await call('ann', 'POST', `drawings/${ids.standalone}/files`, file('k3', 100, 'text/html'))).status, 400);
  assert.equal((await call('ann', 'POST', `drawings/${ids.standalone}/files`, file('', 100))).status, 400);
  assert.equal((await call('ann', 'POST', `drawings/${ids.standalone}/files`, file('x'.repeat(65), 100))).status, 400);
  assert.equal((await call('ann', 'POST', `drawings/${ids.standalone}/files`, file('big', 2 * 1024 * 1024 + 1))).status, 400, 'over 2 MB');
  assert.equal((await call('ann', 'POST', `drawings/${ids.standalone}/files`, { key: 'bad', mime: 'image/png', dataBase64: '***' })).status, 400);
  const got = await fetch(`${baseUrl}/api/drawings/${ids.standalone}/files/k1`, { headers: { Authorization: `Bearer ${token(ids.ed)}` } });
  assert.equal(got.status, 200);
  assert.equal(got.headers.get('content-type'), 'image/png');
  assert.equal(got.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(Buffer.from(await got.arrayBuffer()).compare(Buffer.alloc(100, 1)), 0, 'byte for byte');
  assert.equal((await fetch(`${baseUrl}/api/drawings/${ids.standalone}/files/k1`, { headers: { Authorization: `Bearer ${token(ids.bob)}` } })).status, 403);
  assert.equal((await fetch(`${baseUrl}/api/drawings/${ids.standalone}/files/none`, { headers: { Authorization: `Bearer ${token(ids.ann)}` } })).status, 404);
  const listed = await call('ann', 'GET', `drawings/${ids.standalone}`);
  assert.deepEqual(listed.json.files, [{ key: 'k1', mime: 'image/png' }]);
  const nearly = 2 * 1024 * 1024 - 10;
  for (let i = 0; i < 10; i += 1) assert.equal((await call('ann', 'POST', `drawings/${ids.standalone}/files`, file(`fill${i}`, nearly))).status, 201, `fill ${i}`);
  assert.equal((await call('ann', 'POST', `drawings/${ids.standalone}/files`, file('over', 1000))).status, 400, 'one more picture goes over 20 MB in total');
});

test('a drawing can be created with its shapes and images already in it (one made offline), and the limits apply', async (t) => {
  if (skip(t)) return;
  const made = await create('bob', { title: 'Made offline', scene: { elements: [shape('a'), shape('b', 3, 7)], appState: { viewBackgroundColor: '#eee' } }, files: [{ key: 'pic', mime: 'image/png', dataBase64: png(50) }] });
  assert.equal(made.status, 201, JSON.stringify(made.json));
  const got = (await call('bob', 'GET', `drawings/${made.json.drawing.id}`)).json;
  assert.equal(got.scene.elements.length, 2);
  assert.equal(got.scene.appState.viewBackgroundColor, '#eee');
  assert.deepEqual(got.files, [{ key: 'pic', mime: 'image/png' }]);
  assert.equal((await create('bob', { title: 'bad', scene: { elements: [{ id: 'x' }] } })).status, 400);
  assert.equal((await create('bob', { title: 'many', scene: { elements: Array.from({ length: 20001 }, (_, i) => shape(`s${i}`)) } })).status, 400);
  assert.equal((await create('bob', { title: 'badfile', files: [{ key: 'p', mime: 'text/plain', dataBase64: png(5) }] })).status, 400);
  assert.equal((await admin.query("SELECT 1 FROM drawings WHERE title IN ('bad', 'many', 'badfile')")).rows.length, 0, 'a refused create leaves nothing behind');
});

test('sharing into a channel or topic makes an independent copy with its own card; the target must allow posting', async (t) => {
  if (skip(t)) return;
  const source = (await create('ann', { title: 'Original', scene: { elements: [shape('z')] }, files: [{ key: 'img', mime: 'image/png', dataBase64: png(20) }] })).json.drawing.id;
  assert.equal((await call('bob', 'POST', `drawings/${source}/share`, { channelId: ids.chan })).status, 403, 'a stranger cannot share it');
  const copy = await call('ann', 'POST', `drawings/${source}/share`, { channelId: ids.chan });
  assert.equal(copy.status, 201, JSON.stringify(copy.json));
  assert.notEqual(copy.json.drawing.id, source);
  assert.equal(copy.json.drawing.kind, 'channel');
  assert.equal((await admin.query('SELECT kind FROM messages WHERE id = $1', [copy.json.message.id])).rows[0].kind, 'drawing');
  const copyBody = (await call('bob', 'GET', `drawings/${copy.json.drawing.id}`)).json;
  assert.equal(copyBody.scene.elements[0].id, 'z');
  assert.deepEqual(copyBody.files, [{ key: 'img', mime: 'image/png' }]);
  await call('bob', 'PATCH', `drawings/${copy.json.drawing.id}`, { title: 'Changed copy' });
  assert.equal((await call('ann', 'GET', `drawings/${source}`)).json.drawing.title, 'Original', 'the original is untouched');
  assert.equal((await call('ann', 'POST', `drawings/${source}/share`, { channelId: ids.chan2 })).status, 403, 'ann is not in that channel');
  const toTopic = await call('ann', 'POST', `drawings/${source}/share`, { channelId: ids.forum, topicId: ids.topic });
  assert.equal(toTopic.status, 201);
  assert.equal(toTopic.json.drawing.topicId, ids.topic);
  assert.equal((await call('ann', 'POST', `drawings/${source}/share`, { channelId: ids.forum, topicId: ids.lockedTopic })).status, 409);
  assert.equal((await call('ann', 'POST', `drawings/${source}/share`, {})).status, 400);
});

test('deleting: the owner any time, a channel or forum moderator for others (audited), nobody else; the card becomes "Drawing removed"', async (t) => {
  if (skip(t)) return;
  assert.equal((await call('cara', 'DELETE', `drawings/${ids.channelDrawing}`)).status, 403, 'an outsider');
  assert.equal((await call('bob', 'DELETE', `drawings/${ids.channelDrawing}`)).status, 403, 'a member who did not make it');
  const cardId = (await admin.query('SELECT message_id FROM drawings WHERE id = $1', [ids.channelDrawing])).rows[0].message_id;
  const before = emitted.length;
  assert.equal((await call('mod', 'DELETE', `drawings/${ids.channelDrawing}`)).status, 200, 'a channel moderator');
  assert.equal((await admin.query('SELECT 1 FROM drawings WHERE id = $1', [ids.channelDrawing])).rows.length, 0);
  assert.equal((await admin.query('SELECT content FROM messages WHERE id = $1', [cardId])).rows[0].content, 'Drawing removed');
  assert.ok(emitted.slice(before).some((e) => e.event === 'message_updated' && e.payload.messageId === cardId && e.payload.drawingRemoved === true));
  const audit = (await admin.query("SELECT actor_id, details FROM moderation_audit_log WHERE channel_id = $1 AND action = 'drawing_deleted'", [ids.chan])).rows;
  assert.equal(audit.length, 1);
  assert.equal(audit[0].actor_id, ids.mod);
  const history = await call('bob', 'GET', `messages/${ids.chan}`);
  const removed = history.json.messages.find((m) => m.id === cardId);
  assert.equal(removed.content, 'Drawing removed');
  assert.equal(removed.drawing, undefined);
  assert.equal((await call('head', 'DELETE', `drawings/${ids.topicDrawing}`)).status, 200, 'the department head moderates the forum');
  assert.equal((await call('ann', 'DELETE', `drawings/${ids.standalone}`)).status, 200, 'the owner of a standalone drawing');
  assert.equal((await call('ann', 'DELETE', `drawings/${ids.standalone}`)).status, 404);
  const own = (await create('ann', { title: 'Mine to delete', channelId: ids.chan })).json.drawing.id;
  assert.equal((await call('ann', 'DELETE', `drawings/${own}`)).status, 200, 'its creator');
  assert.equal((await admin.query("SELECT 1 FROM moderation_audit_log WHERE action = 'drawing_deleted' AND details->>'drawingId' = $1", [String(own)])).rows.length, 0, 'the owner deleting their own is not a moderation action');
});

// ---------------------------------------------------------------------------------------- the picture shown on a drawing's card
const pngBytes = (size) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(Math.max(0, size - 8), 7)]);

test('a card preview: an editor saves a small PNG, everyone who can open the drawing sees the same bytes, and the card knows its version', async (t) => {
  if (skip(t)) return;
  const made = await create('ann', { title: 'Rack layout', channelId: ids.chan });
  const id = made.json.drawing.id;
  assert.equal(made.json.drawing.previewVersion, null, 'a new drawing has no preview');
  assert.equal((await call('bob', 'GET', `drawings/${id}/preview`)).status, 404);
  const saved = await call('ann', 'PUT', `drawings/${id}/preview`, { dataBase64: pngBytes(2000).toString('base64') });
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  assert.equal(typeof saved.json.previewVersion, 'number');
  const response = await fetch(`${baseUrl}/api/drawings/${id}/preview`, { headers: { Authorization: `Bearer ${token(ids.bob)}` } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/png');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), pngBytes(2000));
  assert.equal((await call('bob', 'GET', `drawings/${id}`)).json.drawing.previewVersion, saved.json.previewVersion);
  const history = (await call('bob', 'GET', `messages/${ids.chan}`)).json.messages.find((m) => m.drawing && m.drawing.id === id);
  assert.equal(history.drawing.previewVersion, saved.json.previewVersion, 'the card in the channel history carries it');
  const newer = await call('ann', 'PUT', `drawings/${id}/preview`, { dataBase64: pngBytes(3000).toString('base64') });
  assert.ok(newer.json.previewVersion >= saved.json.previewVersion);
});

test('a card preview: viewers and outsiders cannot change or read it, and anything that is not a small PNG is refused', async (t) => {
  if (skip(t)) return;
  const own = (await create('ann', { title: 'Private sketch' })).json.drawing.id;
  await call('ann', 'PUT', `drawings/${own}/members/${ids.bob}`, { role: 'viewer' });
  const body = { dataBase64: pngBytes(500).toString('base64') };
  assert.equal((await call('bob', 'PUT', `drawings/${own}/preview`, body)).status, 403, 'a viewer');
  assert.equal((await call('cara', 'PUT', `drawings/${own}/preview`, body)).status, 403, 'an outsider');
  assert.equal((await call('ann', 'PUT', `drawings/${own}/preview`, body)).status, 200);
  assert.equal((await call('bob', 'GET', `drawings/${own}/preview`)).status, 200, 'a viewer may look');
  assert.equal((await call('cara', 'GET', `drawings/${own}/preview`)).status, 403, 'an outsider may not');
  assert.equal((await call('ann', 'PUT', `drawings/${own}/preview`, { dataBase64: Buffer.from('<svg onload=alert(1)>').toString('base64') })).status, 400, 'not a PNG');
  assert.equal((await call('ann', 'PUT', `drawings/${own}/preview`, { dataBase64: pngBytes(300 * 1024 + 1).toString('base64') })).status, 400, 'too large');
  assert.equal((await call('ann', 'PUT', `drawings/${own}/preview`, {})).status, 400, 'nothing sent');
  assert.equal((await call('ann', 'PUT', `drawings/${own}/preview`, { dataBase64: 'not base64 !!' })).status, 400);
});
