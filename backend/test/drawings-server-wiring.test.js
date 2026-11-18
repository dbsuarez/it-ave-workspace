// The drawings router is mounted before the general JSON parser (it needs a bigger limit), which is also before the middleware
// that gives every request `req.io`. Its routes use req.io, so the mount itself must attach it. The API tests inject io
// themselves and cannot see this, so the wiring is checked here.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

test('the drawings router is mounted with io attached, ahead of the general JSON parser', () => {
  const mount = server.split('\n').find((line) => line.includes("'/api/drawings'") && line.includes('app.use('));
  assert.ok(mount, 'the mount line exists');
  assert.match(mount, /req\.io\s*=\s*io/, 'the mount attaches io to the request');
  assert.ok(server.indexOf(mount) < server.indexOf('app.use(express.json())'), 'mounted before the general parser, so its own 16 MB limit applies');
});

test('the live hub is created once and registered for every connection, started, and saved on shutdown', () => {
  assert.match(server, /createDrawingHub\(\{ io,/);
  assert.match(server, /drawingHub\.register\(socket\)/);
  assert.match(server, /drawingHub\.start\(\)/);
  assert.match(server, /drawingHub\.shutdown\(\)/);
});
