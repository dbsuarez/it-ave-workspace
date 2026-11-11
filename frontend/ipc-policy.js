// Rules for what the renderer may ask the main process to do.
//
// The renderer holds no Node access, but anything running inside it (a bug in
// our own code, or injected content) could call the exposed bridge. These
// rules keep that bridge narrow: only our own pages may call it, and the
// persistent store only accepts the few keys the app actually uses.
//
// Kept free of Electron imports so it can be unit tested.

const path = require('path');
const { fileURLToPath } = require('url');

const MAX_TOKEN_LENGTH = 4096;
const MAX_USER_JSON = 8 * 1024;
const MAX_PREFERENCES_JSON = 4 * 1024;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function isAllowedStoreKey(key) {
  return key === 'authToken' || key === 'user' || (typeof key === 'string' && /^preferences:\d{1,12}$/.test(key));
}

// null when the write is acceptable, otherwise a short reason.
function validateStoreWrite(key, value) {
  if (!isAllowedStoreKey(key)) return 'That setting cannot be stored';
  if (key === 'authToken') {
    return typeof value === 'string' && value.length > 0 && value.length <= MAX_TOKEN_LENGTH
      ? null : 'Invalid session token';
  }
  const limit = key === 'user' ? MAX_USER_JSON : MAX_PREFERENCES_JSON;
  if (!isPlainObject(value)) return 'Expected an object';
  let size;
  try {
    size = JSON.stringify(value).length;
  } catch (err) {
    return 'Value cannot be stored';
  }
  return size <= limit ? null : 'Value is too large';
}

// True only for a page loaded from this app's own src folder.
function isTrustedFrameUrl(frameUrl, appDir) {
  try {
    const url = new URL(frameUrl);
    if (url.protocol !== 'file:') return false;
    const resolved = path.resolve(fileURLToPath(url));
    const root = path.resolve(appDir, 'src') + path.sep;
    const normalise = (value) => (process.platform === 'win32' ? value.toLowerCase() : value);
    return normalise(resolved).startsWith(normalise(root));
  } catch (err) {
    return false;
  }
}

module.exports = {
  isAllowedStoreKey,
  validateStoreWrite,
  isTrustedFrameUrl,
  isPlainObject,
};
