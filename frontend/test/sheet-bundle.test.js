// The Sheets grid bundle (src/vendor/sheet-grid.js and src/vendor/sheet-assets/) must be self-contained: a size we accept, and no
// address of a third party that the grid would call at runtime.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { findOutsideAddresses } = require('../scripts/sheet-hosts');

const vendor = path.join(__dirname, '..', 'src', 'vendor');

test('the bundle and its stylesheets exist and are within the size budget', () => {
  const bundle = path.join(vendor, 'sheet-grid.js');
  assert.ok(fs.existsSync(bundle), 'run `npm run sheets` in frontend/');
  assert.ok(fs.statSync(bundle).size < 1024 * 1024, `bundle is ${fs.statSync(bundle).size} bytes`);
  for (const name of ['jspreadsheet.css', 'jsuites.css']) assert.ok(fs.existsSync(path.join(vendor, 'sheet-assets', name)), name);
});

test('no third-party address appears that has not been reviewed (see scripts/sheet-hosts.js)', () => {
  assert.deepEqual(findOutsideAddresses(vendor), []);
});

test('the grid exposes the handle the screen uses', () => {
  const text = fs.readFileSync(path.join(vendor, 'sheet-grid.js'), 'utf8');
  assert.match(text, /ITASheet/);
  assert.match(text, /getTabs/);
  assert.match(text, /setTabs/);
});
