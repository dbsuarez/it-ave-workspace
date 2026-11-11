const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { isAllowedStoreKey, validateStoreWrite, isTrustedFrameUrl } = require('../ipc-policy');

test('only the keys the app uses may be stored', () => {
  for (const key of ['authToken', 'user', 'preferences:7', 'preferences:123456']) {
    assert.equal(isAllowedStoreKey(key), true, key);
  }
  for (const key of ['', 'serverUrl', 'preferences:', 'preferences:abc', 'preferences:1:2', '__proto__',
    'constructor', 'authToken ', 'AUTHTOKEN', 'a.b', null, undefined, 5, {}, ['user']]) {
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
