const test = require('node:test');
const assert = require('node:assert/strict');
const {
  getUploadValidationError,
  isExtensionAllowed,
  isMimeAllowed,
  ensureCanPostToChannel,
} = require('../src/security');

test('allows common office and image uploads', () => {
  assert.equal(
    getUploadValidationError({ originalname: 'report.pdf', size: 1024, mimetype: 'application/pdf' }, 25),
    null
  );

  assert.equal(
    getUploadValidationError({ originalname: 'screenshot.png', size: 2048, mimetype: 'image/png' }, 25),
    null
  );
});

test('blocks executable and unsupported file types', () => {
  assert.match(
    getUploadValidationError({ originalname: 'payload.exe', size: 512, mimetype: 'application/x-msdownload' }, 25),
    /Unsupported file type/
  );

  assert.equal(isExtensionAllowed('calc.exe'), false);
  assert.equal(isMimeAllowed('application/x-msdownload'), false);
});

test('enforces size limits', () => {
  const error = getUploadValidationError({ originalname: 'big.txt', size: 6 * 1024 * 1024, mimetype: 'text/plain' }, 5);
  assert.match(error, /exceeds the 5MB limit/);
});

test('active channel timeouts reject channel messages', async () => {
  const query = async (sql) => {
    if (sql.includes('FROM channels c')) return { rows: [{}] };
    if (sql.includes('FROM channel_timeouts')) return { rows: [{ expires_at: new Date(Date.now() + 60000) }] };
    throw new Error(`Unexpected query: ${sql}`);
  };
  await assert.rejects(
    ensureCanPostToChannel(query, 2, 4),
    (err) => err.status === 403 && /timed out/.test(err.message)
  );
});

test('channel slow mode rejects messages sent before the cooldown expires', async () => {
  const query = async (sql) => {
    if (sql.includes('CROSS JOIN users u')) return { rows: [{}] };
    if (sql.includes('FROM channel_timeouts')) return { rows: [] };
    if (sql.includes('SELECT is_superadmin')) return { rows: [{ is_superadmin: false }] };
    if (sql.includes('SELECT c.slowmode_seconds')) {
      return { rows: [{ slowmode_seconds: 10, last_message_at: new Date(Date.now() - 1000) }] };
    }
    if (sql.includes('UPDATE channel_members')) return { rows: [] };
    throw new Error(`Unexpected query: ${sql}`);
  };
  await assert.rejects(
    ensureCanPostToChannel(query, 2, 4),
    (err) => err.status === 429 && err.retryAfterSeconds >= 1
  );
});
