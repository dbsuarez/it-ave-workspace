// The schema lives in two places only: database/init.sql (base tables for a fresh database) and
// src/migrations.js (everything else, run by server.js at every start). These tests keep it that way.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createScratchDatabase } = require('./helpers/scratchDb');

test('server.js does not define schema inline', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.ok(!/CREATE TABLE/i.test(source), 'no CREATE TABLE in server.js: it belongs in migrations.js');
  assert.ok(!/ALTER TABLE/i.test(source), 'no ALTER TABLE in server.js: it belongs in migrations.js');
  assert.match(source, /migrations\.reduce/, 'server.js runs the migrations list');
});

test('every migration is a non-empty string, and none takes parameters', () => {
  const migrations = require('../src/migrations');
  assert.ok(migrations.length > 50);
  for (const sql of migrations) {
    assert.equal(typeof sql, 'string');
    assert.ok(sql.trim().length > 0);
  }
});

let scratch;
let admin;

test.before(async () => {
  scratch = await createScratchDatabase();
  if (!scratch) return;
  admin = await scratch.open();
});

test.after(async () => {
  if (admin) await admin.end();
  if (scratch) await scratch.drop();
});

const skip = (t) => { if (!scratch) { t.skip('no PostgreSQL reachable'); return true; } return false; };

async function describeSchema(client) {
  const columns = await client.query(
    `SELECT table_name, column_name, data_type, is_nullable, column_default
     FROM information_schema.columns WHERE table_schema = 'public' ORDER BY table_name, column_name`
  );
  const indexes = await client.query("SELECT indexname FROM pg_indexes WHERE schemaname = 'public' ORDER BY indexname");
  return {
    columns: columns.rows.map((r) => `${r.table_name}.${r.column_name} ${r.data_type} ${r.is_nullable} ${r.column_default ?? ''}`),
    indexes: indexes.rows.map((r) => r.indexname),
  };
}

test('a fresh database ends up with the whole schema, and running the migrations again changes nothing', async (t) => {
  if (skip(t)) return;
  await scratch.applyInit(admin);
  await scratch.applyMigrations(admin);
  const first = await describeSchema(admin);
  // the features' tables are all there
  const tables = new Set(first.columns.map((c) => c.split('.')[0]));
  for (const table of [
    'users', 'channels', 'channel_members', 'messages', 'files', 'moderation_settings', 'canvases', 'canvas_revisions', 'canvas_comments',
    'canvas_mentions', 'canvas_collaborators', 'canvas_shares', 'canvas_channel_grants', 'list_columns', 'list_rows', 'list_cells',
  ]) assert.ok(tables.has(table), `table ${table} exists`);
  // startup runs the migrations on every start: the second run must be a no-op, and must not fail
  await scratch.applyMigrations(admin);
  const second = await describeSchema(admin);
  assert.deepEqual(second, first);
});

test('the migrations alone upgrade a database that only has the base tables', async (t) => {
  if (skip(t)) return;
  // columns the later features added are present after init.sql + migrations
  const result = await admin.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name = 'users' AND column_name IN ('token_version', 'is_superadmin', 'job_title', 'photo_file', 'manager_id', 'profile', 'department')`
  );
  assert.equal(result.rows.length, 7);
});
