const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULT_SERVER_URL, normalizeServerUrl, resolveServerConfig } = require('../server-config');

test('normalises typed addresses to a clean origin', () => {
  assert.equal(normalizeServerUrl('192.168.1.20:3001'), 'http://192.168.1.20:3001');
  assert.equal(normalizeServerUrl('  http://office-pc:3001/  '), 'http://office-pc:3001');
  assert.equal(normalizeServerUrl('https://chat.example.com'), 'https://chat.example.com');
  assert.equal(normalizeServerUrl('HTTP://Example.COM:8080'), 'http://example.com:8080');
  assert.equal(normalizeServerUrl('http://[::1]:3001'), 'http://[::1]:3001');
});

test('rejects blanks, other schemes, credentials, paths and spaces', () => {
  const bad = [
    '', '   ', null, undefined, 42,
    'ftp://example.com', 'file:///c:/x', 'javascript:alert(1)',
    'http://user:pw@example.com', 'http://example.com/api', 'http://example.com?x=1',
    'http://example.com#top', 'http://exa mple.com', 'http://',
  ];
  for (const value of bad) {
    assert.throws(() => normalizeServerUrl(value), Error, `${JSON.stringify(value)} should be rejected`);
  }
});

test('error messages are readable', () => {
  assert.throws(() => normalizeServerUrl('ftp://x.example'), /http:\/\/ or https:\/\//);
  assert.throws(() => normalizeServerUrl('http://x.example/api'), /without a path/);
});

test('environment overrides a saved address, which overrides the default', () => {
  assert.deepEqual(resolveServerConfig({}), {
    apiBase: DEFAULT_SERVER_URL, socketUrl: DEFAULT_SERVER_URL, source: 'default',
  });
  assert.deepEqual(resolveServerConfig({ stored: 'http://10.0.0.5:3001' }), {
    apiBase: 'http://10.0.0.5:3001', socketUrl: 'http://10.0.0.5:3001', source: 'saved',
  });
  assert.deepEqual(
    resolveServerConfig({ env: { API_BASE: 'https://chat.example.com' }, stored: 'http://10.0.0.5:3001' }),
    { apiBase: 'https://chat.example.com', socketUrl: 'https://chat.example.com', source: 'environment' }
  );
});

test('an invalid saved or environment address falls back instead of breaking the app', () => {
  assert.equal(resolveServerConfig({ stored: 'not a url at all' }).source, 'default');
  assert.equal(resolveServerConfig({ env: { API_BASE: 'ftp://x' }, stored: '10.0.0.5:3001' }).apiBase, 'http://10.0.0.5:3001');
});

test('a separate socket address is honoured only when valid', () => {
  const config = resolveServerConfig({ env: { API_BASE: 'http://a.example:1', SOCKET_URL: 'http://b.example:2' } });
  assert.equal(config.socketUrl, 'http://b.example:2');
  assert.equal(resolveServerConfig({ env: { API_BASE: 'http://a.example:1', SOCKET_URL: 'bad bad' } }).socketUrl, 'http://a.example:1');
});
