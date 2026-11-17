const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const load = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
test('canvas activity includes employee full name with username fallback', () => {
  const live = load('src/canvasMentions.js');
  const feed = load('src/routes/activity.js');
  const ui = fs.readFileSync(path.join(__dirname, '../../frontend/src/features/activity.js'), 'utf8');
  assert.match(live, /actorDisplayName: actor \?/);
  assert.match(live, /actor\.username/);
  assert.match(feed, /AS actor_display_name/);
  assert.match(feed, /actorDisplayName: row\.actor_display_name/);
  assert.match(ui, /item\.actorDisplayName \|\| item\.actorUsername/);
});
