// IT Avenue Workspace on a phone: sign-in, the five tabs, and the routes between screens.
// Chat, Clock (attendance), Leave, People and Me. Served by the same server it talks to, at /m/.
import { session, call, onSessionExpired } from './api.js';
import * as socket from './socket.js';
import { h, clear, toast, icon } from './ui.js';
import { renderLogin, renderForcedPassword } from './views/auth.js';
import * as chat from './views/chat.js';
import * as attendance from './views/attendance.js';
import * as leave from './views/leave.js';
import * as people from './views/people.js';
import * as me from './views/me.js';

const TABS = [
  { key: 'chat', label: 'Chat', icon: 'chat', view: chat },
  { key: 'clock', label: 'Clock', icon: 'clock', view: attendance },
  { key: 'leave', label: 'Leave', icon: 'calendar', view: leave },
  { key: 'people', label: 'People', icon: 'users', view: people },
  { key: 'me', label: 'Me', icon: 'user', view: me },
];

const app = document.getElementById('app');
let shell = null;
let cleanup = null;
const badges = { chat: 0, clock: 0, leave: 0 };

// "#/chat/c/12" -> { tab: 'chat', parts: ['c', '12'] }
function parseHash() {
  const [tab, ...parts] = (location.hash.replace(/^#\/?/, '') || 'chat').split('/');
  return { tab: TABS.some((t) => t.key === tab) ? tab : 'chat', parts };
}

export const go = (path) => { location.hash = `#/${path}`; };

function paintBadges() {
  if (!shell) return;
  for (const tab of TABS) {
    const badge = shell.tabbar.querySelector(`[data-tab="${tab.key}"] .tab-badge`);
    if (!badge) continue;
    const n = badges[tab.key] || 0;
    badge.hidden = !n;
    badge.textContent = n > 99 ? '99+' : String(n);
  }
}

export function setBadge(tab, n) {
  badges[tab] = n;
  paintBadges();
}

// What is waiting for me, without opening each tab: unread chat, leave and corrections to approve.
let badgeTimer = null;
export function refreshBadges() {
  clearTimeout(badgeTimer);
  badgeTimer = setTimeout(async () => {
    try {
      const [channels, leaveMe, today] = await Promise.all([
        call('/api/channels/my').catch(() => ({ channels: [] })),
        call('/api/leave/me').catch(() => ({ approvalsWaiting: 0 })),
        call('/api/attendance/today').catch(() => ({ correctionsWaiting: 0 })),
      ]);
      setBadge('chat', channels.channels.reduce((sum, c) => sum + (c.unreadCount || 0), 0));
      setBadge('leave', leaveMe.approvalsWaiting || 0);
      setBadge('clock', today.correctionsWaiting || 0);
    } catch (err) {
      // not signed in any more: the session handler deals with it
    }
  }, 300);
}

function buildShell() {
  const title = h('h1', { class: 'topbar-title' }, 'IT Avenue');
  const back = h('button', { class: 'icon-btn topbar-back', type: 'button', 'aria-label': 'Back', hidden: true }, icon('back'));
  const dot = h('span', { class: 'conn-dot', title: 'Live updates' });
  const view = h('main', { class: 'view', id: 'view' });
  const tabbar = h('nav', { class: 'tabbar', 'aria-label': 'Sections' }, TABS.map((tab) => h('a', { class: 'tab', href: `#/${tab.key}`, dataset: { tab: tab.key } },
    h('span', { class: 'tab-icon' }, icon(tab.icon), h('span', { class: 'tab-badge', hidden: true })), h('span', {}, tab.label))));
  const root = h('div', { class: 'shell' }, h('header', { class: 'topbar' }, back, title, dot), view, tabbar);
  return { root, title, back, view, tabbar, dot };
}

function show() {
  if (!shell) return;
  const { tab, parts } = parseHash();
  if (cleanup) { try { cleanup(); } catch (err) { console.error(err); } cleanup = null; }
  shell.tabbar.querySelectorAll('.tab').forEach((el) => el.classList.toggle('active', el.dataset.tab === tab));
  shell.back.hidden = true;
  shell.back.onclick = null;
  shell.title.textContent = TABS.find((t) => t.key === tab).label;
  clear(shell.view);
  const ctx = {
    user: session.user,
    go,
    signOut: () => signOut(),
    setTitle: (text) => { shell.title.textContent = text; },
    // a screen deeper than the tab shows a back arrow
    setBack: (fn) => { shell.back.hidden = !fn; shell.back.onclick = fn || null; },
    setBadge,
    refreshBadges,
    scrollTop: () => { shell.view.scrollTop = 0; },
  };
  const result = TABS.find((t) => t.key === tab).view.render(shell.view, parts, ctx);
  Promise.resolve(result).then((fn) => { if (typeof fn === 'function') cleanup = fn; }).catch((err) => {
    console.error(err);
    toast(err.message || 'Could not open this screen.', 'error');
  });
}

export function signOut() {
  socket.disconnect();
  session.clear();
  shell = null;
  start();
}

function startShell() {
  shell = buildShell();
  clear(app).append(shell.root);
  socket.onStatus((ready) => shell && shell.dot.classList.toggle('on', ready));
  socket.connect();
  for (const event of ['channel_activity', 'new_message', 'new_direct_message', 'new_group_message', 'leave_updated', 'attendance_updated']) socket.on(event, refreshBadges);
  window.addEventListener('hashchange', show);
  show();
  refreshBadges();
}

async function start() {
  window.removeEventListener('hashchange', show);
  clear(app);
  if (!session.token) { renderLogin(app, start); return; }
  try {
    const data = await call('/api/auth/me');
    session.user = { ...session.user, ...data.user };
    if (data.user.mustChangePassword) { renderForcedPassword(app, start); return; }
  } catch (err) {
    if (err.status === 401 || err.status === 403 || err.status === 404) { session.clear(); renderLogin(app, start); return; }
    // offline or the server is busy: carry on with what is saved
    if (!session.user) { renderLogin(app, start); return; }
  }
  startShell();
}

onSessionExpired(() => { toast('Please sign in again.', 'info'); signOut(); });

// Installable on https (or localhost); on plain http the app still works in the browser.
if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

start();
