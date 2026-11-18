// The Excalidraw bundle (src/vendor/drawing-editor.js and src/vendor/drawing-assets/) must be self-contained:
// a size we accept, our own fonts, and no address of a third party that the editor would call at runtime.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { findOutsideAddresses, filesIn } = require('../scripts/drawing-hosts');

const vendor = path.join(__dirname, '..', 'src', 'vendor');
const bundle = path.join(vendor, 'drawing-editor.js');
const assets = path.join(vendor, 'drawing-assets');

// Measured in the spike (2026-11-18): the script is 8.1 MB and the fonts and styles 14 MB. The budget catches accidental growth.
const BUNDLE_BUDGET_BYTES = 12 * 1024 * 1024;

test('the bundle exists and is within the size budget', () => {
  assert.ok(fs.existsSync(bundle), 'run `npm run drawing` in frontend/');
  assert.ok(fs.statSync(bundle).size < BUNDLE_BUDGET_BYTES, `bundle is ${fs.statSync(bundle).size} bytes`);
});

test('the editor ships its own fonts', () => {
  const fonts = filesIn(assets).filter((file) => /\.(woff2?|ttf)$/i.test(file));
  assert.ok(fonts.length > 0, 'no font files in src/vendor/drawing-assets');
});

test('no third-party address appears that has not been reviewed (see scripts/drawing-hosts.js)', () => {
  assert.deepEqual(findOutsideAddresses(vendor).slice(0, 20), []);
});

test('the build banner points the editor at its own assets', () => {
  assert.match(fs.readFileSync(bundle, 'utf8').slice(0, 400), /EXCALIDRAW_ASSET_PATH/);
});

test('the scan is not vacuous: it reports an unreviewed host and ignores a reviewed one', () => {
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drawing-scan-'));
  fs.mkdirSync(path.join(dir, 'drawing-assets'));
  fs.writeFileSync(path.join(dir, 'drawing-editor.js'), 'a("http://www.w3.org/2000/svg"); fetch("https://tracker.example.test/ping?x=1");');
  const found = findOutsideAddresses(dir);
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(found.length, 1);
  assert.match(found[0], /tracker.example.test/);
});
