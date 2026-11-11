const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { getUploadValidationError } = require('../src/security');
const { mimeForFilename, checkContentMatchesName } = require('../src/uploadContent');
const { securityHeaders, requestLogger } = require('../src/httpHardening');

test('the client-claimed MIME type no longer gets an unknown extension through', () => {
  assert.match(
    getUploadValidationError({ originalname: 'payload.exe', size: 10, mimetype: 'image/png' }, 25),
    /Unsupported file type/
  );
  assert.match(
    getUploadValidationError({ originalname: 'noextension', size: 10, mimetype: 'text/plain' }, 25),
    /Unsupported file type/
  );
  assert.equal(getUploadValidationError({ originalname: 'a.PNG', size: 10, mimetype: '' }, 25), null);
});

test('the stored type comes from the extension, not the client', () => {
  assert.equal(mimeForFilename('photo.PNG'), 'image/png');
  assert.equal(mimeForFilename('page.html'), 'text/plain', 'html is served as plain text');
  assert.equal(mimeForFilename('weird'), 'application/octet-stream');
});

test('leading bytes must agree with the extension, and programs are refused', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
  const exe = Buffer.from('MZ\x90\x00');
  const elf = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);
  assert.equal(checkContentMatchesName(png, 'a.png'), null);
  assert.match(checkContentMatchesName(exe, 'renamed.png'), /Executable/);
  assert.match(checkContentMatchesName(exe, 'notes.txt'), /Executable/);
  assert.match(checkContentMatchesName(elf, 'tool.pdf'), /Executable/);
  assert.match(checkContentMatchesName(Buffer.from('hello'), 'fake.png'), /do not match/);
  assert.match(checkContentMatchesName(Buffer.from('hello'), 'fake.pdf'), /do not match/);
  assert.equal(checkContentMatchesName(Buffer.from('PK\x03\x04rest'), 'sheet.xlsx'), null);
  assert.equal(checkContentMatchesName(Buffer.from('plain text'), 'notes.txt'), null);
});

test('responses carry security headers and requests are logged without the query string', async () => {
  const lines = [];
  const app = express();
  app.use(securityHeaders);
  app.use(requestLogger({ write: (line) => lines.push(line) }));
  app.get('/api/ping', (req, res) => res.json({ ok: true }));
  app.get('/api/health', (req, res) => res.json({ ok: true }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await fetch(`${base}/api/ping?token=SECRET`);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.equal(res.headers.get('x-powered-by'), null);
    assert.match(res.headers.get('content-security-policy'), /default-src 'none'/);
    assert.equal(res.headers.get('strict-transport-security'), null, 'no HSTS over plain HTTP');
    await fetch(`${base}/api/health`);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(lines.length, 1, 'health checks are not logged');
    assert.match(lines[0], /GET \/api\/ping 200 \d+ms/);
    assert.ok(!lines[0].includes('SECRET'), 'the query string is never logged');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
