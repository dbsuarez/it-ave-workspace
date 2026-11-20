// Rules for app updates, free of Electron imports so they can be unit tested.
// The app looks for updates on its own server, at <server address>/updates/ (see deploy/README.md). Only HTTPS is trusted, except this
// computer itself (for trying it out), and the address may not carry a user name or password.

function feedUrlFor(apiBase) {
  let url;
  try { url = new URL(String(apiBase || '')); } catch { return null; }
  if (url.username || url.password) return null;
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (!(url.protocol === 'https:' || (url.protocol === 'http:' && local))) return null;
  return `${url.protocol}//${url.host}/updates/`;
}

// The update progress the main process tells the window about. A ready update is never forgotten by a later check or error.
// state: { status: 'idle' | 'checking' | 'downloading' | 'ready' | 'none' | 'error', version?, percent?, message? }
function nextUpdateState(state, event) {
  const ready = state.status === 'ready';
  switch (event.type) {
    case 'checking': return ready ? state : { status: 'checking' };
    case 'available': return ready ? state : { status: 'downloading', version: event.version, percent: 0 };
    case 'progress': return ready ? state : { ...state, status: 'downloading', percent: Math.round(event.percent) };
    case 'downloaded': return { status: 'ready', version: event.version, percent: 100 };
    case 'none': return ready ? state : { status: 'none' };
    case 'error': return ready ? state : { status: 'error', message: String(event.message || 'Update check failed') };
    default: return state;
  }
}

module.exports = { feedUrlFor, nextUpdateState };
