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
  return key === 'authToken' || key === 'user' || key === 'viewAsReturn' || (typeof key === 'string' && /^preferences:\d{1,12}$/.test(key));
}

// null when the write is acceptable, otherwise a short reason.
function validateStoreWrite(key, value) {
  if (!isAllowedStoreKey(key)) return 'That setting cannot be stored';
  if (key === 'authToken') {
    return typeof value === 'string' && value.length > 0 && value.length <= MAX_TOKEN_LENGTH
      ? null : 'Invalid session token';
  }
  const limit = key === 'user' ? MAX_USER_JSON : key === 'viewAsReturn' ? MAX_USER_JSON + MAX_TOKEN_LENGTH : MAX_PREFERENCES_JSON;
  if (!isPlainObject(value)) return 'Expected an object';
  // the Owner's own sign-in, kept aside during View as: { token, user }
  if (key === 'viewAsReturn' && !(typeof value.token === 'string' && value.token.length <= MAX_TOKEN_LENGTH && isPlainObject(value.user))) return 'Invalid saved sign-in';
  let size;
  try {
    size = JSON.stringify(value).length;
  } catch (err) {
    return 'Value cannot be stored';
  }
  return size <= limit ? null : 'Value is too large';
}

// ---- canvas export (PDF, Word, Markdown) ----
const EXPORT_FORMATS = { pdf: 'PDF document', docx: 'Word document', md: 'Markdown file' };
const MAX_EXPORT_MARKDOWN = 2 * 1024 * 1024;
const MAX_EXPORT_HTML = 60 * 1024 * 1024;
const MAX_EXPORT_DOC_JSON = 20 * 1024 * 1024;
const MAX_EXPORT_IMAGE_CHARS = 14 * 1024 * 1024; // base64 characters per picture
const MAX_EXPORT_IMAGES_CHARS = 60 * 1024 * 1024;
const MAX_EXPORT_IMAGES = 100;

// null when the request is acceptable, otherwise a short reason. The renderer is only trusted to ask, not to
// choose where the file goes: the user picks that in a save dialog.
function validateExportRequest(request) {
  if (!isPlainObject(request)) return 'Invalid export request';
  if (!Object.prototype.hasOwnProperty.call(EXPORT_FORMATS, request.format)) return 'Unsupported export format';
  if (typeof request.title !== 'string' || request.title.length > 200) return 'Invalid canvas title';
  if (request.format === 'md') {
    return typeof request.markdown === 'string' && request.markdown.length <= MAX_EXPORT_MARKDOWN ? null : 'The canvas text is too large to export';
  }
  if (request.format === 'pdf') {
    return typeof request.html === 'string' && request.html.length > 0 && request.html.length <= MAX_EXPORT_HTML ? null : 'The canvas is too large to export as PDF';
  }
  if (!isPlainObject(request.doc)) return 'Invalid canvas document';
  try {
    if (JSON.stringify(request.doc).length > MAX_EXPORT_DOC_JSON) return 'The canvas is too large to export';
  } catch (err) {
    return 'Invalid canvas document';
  }
  const images = request.images === undefined ? {} : request.images;
  if (!isPlainObject(images)) return 'Invalid pictures';
  const keys = Object.keys(images);
  if (keys.length > MAX_EXPORT_IMAGES) return 'Too many pictures to export';
  let total = 0;
  for (const key of keys) {
    const picture = images[key];
    if (!/^\d{1,10}$/.test(key) || !isPlainObject(picture)) return 'Invalid picture';
    if (typeof picture.base64 !== 'string' || picture.base64.length === 0 || picture.base64.length > MAX_EXPORT_IMAGE_CHARS) return 'A picture is too large to export';
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(picture.base64.slice(0, 64))) return 'Invalid picture data';
    for (const dimension of [picture.width, picture.height]) {
      if (!Number.isInteger(dimension) || dimension < 1 || dimension > 20000) return 'Invalid picture size';
    }
    total += picture.base64.length;
  }
  return total <= MAX_EXPORT_IMAGES_CHARS ? null : 'The pictures are too large to export';
}

// A safe file name for the save dialog's suggestion.
function exportFileName(title, format) {
  const cleaned = String(title || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+/, '')
    .slice(0, 80)
    .trim();
  return `${cleaned || 'Canvas'}.${format}`;
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
  EXPORT_FORMATS,
  validateExportRequest,
  exportFileName,
  isAllowedStoreKey,
  validateStoreWrite,
  isTrustedFrameUrl,
  isPlainObject,
};
