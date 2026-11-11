// Upload content checks. The browser's file name and MIME type are chosen by the sender, so they
// are never trusted: the stored type comes from the (allow-listed) extension, and the first bytes
// of the file must agree with that extension.
const fs = require('fs');

const MIME_BY_EXTENSION = {
  txt: 'text/plain', csv: 'text/csv', json: 'application/json', xml: 'application/xml',
  md: 'text/markdown', log: 'text/plain', ini: 'text/plain', cfg: 'text/plain',
  yaml: 'text/plain', yml: 'text/plain',
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  bmp: 'image/bmp', webp: 'image/webp', svg: 'image/svg+xml',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4',
  mp4: 'video/mp4', mov: 'video/quicktime', avi: 'video/x-msvideo', mkv: 'video/x-matroska', webm: 'video/webm',
  zip: 'application/zip', rar: 'application/x-rar-compressed', '7z': 'application/x-7z-compressed',
  tar: 'application/x-tar', gz: 'application/gzip', bz2: 'application/x-bzip2',
  js: 'text/plain', ts: 'text/plain', css: 'text/plain', html: 'text/plain', htm: 'text/plain',
};

const bytes = (...values) => Buffer.from(values);
const ZIP_SIGNATURES = [bytes(0x50, 0x4b, 0x03, 0x04), bytes(0x50, 0x4b, 0x05, 0x06)];

// Formats with a reliable leading signature. Others (text, mp3, mp4 and so on) are not checked
// here, but nothing that looks like a program is ever accepted (see looksExecutable).
const SIGNATURES_BY_EXTENSION = {
  png: [bytes(0x89, 0x50, 0x4e, 0x47)],
  jpg: [bytes(0xff, 0xd8, 0xff)],
  jpeg: [bytes(0xff, 0xd8, 0xff)],
  gif: [Buffer.from('GIF8')],
  bmp: [Buffer.from('BM')],
  pdf: [Buffer.from('%PDF')],
  zip: ZIP_SIGNATURES,
  docx: ZIP_SIGNATURES,
  xlsx: ZIP_SIGNATURES,
  pptx: ZIP_SIGNATURES,
  gz: [bytes(0x1f, 0x8b)],
  '7z': [bytes(0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c)],
  rar: [Buffer.from('Rar!')],
};

function extensionOf(filename = '') {
  const match = /\.([A-Za-z0-9]+)$/.exec(filename);
  return match ? match[1].toLowerCase() : '';
}

// The type we store and serve, decided by the server from the extension.
function mimeForFilename(filename) {
  return MIME_BY_EXTENSION[extensionOf(filename)] || 'application/octet-stream';
}

function startsWithAny(head, signatures) {
  return signatures.some((sig) => head.length >= sig.length && head.subarray(0, sig.length).equals(sig));
}

// Windows (MZ) and Linux (ELF) programs, and Mach-O, whatever the file is called.
function looksExecutable(head) {
  if (head.length >= 2 && head[0] === 0x4d && head[1] === 0x5a) return true;
  if (startsWithAny(head, [bytes(0x7f, 0x45, 0x4c, 0x46)])) return true;
  return startsWithAny(head, [
    bytes(0xfe, 0xed, 0xfa, 0xce), bytes(0xfe, 0xed, 0xfa, 0xcf),
    bytes(0xce, 0xfa, 0xed, 0xfe), bytes(0xcf, 0xfa, 0xed, 0xfe), bytes(0xca, 0xfe, 0xba, 0xbe),
  ]);
}

// Returns an error message, or null when the leading bytes are acceptable for the file name.
function checkContentMatchesName(head, filename) {
  if (looksExecutable(head)) return 'Executable files are not allowed';
  const expected = SIGNATURES_BY_EXTENSION[extensionOf(filename)];
  if (expected && !startsWithAny(head, expected)) {
    return 'The file contents do not match its type';
  }
  return null;
}

async function readHead(filePath, length = 16) {
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function checkUploadedFile(filePath, originalName) {
  return checkContentMatchesName(await readHead(filePath), originalName);
}

module.exports = {
  mimeForFilename,
  checkContentMatchesName,
  checkUploadedFile,
  looksExecutable,
};
