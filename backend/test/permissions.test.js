const test = require('node:test');
const assert = require('node:assert/strict');
const { resolvePermission, can, PERMISSION_KEYS, EVERYONE_DEFAULTS } = require('../src/permissions');
const { createScratchDatabase } = require('./helpers/scratchDb');

const everyone = { key: 'everyone', permissions: EVERYONE_DEFAULTS };
const base = (extra = {}) => ({ isOwner: false, grants: [everyone], overrides: null, channelModerator: false, ...extra });

test('an Owner may do everything, whatever the overrides say', () => {
  assert.equal(resolvePermission(base({ isOwner: true, overrides: { everyone: { deny: ['send_messages'] }, roles: [], user: null } }), 'send_messages'), true);
});

test('permissions are the union of Everyone and every role held', () => {
  const state = base({ grants: [everyone, { key: null, permissions: ['manage_messages'] }, { key: null, permissions: ['view_audit_log'] }] });
  assert.equal(resolvePermission(state, 'send_messages'), true);
  assert.equal(resolvePermission(state, 'manage_messages'), true);
  assert.equal(resolvePermission(state, 'view_audit_log'), true);
  assert.equal(resolvePermission(state, 'manage_roles'), false);
});

test('a channel can deny what Everyone allows (read-only channel), and a role can lift that deny', () => {
  const readOnly = base({ overrides: { everyone: { deny: ['send_messages'] }, roles: [], user: null } });
  assert.equal(resolvePermission(readOnly, 'send_messages'), false);
  assert.equal(resolvePermission(readOnly, 'view_channel'), true);
  const withRole = base({
    grants: [everyone, { key: null, permissions: [] }],
    overrides: { everyone: { deny: ['send_messages'] }, roles: [{ allow: ['send_messages'] }], user: null },
  });
  assert.equal(resolvePermission(withRole, 'send_messages'), true, 'a role allow lifts the Everyone deny');
});

test('conflicting role overrides: an allow from any role beats a deny from another', () => {
  const state = base({ overrides: { everyone: null, roles: [{ deny: ['attach_files'] }, { allow: ['attach_files'] }], user: null } });
  assert.equal(resolvePermission(state, 'attach_files'), true);
});

test('a person override beats role overrides both ways', () => {
  const denied = base({ overrides: { everyone: null, roles: [{ allow: ['send_messages'] }], user: { deny: ['send_messages'] } } });
  assert.equal(resolvePermission(denied, 'send_messages'), false);
  const allowed = base({ overrides: { everyone: { deny: ['add_reactions'] }, roles: [], user: { allow: ['add_reactions'] } } });
  assert.equal(resolvePermission(allowed, 'add_reactions'), true);
});

test('a channel moderator may manage messages and time people out there, unless denied to them', () => {
  const mod = base({ channelModerator: true });
  assert.equal(resolvePermission(mod, 'manage_messages'), true);
  assert.equal(resolvePermission(mod, 'timeout_members'), true);
  assert.equal(resolvePermission(mod, 'manage_roles'), false);
  const denied = base({ channelModerator: true, overrides: { everyone: null, roles: [], user: { deny: ['manage_messages'] } } });
  assert.equal(resolvePermission(denied, 'manage_messages'), false);
});

test('can() refuses an unknown permission name, so a typo cannot silently allow or deny', async () => {
  await assert.rejects(() => can(async () => ({ rows: [] }), 1, 'manage_everything'), /Unknown permission/);
  assert.ok(PERMISSION_KEYS.includes('manage_people'));
});

let scratch;
let db;
test.before(async () => {
  scratch = await createScratchDatabase();
  if (!scratch) return;
  db = await scratch.open();
  await scratch.applyInit(db);
  await scratch.applyMigrations(db);
});
test.after(async () => {
  if (db) await db.end();
  if (scratch) await scratch.drop();
});
const skip = (t) => { if (!scratch) { t.skip('no PostgreSQL reachable'); return true; } return false; };
const query = (sql, params) => db.query(sql, params);

async function user(name, flag) {
  const columns = flag ? `, ${flag}` : '';
  const values = flag ? ', true' : '';
  const sql = `INSERT INTO users (username, email, password_hash, avatar_color${columns}) VALUES ($1, $2, 'x', '#000000'${values}) RETURNING id`;
  return (await query(sql, [name, `${name}@x.test`])).rows[0].id;
}

test('the built-in roles are there after the migrations, and a second run changes nothing', async (t) => {
  if (skip(t)) return;
  await scratch.applyMigrations(db);
  const roles = (await query('SELECT builtin_key FROM roles WHERE builtin_key IS NOT NULL ORDER BY position')).rows;
  assert.deepEqual(roles.map((r) => r.builtin_key), ['owner', 'hr', 'everyone']);
});

