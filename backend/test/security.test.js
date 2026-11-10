const test = require('node:test');
const assert = require('node:assert/strict');
const { getUploadValidationError, isExtensionAllowed, isMimeAllowed } = require('../src/security');

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
