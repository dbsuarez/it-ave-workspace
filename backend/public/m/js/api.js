// Talking to the server from the phone app: the saved sign-in, JSON calls, and this phone's device id.
// The app is served by the same server it talks to, so every path is relative to the page.

const TOKEN_KEY = 'iav_token';
const USER_KEY = 'iav_user';
const DEVICE_KEY = 'iav_device';

function read(key) {
  try { return localStorage.getItem(key); } catch (err) { return null; }
}
function write(key, value) {
  try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); } catch (err) { /* private mode */ }
}

export const session = {
  get token() { return read(TOKEN_KEY); },
  set token(value) { write(TOKEN_KEY, value); },
  get user() { try { return JSON.parse(read(USER_KEY) || 'null'); } catch (err) { return null; } },
  set user(value) { write(USER_KEY, value ? JSON.stringify(value) : null); },
  clear() { write(TOKEN_KEY, null); write(USER_KEY, null); },
};

// A random id made once per phone and browser, and a readable name. Sent with clock-ins so HR can tell when
// someone uses a device they have not used before (a new phone is allowed, HR just approves it).
export function deviceHeaders() {
  let id = read(DEVICE_KEY);
  if (!id || !/^[A-Za-z0-9-]{8,64}$/.test(id)) {
    id = (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}-phone`).slice(0, 64);
    write(DEVICE_KEY, id);
  }
  const ua = navigator.userAgent || '';
  const kind = /iPhone|iPad/.test(ua) ? 'iPhone' : /Android/.test(ua) ? 'Android phone' : 'Phone browser';
  return { 'X-Device-Id': id, 'X-Device-Name': `${kind} (web app)` };
}

export const deviceId = () => deviceHeaders()['X-Device-Id'];

let onExpired = () => {};
export function onSessionExpired(fn) { onExpired = fn; }

// A call that returns the parsed JSON, or throws an Error with the server's message (and .code, .status).
export async function call(path, { method = 'GET', body, headers } = {}) {
  const res = await fetch(path, {
    method,
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(session.token ? { Authorization: `Bearer ${session.token}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 403 && /session expired|invalid or expired/i.test(data.error || '')) onExpired();
    throw Object.assign(new Error(data.error || 'Something went wrong'), { code: data.code, status: res.status });
  }
  return data;
}

// A file behind the sign-in (a photo, a picture in a message) as an object URL, cached.
const blobs = new Map();
export function blobUrl(path) {
  if (!blobs.has(path)) {
    blobs.set(path, fetch(path, { headers: { Authorization: `Bearer ${session.token}` } })
      .then((res) => (res.ok ? res.blob() : null)).then((blob) => (blob ? URL.createObjectURL(blob) : null)).catch(() => null));
  }
  return blobs.get(path);
}
