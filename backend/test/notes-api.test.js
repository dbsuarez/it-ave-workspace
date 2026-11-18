// Notes (Keep style): fields, pin, archive, trash and its purge, ownership and limits, against a real PostgreSQL (scratch database).
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');
const { createScratchDatabase } = require('./helpers/scratchDb');

let scratch; let admin; let server; let baseUrl; let pool; let config;
const ids = {};

test.before(async () => {
  scratch = await createScratchDatabase();
  if (!scratch) return;
  admin = await scratch.open();
  await scratch.applyInit(admin);
  await scratch.applyMigrations(admin);
  process.env.DATABASE_URL = scratch.url;
  process.env.JWT_SECRET = 'notes-secret';
  config = require('../src/config');
  pool = require('../src/db').pool;
  const user = async (name) => (await admin.query("INSERT INTO users (username, email, password_hash) VALUES ($1, $2, 'x') RETURNING id", [name, `${name}@x.test`])).rows[0].id;
  ids.ann = await user('nt-ann'); ids.bob = await user('nt-bob');
  const app = express();
  app.use('/api/notes', require('../src/routes/notes')); // parses its own bodies, as in server.js
  app.use(express.json());
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
const call = async (user, method, path, body) => {
  const res = await fetch(`${baseUrl}/api/notes${path}`, {
    method, headers: { Authorization: `Bearer ${jwt.sign({ userId: ids[user], username: 'u', tokenVersion: 0 }, config.JWT_SECRET)}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
};
const list = async (user) => (await call(user, 'GET', '')).json;

test('a new note starts plain: no colour, not pinned, a text note, nothing attached', async (t) => {
  if (skip(t)) return;
  assert.deepEqual(await list('ann'), { notes: [], labels: [] });
  const made = await call('ann', 'POST', '', { title: 'Shopping', content: 'milk' });
  assert.equal(made.status, 201);
  const note = made.json.note;
  assert.deepEqual(
    { title: note.title, content: note.content, kind: note.kind, items: note.items, color: note.color, pinned: note.pinned, archived: note.archived, trashed: note.trashed, labelIds: note.labelIds, images: note.images, reminder: note.reminder },
    { title: 'Shopping', content: 'milk', kind: 'text', items: [], color: 'default', pinned: false, archived: false, trashed: false, labelIds: [], images: [], reminder: null });
  ids.note = note.id;
  assert.equal((await call('ann', 'POST', '', { content: 'no title' })).json.note.title, '', 'a note may have no title, like in Keep');
});

test('a note can be created with every field, and bad values are refused', async (t) => {
  if (skip(t)) return;
  const items = [{ text: 'eggs', done: false }, { id: 'keep-me', text: 'bread', done: true }];
  const made = await call('ann', 'POST', '', { title: 'List', kind: 'checklist', items, color: 'yellow', pinned: true });
  assert.equal(made.status, 201, JSON.stringify(made.json));
  assert.equal(made.json.note.color, 'yellow');
  assert.equal(made.json.note.pinned, true);
  assert.equal(made.json.note.items.length, 2);
  assert.ok(made.json.note.items.every((item) => typeof item.id === 'string' && item.id), 'every item has an id');
  assert.equal(made.json.note.items[1].id, 'keep-me');
  assert.deepEqual(made.json.note.items.map((item) => [item.text, item.done]), [['eggs', false], ['bread', true]]);
  for (const bad of [{ color: 'neon' }, { kind: 'drawing' }, { items: 'x' }, { items: [{ text: 5 }] }, { items: Array.from({ length: 201 }, () => ({ text: 'a' })) },
    { items: [{ text: 'x'.repeat(501) }] }, { content: 'x'.repeat(100001) }, { title: 7 }, { pinned: 'yes' }]) {
    assert.equal((await call('ann', 'POST', '', bad)).status, 400, JSON.stringify(bad).slice(0, 40));
  }
  assert.equal((await call('ann', 'POST', '', { title: 'x'.repeat(250) })).json.note.title.length, 200, 'a long title is cut, as before');
});

test('changing a note changes only what is sent', async (t) => {
  if (skip(t)) return;
  const before = (await list('ann')).notes.find((n) => n.id === ids.note);
  const put = await call('ann', 'PUT', `/${ids.note}`, { color: 'blue' });
  assert.equal(put.status, 200);
  assert.equal(put.json.note.color, 'blue');
  assert.equal(put.json.note.title, 'Shopping');
  assert.equal(put.json.note.content, 'milk');
  assert.ok(new Date(put.json.note.updatedAt) >= new Date(before.updatedAt));
  assert.equal((await call('ann', 'PUT', `/${ids.note}`, { content: '' })).json.note.content, '', 'text can be emptied');
  assert.equal((await call('ann', 'PUT', `/${ids.note}`, { color: 'neon' })).status, 400);
  assert.equal((await call('ann', 'PUT', `/${ids.note}`, {})).status, 200, 'nothing to change is fine');
  assert.equal((await call('ann', 'PUT', '/999999', { title: 'x' })).status, 404);
});

test('pinning, archiving and trashing follow Keep: archive and trash unpin, and pinning brings a note back from the archive', async (t) => {
  if (skip(t)) return;
  const id = ids.note;
  assert.equal((await call('ann', 'PUT', `/${id}`, { pinned: true })).json.note.pinned, true);
  let note = (await call('ann', 'PUT', `/${id}`, { archived: true })).json.note;
  assert.deepEqual([note.archived, note.pinned], [true, false]);
  note = (await call('ann', 'PUT', `/${id}`, { pinned: true })).json.note;
  assert.deepEqual([note.archived, note.pinned], [false, true], 'pinning un-archives');
  note = (await call('ann', 'PUT', `/${id}`, { trashed: true })).json.note;
  assert.deepEqual([note.trashed, note.pinned, note.archived], [true, false, false]);
  note = (await call('ann', 'PUT', `/${id}`, { trashed: false })).json.note;
  assert.equal(note.trashed, false, 'restored');
  assert.equal((await call('ann', 'PUT', `/${id}`, { archived: false })).json.note.archived, false);
});

test('notes belong to their owner: nobody else can see, change, trash or delete them', async (t) => {
  if (skip(t)) return;
  assert.equal((await list('bob')).notes.length, 0);
  assert.equal((await call('bob', 'PUT', `/${ids.note}`, { title: 'mine now' })).status, 404);
  assert.equal((await call('bob', 'DELETE', `/${ids.note}`)).status, 404);
  assert.equal((await list('ann')).notes.find((n) => n.id === ids.note).title, 'Shopping');
});

test('deleting forever removes the note, and emptying the trash removes only trashed notes of the caller', async (t) => {
  if (skip(t)) return;
  const a = (await call('ann', 'POST', '', { title: 'trash me' })).json.note.id;
  const b = (await call('ann', 'POST', '', { title: 'keep me' })).json.note.id;
  const c = (await call('bob', 'POST', '', { title: 'bobs trash' })).json.note.id;
  await call('ann', 'PUT', `/${a}`, { trashed: true });
  await call('bob', 'PUT', `/${c}`, { trashed: true });
  const emptied = await call('ann', 'POST', '/trash/empty');
  assert.equal(emptied.status, 200);
  assert.equal(emptied.json.removed, 1);
  const titles = (await list('ann')).notes.map((n) => n.title);
  assert.ok(!titles.includes('trash me') && titles.includes('keep me'));
  assert.equal((await list('bob')).notes.length, 1, 'bob still has his trashed note');
  assert.equal((await call('ann', 'DELETE', `/${b}`)).status, 200);
  assert.equal((await call('ann', 'DELETE', `/${b}`)).status, 404);
});

test('a note stays in the trash for 30 days, then it is removed when the list is loaded', async (t) => {
  if (skip(t)) return;
  const old = (await call('bob', 'POST', '', { title: 'old trash' })).json.note.id;
  const recent = (await call('bob', 'POST', '', { title: 'recent trash' })).json.note.id;
  await call('bob', 'PUT', `/${old}`, { trashed: true });
  await call('bob', 'PUT', `/${recent}`, { trashed: true });
  await admin.query("UPDATE notes SET deleted_at = NOW() - INTERVAL '31 days' WHERE id = $1", [old]);
  await admin.query("UPDATE notes SET deleted_at = NOW() - INTERVAL '29 days' WHERE id = $1", [recent]);
  const titles = (await list('bob')).notes.map((n) => n.title);
  assert.ok(!titles.includes('old trash'));
  assert.ok(titles.includes('recent trash'));
});

test('a person can keep at most 1000 notes', async (t) => {
  if (skip(t)) return;
  const have = (await admin.query('SELECT COUNT(*)::int AS n FROM notes WHERE user_id = $1 AND deleted_at IS NULL', [ids.ann])).rows[0].n;
  await admin.query("INSERT INTO notes (user_id, title) SELECT $1, 'bulk' FROM generate_series(1, $2)", [ids.ann, 1000 - have]);
  assert.equal((await call('ann', 'POST', '', { title: 'one too many' })).status, 400);
  await admin.query("DELETE FROM notes WHERE user_id = $1 AND title = 'bulk'", [ids.ann]);
  assert.equal((await call('ann', 'POST', '', { title: 'room again' })).status, 201);
});

test('the server also clears out old trash when it starts', () => {
  assert.match(require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'server.js'), 'utf8'), /purgeExpiredTrash/);
});

// ------------------------------------------------------------------------------------------------ labels, pictures, reminders
const pngB64 = (size) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(Math.max(0, size - 4), 5)]).toString('base64');
const fresh = async (user, extra = {}) => (await call(user, 'POST', '', { title: 'x', ...extra })).json.note;

test('labels: made, renamed and deleted by their owner; names are unique per person and limited', async (t) => {
  if (skip(t)) return;
  const made = await call('ann', 'POST', '/labels', { name: '  Work  ' });
  assert.equal(made.status, 201);
  assert.equal(made.json.label.name, 'Work');
  ids.work = made.json.label.id;
  assert.equal((await call('ann', 'POST', '/labels', { name: 'work' })).status, 409, 'same name, any case');
  assert.equal((await call('bob', 'POST', '/labels', { name: 'Work' })).status, 201, 'another person may use it');
  for (const bad of [{ name: '' }, { name: '   ' }, { name: 'x'.repeat(31) }, { name: 5 }, {}]) assert.equal((await call('ann', 'POST', '/labels', bad)).status, 400);
  assert.equal((await call('ann', 'PUT', `/labels/${ids.work}`, { name: 'Office' })).json.label.name, 'Office');
  const other = (await call('ann', 'POST', '/labels', { name: 'Home' })).json.label.id;
  assert.equal((await call('ann', 'PUT', `/labels/${other}`, { name: 'office' })).status, 409);
  assert.equal((await call('bob', 'PUT', `/labels/${ids.work}`, { name: 'Stolen' })).status, 404);
  assert.equal((await call('bob', 'DELETE', `/labels/${ids.work}`)).status, 404);
  assert.deepEqual((await list('ann')).labels.map((l) => l.name), ['Home', 'Office']);
  ids.home = other;
});

test('labels on notes: only your own labels can be put on a note; deleting a label keeps the notes', async (t) => {
  if (skip(t)) return;
  const note = await fresh('ann', { labelIds: [ids.work] });
  assert.deepEqual(note.labelIds, [ids.work]);
  const bobsLabel = (await list('bob')).labels[0].id;
  assert.equal((await call('ann', 'PUT', `/${note.id}`, { labelIds: [bobsLabel] })).status, 400, 'not yours');
  assert.equal((await call('ann', 'PUT', `/${note.id}`, { labelIds: [ids.work, ids.home] })).json.note.labelIds.length, 2);
  assert.deepEqual((await call('ann', 'PUT', `/${note.id}`, { labelIds: [] })).json.note.labelIds, []);
  await call('ann', 'PUT', `/${note.id}`, { labelIds: [ids.home] });
  assert.equal((await call('ann', 'DELETE', `/labels/${ids.home}`)).status, 200);
  const after = (await list('ann')).notes.find((n) => n.id === note.id);
  assert.ok(after, 'the note is still there');
  assert.deepEqual(after.labelIds, []);
});

test('at most 50 labels per person', async (t) => {
  if (skip(t)) return;
  const have = (await list('bob')).labels.length;
  await admin.query("INSERT INTO note_labels (user_id, name) SELECT $1, 'bulk' || g FROM generate_series(1, $2) g", [ids.bob, 50 - have]);
  assert.equal((await call('bob', 'POST', '/labels', { name: 'one more' })).status, 400);
});

test('pictures: the owner adds, reads and removes them; type, size and count are limited; nobody else sees them', async (t) => {
  if (skip(t)) return;
  const note = await fresh('ann');
  const added = await call('ann', 'POST', `/${note.id}/images`, { mime: 'image/png', dataBase64: pngB64(1500) });
  assert.equal(added.status, 201, JSON.stringify(added.json));
  const imageId = added.json.image.id;
  assert.equal((await list('ann')).notes.find((n) => n.id === note.id).images[0].id, imageId);
  const res = await fetch(`${baseUrl}/api/notes/${note.id}/images/${imageId}`, { headers: { Authorization: `Bearer ${jwt.sign({ userId: ids.ann, username: 'u', tokenVersion: 0 }, config.JWT_SECRET)}` } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(Buffer.from(await res.arrayBuffer()).length, 1500);
  assert.equal((await call('bob', 'POST', `/${note.id}/images`, { mime: 'image/png', dataBase64: pngB64(100) })).status, 404);
  assert.equal((await call('bob', 'GET', `/${note.id}/images/${imageId}`)).status, 404);
  assert.equal((await call('bob', 'DELETE', `/${note.id}/images/${imageId}`)).status, 404);
  assert.equal((await call('ann', 'POST', `/${note.id}/images`, { mime: 'image/svg+xml', dataBase64: pngB64(100) })).status, 400, 'no SVG');
  assert.equal((await call('ann', 'POST', `/${note.id}/images`, { mime: 'image/png', dataBase64: pngB64(2 * 1024 * 1024 + 10) })).status, 400, 'too big');
  assert.equal((await call('ann', 'POST', `/${note.id}/images`, { mime: 'image/png', dataBase64: 'not base64 !!' })).status, 400);
  assert.equal((await call('ann', 'DELETE', `/${note.id}/images/${imageId}`)).status, 200);
  assert.equal((await call('ann', 'GET', `/${note.id}/images/${imageId}`)).status, 404);
  for (let i = 0; i < 10; i += 1) assert.equal((await call('ann', 'POST', `/${note.id}/images`, { mime: 'image/jpeg', dataBase64: pngB64(50) })).status, 201);
  assert.equal((await call('ann', 'POST', `/${note.id}/images`, { mime: 'image/jpeg', dataBase64: pngB64(50) })).status, 400, 'ten per note');
});

test('a reminder on a note: set, replaced, cleared; the past is refused; it goes with the note', async (t) => {
  if (skip(t)) return;
  const note = await fresh('ann', { title: 'Call the bank' });
  const when = new Date(Date.now() + 3600 * 1000).toISOString();
  const set = await call('ann', 'PUT', `/${note.id}/reminder`, { remindAt: when });
  assert.equal(set.status, 200, JSON.stringify(set.json));
  assert.equal(new Date(set.json.note.reminder.remindAt).toISOString(), when);
  const row = (await admin.query('SELECT text, user_id, note_id FROM reminders WHERE note_id = $1', [note.id])).rows;
  assert.deepEqual([row.length, row[0].text, row[0].user_id], [1, 'Call the bank', ids.ann], 'it is an ordinary reminder, so the usual pop-up and Later list work');
  const later = new Date(Date.now() + 7200 * 1000).toISOString();
  await call('ann', 'PUT', `/${note.id}/reminder`, { remindAt: later });
  assert.equal((await admin.query('SELECT COUNT(*)::int AS n FROM reminders WHERE note_id = $1', [note.id])).rows[0].n, 1, 'replaced, not added');
  assert.equal((await call('ann', 'PUT', `/${note.id}/reminder`, { remindAt: new Date(Date.now() - 1000).toISOString() })).status, 400);
  assert.equal((await call('ann', 'PUT', `/${note.id}/reminder`, {})).status, 400);
  assert.equal((await call('bob', 'PUT', `/${note.id}/reminder`, { remindAt: when })).status, 404);
  assert.equal((await call('ann', 'DELETE', `/${note.id}/reminder`)).json.note.reminder, null);
  await call('ann', 'PUT', `/${note.id}/reminder`, { remindAt: when });
  await call('ann', 'DELETE', `/${note.id}`);
  assert.equal((await admin.query('SELECT COUNT(*)::int AS n FROM reminders WHERE note_id = $1', [note.id])).rows[0].n, 0);
});

test('a reminder that has gone off no longer shows on the note', async (t) => {
  if (skip(t)) return;
  const note = await fresh('ann');
  await call('ann', 'PUT', `/${note.id}/reminder`, { remindAt: new Date(Date.now() + 3600 * 1000).toISOString() });
  await admin.query('UPDATE reminders SET delivered_at = NOW() WHERE note_id = $1', [note.id]);
  assert.equal((await list('ann')).notes.find((n) => n.id === note.id).reminder, null);
});

test('the notes router is mounted before the general JSON parser, so pictures are not cut off at 100 KB', () => {
  const server = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'server.js'), 'utf8');
  assert.ok(server.indexOf("app.use('/api/notes'") > 0 && server.indexOf("app.use('/api/notes'") < server.indexOf('app.use(express.json())'));
});
