// Which web origins may call the API from a browser. The desktop app is loaded from file://, whose Origin
// is the literal string "null", so that is allowed; so is a request with no Origin header at all (not a
// browser cross-site request). Other sites are refused unless listed in CORS_ORIGINS (comma separated), or
// "*" to allow every origin (not recommended). Login uses a bearer token, never cookies, so this is
// defence in depth rather than the main protection.
const LOCAL_ORIGINS = [
  /^https?:\/\/localhost(:\d+)?$/i,
  /^https?:\/\/127\.0\.0\.1(:\d+)?$/,
  /^capacitor:\/\/localhost$/i, // the Android/iOS wrapper
  /^ionic:\/\/localhost$/i,
];

function parseOrigins(value) {
  return String(value || '')
    .split(',')
    .map((origin) => origin.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}

function normalizeOrigin(origin) {
  return String(origin || '').trim().replace(/\/+$/, '').toLowerCase();
}

function isOriginAllowed(origin, { configured = [], frontendUrl = '' } = {}) {
  if (!origin) return true;
  if (origin === 'null') return true;
  const wanted = normalizeOrigin(origin);
  if (configured.includes('*')) return true;
  if (configured.some((allowed) => normalizeOrigin(allowed) === wanted)) return true;
  if (frontendUrl && normalizeOrigin(frontendUrl) === wanted) return true;
  return LOCAL_ORIGINS.some((pattern) => pattern.test(origin));
}

// Options for the `cors` package and for Socket.IO.
function corsOptions({ configured = [], frontendUrl = '' } = {}) {
  return {
    origin: (origin, callback) => callback(null, isOriginAllowed(origin, { configured, frontendUrl })),
    credentials: true,
  };
}

module.exports = { parseOrigins, isOriginAllowed, corsOptions };