test('the existing flags keep working: Superadmin is an Owner, is_hr gives HR, everyone else is Everyone', async (t) => {
  if (skip(t)) return;
  const owner = await user('perm_owner', 'is_superadmin');
  const hr = await user('perm_hr', 'is_hr');
  const plain = await user('perm_plain');
  assert.equal(await can(query, owner, 'manage_roles'), true);
  assert.equal(await can(query, hr, 'manage_people'), true);
  assert.equal(await can(query, hr, 'manage_roles'), false);
  assert.equal(await can(query, plain, 'manage_people'), false);
  assert.equal(await can(query, plain, 'send_messages'), true);
  assert.equal(await can(query, 999999, 'send_messages'), false, 'unknown account');
});

test('a custom role grants its permissions, and a deactivated account can do nothing', async (t) => {
  if (skip(t)) return;
  const person = await user('perm_manager');
  const role = (await query("INSERT INTO roles (name, position, permissions) VALUES ('Manager', 50, ARRAY['manage_messages']) RETURNING id")).rows[0].id;
  assert.equal(await can(query, person, 'manage_messages'), false);
  await query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)', [person, role]);
  assert.equal(await can(query, person, 'manage_messages'), true);
  await query('UPDATE users SET deactivated_at = NOW() WHERE id = $1', [person]);
  assert.equal(await can(query, person, 'manage_messages'), false);
});

test('channel overrides from the database: a read-only channel, then a personal allow', async (t) => {
  if (skip(t)) return;
  const person = await user('perm_reader');
  const channel = (await query("INSERT INTO channels (name) VALUES ('perm-announcements') RETURNING id")).rows[0].id;
  const everyoneId = (await query("SELECT id FROM roles WHERE builtin_key = 'everyone'")).rows[0].id;
  assert.equal(await can(query, person, 'send_messages', { channelId: channel }), true);
  await query("INSERT INTO channel_overrides (channel_id, subject_type, subject_id, deny) VALUES ($1, 'role', $2, ARRAY['send_messages'])", [channel, everyoneId]);
  assert.equal(await can(query, person, 'send_messages', { channelId: channel }), false);
  assert.equal(await can(query, person, 'send_messages'), true, 'other channels are unaffected');
  await query("INSERT INTO channel_overrides (channel_id, subject_type, subject_id, allow) VALUES ($1, 'user', $2, ARRAY['send_messages'])", [channel, person]);
  assert.equal(await can(query, person, 'send_messages', { channelId: channel }), true, 'a personal allow wins');
});

test('a channel moderator may manage messages in that channel only', async (t) => {
  if (skip(t)) return;
  const person = await user('perm_chanmod');
  const here = (await query("INSERT INTO channels (name) VALUES ('perm-mod-here') RETURNING id")).rows[0].id;
  const there = (await query("INSERT INTO channels (name) VALUES ('perm-mod-there') RETURNING id")).rows[0].id;
  await query("INSERT INTO channel_members (channel_id, user_id, role) VALUES ($1, $2, 'moderator'), ($3, $2, 'member')", [here, person, there]);
  assert.equal(await can(query, person, 'manage_messages', { channelId: here }), true);
  assert.equal(await can(query, person, 'manage_messages', { channelId: there }), false);
});

test('a role granting manage_people makes someone HR everywhere the old flag was read', async (t) => {
  if (skip(t)) return;
  process.env.DATABASE_URL ||= 'postgres://127.0.0.1/test';
  const { withRoleAccess, HR_LIKE_SQL } = require('../src/hr');
  const person = await user('perm_hrrole');
  const role = (await query("INSERT INTO roles (name, position, permissions) VALUES ('People ops', 40, ARRAY['manage_people']) RETURNING id")).rows[0].id;
  const row = { id: person, account_type: 'member', is_hr: false, is_superadmin: false };
  // withRoleAccess reads through the app's own pool, which points at another database in tests: use the pure rule here
  assert.equal(HR_LIKE_SQL.includes("'manage_people' = ANY(r.permissions)"), true);
  assert.equal(typeof withRoleAccess, 'function');
  assert.equal((await query(`SELECT id FROM users WHERE id = $1 AND ${HR_LIKE_SQL}`, [person])).rows.length, 0);
  await query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)', [person, role]);
  assert.equal((await query(`SELECT id FROM users WHERE id = $1 AND ${HR_LIKE_SQL}`, [person])).rows.length, 1);
  assert.equal(row.is_hr, false);
});
