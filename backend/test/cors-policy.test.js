const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const cors = require('cors');
const { parseOrigins, isOriginAllowed, corsOptions } = require('../src/corsPolicy');

test('the desktop app, local tools and the configured sites are allowed; other sites are not', () => {
  const options = { configured: ['https://chat.example.com'], frontendUrl: 'https://app.example.com/' };
  for (const ok of [undefined, '', 'null', 'http://localhost:5173', 'https://localhost', 'http://127.0.0.1:3001', 'capacitor://localhost', 'https://chat.example.com', 'https://CHAT.example.com', 'https://app.example.com']) {
    assert.equal(isOriginAllowed(ok, options), true, String(ok));
  }
  for (const bad of ['https://evil.example.org', 'http://chat.example.com', 'https://chat.example.com.evil.org', 'http://localhost.evil.org', 'file://', 'http://192.168.1.50:3000']) {
    assert.equal(isOriginAllowed(bad, options), false, bad);
  }
});

test('"*" allows every site, and an empty configuration allows only the defaults', () => {
  assert.equal(isOriginAllowed('https://anything.example', { configured: ['*'] }), true);
  assert.equal(isOriginAllowed('https://anything.example'), false);
  assert.deepEqual(parseOrigins(' https://a.example/ , ,https://b.example '), ['https://a.example', 'https://b.example']);
  assert.deepEqual(parseOrigins(''), []);
  assert.deepEqual(parseOrigins(undefined), []);
});

test('a refused site gets no CORS headers, an allowed one does', async () => {
  const app = express();
  app.use(cors(corsOptions({ configured: ['https://chat.example.com'] })));
  app.get('/ping', (req, res) => res.json({ ok: true }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/ping`;
  try {
    const refused = await fetch(url, { headers: { Origin: 'https://evil.example.org' } });
    assert.equal(refused.headers.get('access-control-allow-origin'), null, 'the browser will block the response');
    const allowed = await fetch(url, { headers: { Origin: 'https://chat.example.com' } });
    assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://chat.example.com');
    assert.equal(allowed.headers.get('access-control-allow-credentials'), 'true');
    const desktop = await fetch(url, { headers: { Origin: 'null' } });
    assert.equal(desktop.headers.get('access-control-allow-origin'), 'null', 'the desktop app (file://) works');
    const noOrigin = await fetch(url);
    assert.equal(noOrigin.status, 200, 'a request without an Origin header (curl, other servers) works');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
