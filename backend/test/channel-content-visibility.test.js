const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { channelVisibleToUser } = require('../src/channelVisibilitySql');
const route = name => fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', name), 'utf8');

test('content visibility predicate requires active users and rejects bans before all grants', () => {
  const sql = channelVisibleToUser('m.channel_id');
  assert.match(sql, /viewer\.deactivated_at IS NULL/);
  assert.match(sql, /NOT EXISTS\s*\(\s*SELECT 1 FROM channel_bans/);
  assert.match(sql, /channel_members WHERE user_id = \$1/);
  assert.match(sql, /JOIN user_departments ud ON ud.department_id = cdg.department_id/);
  assert.match(sql, /channel_direct_grants dg/);
  assert.match(sql, /dg.expires_at IS NULL OR dg.expires_at > NOW\(\)/);
});

test('files library and search share the same channel visibility predicate', () => {
  const files = route('files.js');
  // the search SQL lives in src/searchService.js (shared by GET /api/search and the /search command)
  const search = fs.readFileSync(path.join(__dirname, '..', 'src', 'searchService.js'), 'utf8');
  assert.match(files, /require\('\.\.\/channelVisibilitySql'\)/);
  assert.match(search, /require\('\.\/channelVisibilitySql'\)/);
  assert.match(route('search.js'), /require\('\.\.\/searchService'\)/, 'the route uses the shared service');
  for (const source of [files, search]) {
    assert.match(source, /channelVisibleToUser\('m.channel_id'\)/);
  }
  assert.doesNotMatch(files.slice(files.indexOf("router.get('/',"), files.indexOf("router.get('/:id/download'")), /m.channel_id IN \(SELECT channel_id FROM channel_members/);
});

test('channel visibility SQL never interpolates user-provided identifier values', () => {
  assert.equal(channelVisibleToUser('m.channel_id').includes('permitted_channel.id = m.channel_id'), true);
  assert.match(route('files.js'), /\[req.user.userId\]/);
});
