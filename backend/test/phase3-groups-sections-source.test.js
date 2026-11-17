const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const read = (file) => fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');
test('superadmin groups inventory uses authenticated admin API and metadata only', () => {
 const api=read('src/routes/admin.js');
 assert.match(api, /router\.get\('\/groups'/);
 assert.match(api, /await requireSuperadmin\(req\)/);
 assert.match(api, /COUNT\(cm\.user_id\)/);
 const ui=fs.readFileSync(path.resolve(__dirname, '../../frontend/src/features/admin.js'),'utf8');
 assert.match(ui, /adminApi\('\/api\/admin\/groups'\)/);
 assert.match(ui, /id="admin-workspace-groups"/);
 assert.match(ui, /'admin-workspace-groups': 'groups'/);
});
test('shared ordinary channel section projection excludes personal and team channels', () => {
 const server=read('src/routes/settings.js');
 assert.match(server, /c\.is_personal = FALSE AND c\.team_section_id IS NULL/);
 assert.match(server, /inheritedSections/);
 const ui=fs.readFileSync(path.resolve(__dirname,'../../frontend/src/features/workspace.js'),'utf8');
 assert.match(ui, /layout\.inheritedSections/);
 assert.match(ui, /\.map\(\(id\) => state\.channels\.find/);
});
