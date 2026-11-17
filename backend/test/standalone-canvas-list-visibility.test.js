const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const canvas = fs.readFileSync(path.join(__dirname, '../src/routes/canvas.js'), 'utf8');
const { channelVisibleToUser } = require('../src/channelVisibilitySql');

test('standalone canvas discovery uses shared multi-grant visibility policy', () => {
  assert.match(canvas, /channelVisibleToUser\('g\.channel_id'\)/);
  const sql = channelVisibleToUser('g.channel_id');
  assert.match(sql, /channel_bans/);
  assert.match(sql, /channel_department_grants/);
  assert.match(sql, /user_departments/);
  assert.match(sql, /channel_direct_grants/);
  assert.match(sql, /dg.expires_at > NOW\(\)/);
  assert.match(sql, /viewer.deactivated_at IS NULL/);
});

test('standalone canvas listing retains direct ownership and personal collaborator grants', () => {
  assert.match(canvas, /COALESCE\(c.owner_id, c.created_by\) = \$1/);
  assert.match(canvas, /canvas_collaborators WHERE canvas_id = c.id AND user_id = \$1/);
  assert.match(canvas, /const myRole = await getStandaloneCanvasRole\(query, userId, row\)/);
  assert.match(canvas, /if \(myRole\) canvases.push\(mapCanvas\(row, \{ myRole \}\)\)/);
});
