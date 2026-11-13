const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { isAllowedStoreKey, validateStoreWrite, isTrustedFrameUrl, validateExportRequest, exportFileName } = require('../ipc-policy');

test('only the keys the app uses may be stored', () => {
  for (const key of ['authToken', 'user', 'preferences:7', 'preferences:123456', 'lastChannel:7']) {
    assert.equal(isAllowedStoreKey(key), true, key);
  }
  for (const key of ['', 'serverUrl', 'preferences:', 'preferences:abc', 'preferences:1:2', '__proto__',
    'constructor', 'authToken ', 'AUTHTOKEN', 'lastChannel:', 'lastChannel:abc', 'a.b', null, undefined, 5, {}, ['user']]) {
    assert.equal(isAllowedStoreKey(key), false, String(key));
  }
});

test('writes are checked for shape and size', () => {
  assert.equal(validateStoreWrite('authToken', 'a.b.c'), null);
  assert.ok(validateStoreWrite('authToken', ''));
  assert.ok(validateStoreWrite('authToken', 'x'.repeat(5000)));
  assert.ok(validateStoreWrite('authToken', { token: 'x' }));

  assert.equal(validateStoreWrite('user', { id: 1, username: 'ann' }), null);
  assert.ok(validateStoreWrite('user', 'ann'));
  assert.ok(validateStoreWrite('user', null));
  assert.ok(validateStoreWrite('user', [1, 2]));
  assert.ok(validateStoreWrite('user', { blob: 'x'.repeat(9000) }));

  assert.equal(validateStoreWrite('preferences:4', { theme: 'dark', enterToSend: true }), null);
  assert.ok(validateStoreWrite('preferences:4', { blob: 'x'.repeat(5000) }));
  assert.equal(validateStoreWrite('lastChannel:4', 27), null);
  assert.ok(validateStoreWrite('lastChannel:4', 0));
  assert.ok(validateStoreWrite('lastChannel:4', '27'));
  assert.ok(validateStoreWrite('evil', 1));
});

test('circular values and non-plain objects are refused', () => {
  const circular = {};
  circular.self = circular;
  assert.ok(validateStoreWrite('user', circular));
  assert.ok(validateStoreWrite('user', new Map()));
  assert.ok(validateStoreWrite('user', Object.create({ inherited: true })), 'objects with a custom prototype are refused');
});

test('only pages loaded from the app src folder are trusted', () => {
  const appDir = path.join(__dirname, '..');
  const trusted = pathToFileURL(path.join(appDir, 'src', 'index.html')).href;
  assert.equal(isTrustedFrameUrl(trusted, appDir), true);
  assert.equal(isTrustedFrameUrl(pathToFileURL(path.join(appDir, 'src', 'features', 'a.html')).href, appDir), true);

  const untrusted = [
    pathToFileURL(path.join(appDir, 'main.js')).href,
    pathToFileURL(path.join(appDir, '..', 'other', 'src', 'index.html')).href,
    pathToFileURL(path.join(appDir, 'src-evil', 'index.html')).href,
    'file:///C:/Windows/System32/drivers/etc/hosts',
    'https://example.com/src/index.html',
    'http://127.0.0.1:3001/',
    'about:blank',
    'data:text/html,<script>1</script>',
    'not a url',
    '',
    undefined,
  ];
  for (const url of untrusted) assert.equal(isTrustedFrameUrl(url, appDir), false, String(url));
});

test('path traversal in a file URL does not escape the src folder', () => {
  const appDir = path.join(__dirname, '..');
  const base = pathToFileURL(path.join(appDir, 'src')).href;
  assert.equal(isTrustedFrameUrl(`${base}/../main.js`, appDir), false);
  assert.equal(isTrustedFrameUrl(`${base}/%2e%2e/main.js`, appDir), false);
});

test('export requests are checked for shape and size', () => {
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  assert.equal(validateExportRequest({ format: 'md', title: 'Plan', markdown: '# Hi' }), null);
  assert.equal(validateExportRequest({ format: 'pdf', title: 'Plan', html: '<p>x</p>' }), null);
  assert.equal(validateExportRequest({ format: 'docx', title: 'Plan', doc: { type: 'doc', content: [] }, images: { 7: { base64: png, width: 1, height: 1 } } }), null);
  assert.equal(validateExportRequest({ format: 'docx', title: 'Plan', doc: { type: 'doc' } }), null, 'pictures are optional');
  for (const bad of [
    null, 'md', [], { format: 'exe', title: 'x', markdown: '' }, { format: 'md', title: 5, markdown: '' },
    { format: 'md', title: 'x'.repeat(201), markdown: '' }, { format: 'md', title: 'x', markdown: 5 },
    { format: 'md', title: 'x', markdown: 'y'.repeat(2 * 1024 * 1024 + 1) },
    { format: 'pdf', title: 'x', html: '' }, { format: 'pdf', title: 'x' },
    { format: 'docx', title: 'x', doc: 'text' }, { format: 'docx', title: 'x', doc: [] },
    { format: 'docx', title: 'x', doc: { type: 'doc' }, images: [] },
    { format: 'docx', title: 'x', doc: { type: 'doc' }, images: { abc: { base64: png, width: 1, height: 1 } } },
    { format: 'docx', title: 'x', doc: { type: 'doc' }, images: { 1: { base64: '***', width: 1, height: 1 } } },
    { format: 'docx', title: 'x', doc: { type: 'doc' }, images: { 1: { base64: png, width: 0, height: 1 } } },
    { format: 'docx', title: 'x', doc: { type: 'doc' }, images: { 1: { base64: png, width: 1.5, height: 1 } } },
    { format: 'docx', title: 'x', doc: { type: 'doc' }, images: { 1: { base64: png, width: 99999, height: 1 } } },
  ]) {
    assert.ok(validateExportRequest(bad), JSON.stringify(bad).slice(0, 80));
  }
});

test('the suggested file name is safe', () => {
  assert.equal(exportFileName('Quarterly plan', 'pdf'), 'Quarterly plan.pdf');
  assert.equal(exportFileName('a/b\\c:d*e?f"g<h>i|j', 'docx'), 'a b c d e f g h i j.docx');
  assert.equal(exportFileName('', 'md'), 'Canvas.md');
  assert.equal(exportFileName('   ', 'md'), 'Canvas.md');
  assert.equal(exportFileName('..\\..\\evil', 'pdf'), 'evil.pdf');
  assert.equal(exportFileName('x'.repeat(200), 'pdf').length, 80 + '.pdf'.length);
  assert.ok(!/[\\/]/.test(exportFileName('../../etc/passwd', 'md')));
});

test('an Owner own sign-in may be kept aside for View as, and only in the right shape', () => {
  assert.equal(isAllowedStoreKey('viewAsReturn'), true);
  assert.equal(validateStoreWrite('viewAsReturn', { token: 'abc', user: { id: 1 } }), null);
  assert.ok(validateStoreWrite('viewAsReturn', { token: 5, user: { id: 1 } }));
  assert.ok(validateStoreWrite('viewAsReturn', { token: 'abc' }));
  assert.ok(validateStoreWrite('viewAsReturn', 'text'));
  assert.ok(validateStoreWrite('viewAsReturn', { token: 'x'.repeat(5000), user: {} }));
});
