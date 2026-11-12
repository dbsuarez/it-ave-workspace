// Service worker for the phone app. It only runs on a secure origin (https, or localhost), so it makes the app
// installable and lets it open with no network; it never caches the API. Bump VERSION to push an update.
const VERSION = 'v1';
const SHELL = `iav-shell-${VERSION}`;
const FILES = ['./', 'app.css', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png',
  'js/app.js', 'js/api.js', 'js/ui.js', 'js/format.js', 'js/socket.js',
  'js/views/auth.js', 'js/views/chat.js', 'js/views/attendance.js', 'js/views/leave.js', 'js/views/people.js', 'js/views/me.js'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((cache) => cache.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith('iav-shell-') && k !== SHELL).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// App files: network first (so a new version arrives at once), the cached copy when offline. Everything else
// (the API, the socket, files) goes straight to the network.
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== location.origin || !url.pathname.startsWith('/m/')) return;
  event.respondWith(fetch(event.request).then((response) => {
    const copy = response.clone();
    if (response.ok) caches.open(SHELL).then((cache) => cache.put(event.request, copy));
    return response;
  }).catch(() => caches.match(event.request).then((hit) => hit || caches.match('./'))));
});
