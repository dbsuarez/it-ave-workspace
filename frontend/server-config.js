// Which backend the desktop app talks to.
//
// Precedence: the API_BASE / SOCKET_URL environment variables (for development
// and scripted installs), then the address saved from the sign-in window, then
// the local default. Kept free of Electron imports so it can be unit tested.

const DEFAULT_SERVER_URL = 'http://127.0.0.1:3001';

// Turns whatever a person typed into a clean origin such as http://192.168.1.20:3001.
// Throws an Error with a message that is safe to show to the person.
function normalizeServerUrl(input) {
  if (typeof input !== 'string' || !input.trim()) {
    throw new Error('Enter the server address, for example http://192.168.1.20:3001');
  }
  let text = input.trim();
  if (/\s/.test(text)) throw new Error('The address cannot contain spaces');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `http://${text}`;

  let url;
  try {
    url = new URL(text);
  } catch (err) {
    throw new Error('That does not look like a valid address');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('The address must start with http:// or https://');
  }
  if (!url.hostname) throw new Error('The address needs a host name or IP address');
  if (url.username || url.password) throw new Error('Do not put a user name or password in the address');
  if ((url.pathname && url.pathname !== '/') || url.search || url.hash) {
    throw new Error('Enter only the server address, without a path (for example http://192.168.1.20:3001)');
  }
  return `${url.protocol}//${url.host}`;
}

function tryNormalize(value) {
  try {
    return normalizeServerUrl(value);
  } catch (err) {
    return null;
  }
}

// -> { apiBase, socketUrl, source: 'environment' | 'saved' | 'default' }
function resolveServerConfig({ env = {}, stored } = {}) {
  const fromEnv = env.API_BASE ? tryNormalize(env.API_BASE) : null;
  const savedUrl = stored ? tryNormalize(stored) : null;
  const apiBase = fromEnv || savedUrl || DEFAULT_SERVER_URL;
  const socketFromEnv = env.SOCKET_URL ? tryNormalize(env.SOCKET_URL) : null;
  return {
    apiBase,
    socketUrl: socketFromEnv || apiBase,
    source: fromEnv ? 'environment' : (savedUrl ? 'saved' : 'default'),
  };
}

module.exports = { DEFAULT_SERVER_URL, normalizeServerUrl, resolveServerConfig };
