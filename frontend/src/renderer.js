// IT Avenue Workspace - Renderer (Main Chat Window)
// Handles UI, Socket.io connection, and all chat interactions

// electronAPI is exposed on window by the preload (contextBridge)
// Reference it directly - re-declaring it triggers a global parse error
// ("Identifier 'electronAPI' has already been declared"), which kills the
// renderer before any handler is attached.

// Configuration
const API_BASE = 'http://127.0.0.1:3001'; // Change to your deployed URL
const SOCKET_URL = 'http://127.0.0.1:3001';

// State
let state = {
  token: null,
  user: null,
  channels: [],
  dms: [],
  messages: {},       // channelId -> []
  directMessages: {}, // userId -> []
  threads: {},        // messageId -> []
  readReceipts: {},   // channelId -> [{id, username, avatarColor, readAt}]
  currentChannelId: null,
  currentDMId: null,
  currentThreadId: null,
  view: 'channel',
  section: 'home',
  socket: null,
  files: [],
  notes: [],
};

// DOM elements
const els = {
  loginCard: document.querySelector('.login-card'),
  app: document.querySelector('.app'),
  viewChannel: document.getElementById('view-channel'),
  viewDm: document.getElementById('view-dm'),
  viewFiles: document.getElementById('view-files'),
  viewNotes: document.getElementById('view-notes'),
  viewHuddle: document.getElementById('view-huddle'),
  messages: document.getElementById('messages'),
  dmMessages: document.getElementById('dm-messages'),
  channelList: document.getElementById('channel-list'),
  dmList: document.getElementById('dm-list'),
  channelTitle: document.getElementById('channel-title'),
  channelTopic: document.getElementById('channel-topic'),
  dmTitle: document.getElementById('dm-title'),
  dmTopic: document.getElementById('dm-topic'),
  messageInput: document.getElementById('message-input'),
  dmMessageInput: document.getElementById('dm-message-input'),
  sendBtn: document.getElementById('send-btn'),
  sendDmBtn: document.getElementById('send-dm-btn'),
  filePicker: document.getElementById('file-picker'),
  dmFilePicker: document.getElementById('dm-file-picker'),
  threadPanel: document.getElementById('thread-panel'),
  threadMessages: document.getElementById('thread-messages'),
  threadInput: document.getElementById('thread-input'),
  threadCount: document.getElementById('thread-count'),
  userName: document.getElementById('user-name'),
  userEmail: document.getElementById('user-email'),
  userAvatar: document.getElementById('user-avatar'),
  userMenuBtn: document.getElementById('btn-user-menu'),
  pane: document.getElementById('list-pane'),
  paneTitle: document.getElementById('pane-title'),
  paneHome: document.getElementById('pane-home'),
  paneDms: document.getElementById('pane-dms'),
  paneActivity: document.getElementById('pane-activity'),
  activityList: document.getElementById('activity-list'),
  activityGrid: document.getElementById('activity-grid'),
  modalOverlay: document.getElementById('modal-overlay'),
  modalCreateChannel: document.getElementById('modal-create-channel'),
  filesGrid: document.getElementById('files-grid'),
  notesGrid: document.getElementById('notes-grid'),
};

// ============================================================
// Initialization
// ============================================================
async function init() {
  // Apply dev-mode class before any view work — controls dev banner visibility
  if (window.electronAPI && window.electronAPI.isDev) {
    document.body.classList.add('iav-dev');
  }

  const storedToken = await electronAPI.storeGet('authToken');
  const storedUser = await electronAPI.storeGet('user');

  if (storedToken && storedUser) {
    state.token = storedToken;
    state.user = storedUser;
    showApp();
    updateRail('home');
    showPane('home');
    connectSocket();
    loadChannels();
    loadUsers();
    // Presence keepalive / refresh: mark self online and re-render dot colors
    startPresenceLoop();
  } else {
    showLogin();
  }

  setupEventListeners();
}

function startPresenceLoop() {
  setInterval(() => {
    api('/api/users/heartbeat', { method: 'POST' }).catch(() => {});
    loadUsers().catch(() => {});
  }, 30000);
}

function setupEventListeners() {
  const on = (id, event, fn) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener(event, fn);
  };

  // Global: Ctrl/Cmd+K focuses search, Esc closes menus/thread/modal
  window.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      document.getElementById('global-search')?.focus();
      return;
    }
    if (mod && (e.key === 'n' || e.key === 'N')) {
      e.preventDefault();
      setSection('home');
      els.messageInput?.focus();
      return;
    }
    if (mod && (e.key === 'r' || e.key === 'R')) {
      e.preventDefault();
      window.electronAPI?.appCommand?.(e.shiftKey ? 'force-reload' : 'reload');
      return;
    }
    if (mod && e.shiftKey && (e.key === 'i' || e.key === 'I')) {
      e.preventDefault();
      window.electronAPI?.appCommand?.('devtools');
      return;
    }
    if (mod && (e.key === 'q' || e.key === 'Q')) {
      e.preventDefault();
      window.electronAPI?.appCommand?.('quit');
      return;
    }
    if (e.key === 'F11') {
      e.preventDefault();
      window.electronAPI?.appCommand?.('fullscreen');
      return;
    }
    if (e.key === 'Escape') {
      if (closeAllMenus()) return;
      const thread = document.getElementById('thread-panel');
      if (thread && !thread.classList.contains('closed')) { closeThreadPanel(); return; }
      const noteEditor = document.getElementById('note-editor');
      if (noteEditor && noteEditor.classList.contains('open')) { closeNoteEditor(); return; }
      const modalCreate = document.getElementById('modal-create-channel');
      if (modalCreate && modalCreate.classList.contains('open')) { closeModalCreateChannel(); return; }
      const modalOverlay = document.getElementById('modal-overlay');
      if (modalOverlay && modalOverlay.classList.contains('open')) {
        modalCreate?.classList.remove('open');
        modalOverlay.classList.remove('open');
      }
    }
  });

  // Login form
  on('auth-form', 'submit', handleLogin);
  on('switch-btn', 'click', toggleRegister);

  // Rail navigation
  document.querySelectorAll('.rail-item[data-rail]').forEach((btn) => {
    btn.addEventListener('click', () => setSection(btn.dataset.rail));
  });

  // Create menu
  on('btn-create', 'click', (e) => { e.stopPropagation(); toggleMenu('create-menu', 'btn-create'); });
  document.querySelectorAll('#create-menu .menu-item').forEach((item) => {
    item.addEventListener('click', () => {
      closeAllMenus();
      handleCreate(item.dataset.create);
    });
  });

  // User menu
  on('btn-user-menu', 'click', (e) => { e.stopPropagation(); toggleMenu('user-menu', 'btn-user-menu'); });
  document.querySelectorAll('#user-menu .menu-item').forEach((item) => {
    item.addEventListener('click', () => {
      closeAllMenus();
      handleAccountAction(item.dataset.account);
    });
  });

  // App menu (hamburger)
  on('btn-app-menu', 'click', (e) => { e.stopPropagation(); toggleMenu('app-menu', 'btn-app-menu'); });

  // Submenu triggers: File / Edit / View / Window / Help.
  // Hover opens via CSS; click toggles for keyboard and touch users.
  document.querySelectorAll('#app-menu .has-submenu').forEach((trigger) => {
    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = trigger.classList.contains('open');
      document.querySelectorAll('#app-menu .has-submenu').forEach((t) => {
        t.classList.remove('open');
        t.setAttribute('aria-expanded', 'false');
      });
      if (!isOpen) {
        trigger.classList.add('open');
        trigger.setAttribute('aria-expanded', 'true');
      }
    });
    trigger.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowRight') {
        e.preventDefault();
        trigger.click();
      }
    });
  });

  // Command items inside the submenus
  document.querySelectorAll('#app-menu .menu-item[data-command]').forEach((item) => {
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      closeAllMenus();
      handleAppCommand(item.dataset.command);
    });
  });
  on('btn-help', 'click', () => showToast('Press Ctrl+K to search. Esc closes panels.', undefined));

  // Window controls (frameless window)
  on('btn-win-min', 'click', () => window.electronAPI?.appCommand?.('minimize'));
  on('btn-win-max', 'click', () => window.electronAPI?.appCommand?.('toggle-maximize'));
  on('btn-win-close', 'click', () => window.electronAPI?.appCommand?.('close-window'));
  document.querySelector('.topbar-brand')?.addEventListener('dblclick', () => {
    window.electronAPI?.appCommand?.('toggle-maximize');
  });

  // Close menus when clicking elsewhere
  document.addEventListener('click', () => closeAllMenus());

  // Channel creation
  on('btn-create-channel', 'click', openCreateChannelModal);
  on('btn-pane-action', 'click', openCreateChannelModal);
  on('btn-save-create', 'click', saveCreateChannel);
  on('btn-cancel-create', 'click', closeModalCreateChannel);
  on('btn-close-create-channel', 'click', closeModalCreateChannel);

  on('btn-close-thread', 'click', closeThreadPanel);
  on('btn-send-thread', 'click', sendThreadReply);

  // Views
  on('btn-huddle-close', 'click', () => setSection('home'));
  on('btn-refresh-activity', 'click', () => renderActivity());

  // Files / Notes
  on('btn-refresh-files', 'click', () => loadFiles());
  on('btn-new-note', 'click', () => openNoteEditor(null));
  on('btn-save-note-editor', 'click', () => saveNoteFromEditor());
  on('btn-cancel-note', 'click', () => closeNoteEditor());
  on('btn-close-note-editor', 'click', () => closeNoteEditor());

  // Compose
  on('btn-compose', 'click', () => els.messageInput?.focus());
  on('send-btn', 'click', sendChannelMessage);
  on('send-dm-btn', 'click', sendDmMessage);

  // File attach
  on('btn-attach', 'click', () => els.filePicker?.click());
  on('file-picker', 'change', handleFilePick);
  on('btn-dm-attach', 'click', () => els.dmFilePicker?.click());
  on('dm-file-picker', 'change', handleDmFilePick);

  // Thread
  on('thread-input', 'keydown', (e) => {
    if (e.key === 'Enter') sendThreadReply();
  });

  // Message inputs
  if (els.messageInput) els.messageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChannelMessage(); }
  });
  if (els.dmMessageInput) els.dmMessageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendDmMessage(); }
  });
}

// ============================================================
// Authentication
// ============================================================
function showLogin() {
  if (els.app) els.app.style.display = 'none';
  if (els.loginCard) els.loginCard.style.display = 'block';
}

function showApp() {
  if (els.loginCard) els.loginCard.style.display = 'none';
  if (els.app) els.app.style.display = 'flex';
  if (els.userMenuBtn) els.userMenuBtn.style.display = 'flex';
  if (els.userName) els.userName.textContent = state.user.username;
  if (els.userEmail) els.userEmail.textContent = state.user.email || '';
  if (els.userAvatar) els.userAvatar.textContent = state.user.username.charAt(0).toUpperCase();
}

async function handleLogin(e) {
  e.preventDefault();
  const username = document.getElementById('username').value.trim();
  const password = document.getElementById('password').value;
  const errorEl = document.getElementById('error-msg');
  const btn = document.getElementById('auth-btn');

  errorEl.style.display = 'none';
  btn.disabled = true;
  btn.textContent = 'Signing in...';

  try {
    const res = await fetch(`${API_BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });

    const data = await res.json();

    if (!res.ok) {
      errorEl.textContent = data.error || 'Login failed';
      errorEl.style.display = 'block';
      return;
    }

    state.token = data.token;
    state.user = data.user;

    await electronAPI.storeSet('authToken', data.token);
    await electronAPI.storeSet('user', data.user);

    showApp();
    connectSocket();
    loadChannels();
    loadUsers();
  } catch (err) {
    errorEl.textContent = 'Cannot connect to server. Is it running?';
    errorEl.style.display = 'block';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sign in';
  }
}

function toggleRegister() {
  const form = document.getElementById('auth-form');
  const title = document.getElementById('auth-title');
  const subtitle = document.getElementById('auth-subtitle');
  const btn = document.getElementById('auth-btn');
  const switchBtn = document.getElementById('switch-btn');
  const errorEl = document.getElementById('error-msg');

  if (btn.textContent === 'Sign in') {
    title.textContent = 'Create an account';
    subtitle.textContent = 'Join IT Avenue Workspace';
    btn.textContent = 'Create account';
    switchBtn.textContent = 'Already have an account?';
    form.onsubmit = handleRegister;
  } else {
    title.textContent = 'Sign in';
    subtitle.textContent = 'Welcome to IT Avenue Workspace';
    btn.textContent = 'Sign in';
    switchBtn.textContent = 'Create an account';
    form.onsubmit = handleLogin;
  }
  errorEl.style.display = 'none';
}

async function handleRegister(e) {
  e.preventDefault();
  const username = document.getElementById('username').value.trim();
  const password = document.getElementById('password').value;
  const errorEl = document.getElementById('error-msg');
  const btn = document.getElementById('auth-btn');

  errorEl.style.display = 'none';
  btn.disabled = true;
  btn.textContent = 'Creating...';

  try {
    const res = await fetch(`${API_BASE}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, email: `${username}@itavenue.local`, password }),
    });

    const data = await res.json();

    if (!res.ok) {
      errorEl.textContent = data.error || 'Registration failed';
      errorEl.style.display = 'block';
      return;
    }

    // Auto-login after registration
    state.token = data.token;
    state.user = data.user;
    await electronAPI.storeSet('authToken', data.token);
    await electronAPI.storeSet('user', data.user);

    showApp();
    connectSocket();
    loadChannels();
    loadUsers();
  } catch (err) {
    errorEl.textContent = 'Cannot connect to server. Is it running?';
    errorEl.style.display = 'block';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Create account';
  }
}

async function handleLogout() {
  state.token = null;
  state.user = null;
  state.channels = [];
  state.messages = {};
  state.currentChannelId = null;

  await electronAPI.storeDelete('authToken');
  await electronAPI.storeDelete('user');

  if (state.socket) {
    state.socket.disconnect();
    state.socket = null;
  }

  showLogin();
}

// ============================================================
// Socket.io Connection
// ============================================================
function connectSocket() {
  if (!state.token) return;

  state.socket = io(SOCKET_URL, {
    auth: { token: state.token },
    transports: ['websocket', 'polling'],
  });

  state.socket.on('connect', () => {
    console.log('Connected to socket server');
    state.socket.emit('authenticate', state.token);
  });

  state.socket.on('authenticated', (data) => {
    console.log('Socket authenticated:', data.username);
  });

  state.socket.on('new_message', (msg) => {
    if (!state.messages[msg.channelId]) state.messages[msg.channelId] = [];
    state.messages[msg.channelId].push(msg);

    const isActive = state.currentChannelId === msg.channelId && state.view === 'channel';

    if (isActive) {
      renderMessages('messages', state.messages[msg.channelId]);
      api(`/api/channels/${msg.channelId}/read`, { method: 'POST' })
        .then(() => {
          const ch = state.channels.find(c => c.id === msg.channelId);
          if (ch) ch.unreadCount = 0;
          return loadReadReceipts(msg.channelId);
        })
        .catch(() => {});
    } else {
      // Increment unread badge for that channel in the sidebar and activity
      const ch = state.channels.find(c => c.id === msg.channelId);
      if (ch) {
        ch.unreadCount = (ch.unreadCount || 0) + 1;
        renderSidebar();
        renderActivity();
      }
    }
  });

  state.socket.on('new_direct_message', (dm) => {
    if (!state.directMessages[dm.senderId]) state.directMessages[dm.senderId] = [];
    state.directMessages[dm.senderId].push(dm);

    if (state.currentDMId === dm.senderId && state.view === 'dm') {
      renderMessages('dm-messages', state.directMessages[dm.senderId]);
    }
  });

  state.socket.on('user_typing', (data) => {
    // Could show typing indicator
  });

  state.socket.on('disconnect', () => {
    console.log('Disconnected from socket server');
  });
}

// ============================================================
// API Helpers
// ============================================================
async function api(path, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...options.headers,
  };
  if (state.token) {
    headers['Authorization'] = `Bearer ${state.token}`;
  }

  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
  });

  return res;
}

// ============================================================
// Channels
// ============================================================
async function loadChannels() {
  try {
    const res = await api('/api/channels/my');
    const data = await res.json();

    if (!res.ok) throw new Error(data.error || 'Failed to load channels');

    state.channels = data.channels;
    renderSidebar();

    // Open first channel if none selected
    if (!state.currentChannelId && state.channels.length > 0) {
      openChannel(state.channels[0].id);
    }
  } catch (err) {
    console.error('Load channels error:', err);
  }
}

function renderSidebar() {
  els.channelList.innerHTML = '';
  els.dmList.innerHTML = '';

  state.channels.forEach((ch) => {
    const active = state.currentChannelId === ch.id && state.section === 'home';
    const item = document.createElement('div');
    item.className = 'nav-item' + (active ? ' active' : '');
    const unread = ch.unreadCount || 0;
    item.innerHTML = `<span>#</span><span>${escapeHtml(ch.name)}</span>${unread > 0 && !active ? `<span class="unread-badge">${unread}</span>` : ''}`;
    item.title = ch.topic || '';
    item.onclick = (e) => { e.stopPropagation(); openChannel(ch.id); };
    els.channelList.appendChild(item);
  });

  // renderSidebar rebuilds the whole nav, so re-render the DM list too
  renderDmList();
  const badge = document.getElementById('activity-badge');
  if (badge) {
    const total = state.channels.reduce((sum, c) => sum + (c.unreadCount || 0), 0);
    badge.hidden = total === 0;
    badge.textContent = total > 99 ? '99+' : String(total);
  }
}

async function openChannel(channelId) {
  const previousChannelId = state.currentChannelId;

  // Leave the previous channel room so we stop receiving its messages
  if (state.socket && previousChannelId && previousChannelId !== channelId) {
    state.socket.emit('leave_channel', previousChannelId);
  }

  state.currentChannelId = channelId;
  state.currentDMId = null;
  state.currentThreadId = null;
  state.view = 'channel';
  state.section = 'home';
  closeThreadPanel();
  updateRail('home');
  showPane('home');
  showView('channel');

  const ch = state.channels.find(c => c.id === channelId);
  if (ch) {
    els.channelTitle.textContent = '#' + ch.name;
    els.channelTopic.textContent = ch.topic || '';
  }

  // Join the channel room so realtime messages appear without reloading the view
  if (state.socket) {
    state.socket.emit('join_channel', channelId);
  }

  // Mark channel as read and zero the unread badge
  const chUnread = state.channels.find(c => c.id === channelId);
  if (chUnread && chUnread.unreadCount > 0) {
    chUnread.unreadCount = 0;
    renderSidebar();
  }
  api(`/api/channels/${channelId}/read`, { method: 'POST' }).catch(() => {});

  renderSidebar();
  await loadChannelMessages(channelId);
  await loadReadReceipts(channelId);
}

function renderSkeleton(container) {
  container.innerHTML = `
    <div class="msg-skeleton">
      <div class="sk-row"><div class="sk-avatar"></div><div class="sk-lines"><div class="sk-line sk-line-sm"></div><div class="sk-line sk-line-lg"></div></div></div>
      <div class="sk-row"><div class="sk-avatar"></div><div class="sk-lines"><div class="sk-line sk-line-md"></div><div class="sk-line sk-line-lg"></div></div></div>
      <div class="sk-row"><div class="sk-avatar"></div><div class="sk-lines"><div class="sk-line sk-line-sm"></div><div class="sk-line sk-line-md"></div></div></div>
    </div>`;
}

async function loadChannelMessages(channelId) {
  const container = document.getElementById('messages');
  renderSkeleton(container);
  try {
    const res = await api(`/api/messages/${channelId}?limit=100`);
    const data = await res.json();

    if (!res.ok) throw new Error(data.error || 'Failed to load messages');

    state.messages[channelId] = data.messages;
    renderMessages('messages', data.messages);
  } catch (err) {
    console.error('Load messages error:', err);
    container.innerHTML = `<div class="empty-state" style="justify-content:flex-start; padding-top:20px;"><h2>Could not load messages</h2><p style="color:var(--text-muted);">Check that the server is running.</p></div>`;
  }
}

async function loadReadReceipts(channelId) {
  try {
    const res = await api(`/api/channels/${channelId}/read-receipts`);
    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || 'Failed to load read receipts');
    }

    state.readReceipts[channelId] = data.users || [];
    renderReadReceipts(channelId);
  } catch (err) {
    console.error('Load read receipts error:', err);
    state.readReceipts[channelId] = [];
    renderReadReceipts(channelId);
  }
}

function renderReadReceipts(channelId) {
  const container = document.getElementById('channel-read-receipts');
  if (!container) return;

  const users = state.readReceipts[channelId] || [];
  if (!users.length) {
    container.textContent = 'No read receipts yet';
    container.style.display = 'none';
    return;
  }

  const visibleUsers = users.slice(0, 4);
  const names = visibleUsers.map((u) => u.username).join(', ');
  const more = users.length > visibleUsers.length ? ` +${users.length - visibleUsers.length} more` : '';

  container.style.display = 'flex';
  container.innerHTML = `
    <div class="read-receipt-avatars">
      ${visibleUsers.map((u) => `<span class="read-receipt-avatar" title="${escapeHtml(u.username)}" style="background:${escapeHtml(u.avatarColor || '#A855F7')};">${escapeHtml((u.username || 'U').charAt(0).toUpperCase())}</span>`).join('')}
    </div>
    <span class="read-receipt-text">Seen by ${escapeHtml(names)}${escapeHtml(more)}</span>
  `;
}

// ============================================================
// Direct Messages
// ============================================================
async function loadUsers() {
  try {
    const res = await api('/api/users');
    const data = await res.json();

    if (!res.ok) throw new Error(data.error || 'Failed to load users');

    state.dms = data.users.filter(u => u.id !== state.user.id);
    renderDmList();
  } catch (err) {
    console.error('Load users error:', err);
  }
}

// Presence: map backend status to a dot color and label
function presenceColor(status) {
  if (status === 'online') return 'var(--success)';
  if (status === 'away') return '#F59E0B';
  return '#9CA3AF'; // offline / unknown
}

function presenceLabel(status) {
  if (!status) return 'offline';
  return status;
}

function renderDmList() {
  els.dmList.innerHTML = '';

  state.dms.forEach((dm) => {
    const active = state.currentDMId === dm.id && state.section === 'dms';
    const item = document.createElement('div');
    item.className = 'nav-item' + (active ? ' active' : '');
    const color = presenceColor(dm.status);
    const slabel = presenceLabel(dm.status);
    item.innerHTML = `
      <div class="dot" style="background:${color};" title="${escapeHtml(slabel)}"></div>
      <span>${escapeHtml(dm.username)}</span>
      <span style="margin-left:auto; font-size:11px; opacity:0.6;">${escapeHtml(slabel)}</span>
    `;
    item.onclick = (e) => { e.stopPropagation(); openDM(dm.id); };
    els.dmList.appendChild(item);
  });
}

async function openDM(userId) {
  state.currentDMId = userId;
  state.currentChannelId = null;
  state.currentThreadId = null;
  state.view = 'dm';
  state.section = 'dms';
  closeThreadPanel();
  updateRail('dms');
  showPane('dms');
  showView('dm');

  const user = state.dms.find(u => u.id === userId);
  if (user) {
    els.dmTitle.textContent = user.username;
    els.dmTopic.textContent = `Direct message with ${user.username}`;
  }

  renderSidebar();
  await loadDmMessages(userId);
}

async function loadDmMessages(userId) {
  const container = document.getElementById('dm-messages');
  renderSkeleton(container);
  try {
    const res = await api(`/api/users/${userId}/direct-messages?limit=100`);
    const data = await res.json();

    if (!res.ok) throw new Error(data.error || 'Failed to load DMs');

    state.directMessages[userId] = data.messages;
    renderMessages('dm-messages', data.messages);
  } catch (err) {
    console.error('Load DMs error:', err);
    container.innerHTML = `<div class="empty-state" style="justify-content:flex-start; padding-top:20px;"><h2>Could not load messages</h2><p style="color:var(--text-muted);">Check that the server is running.</p></div>`;
  }
}

// ============================================================
// Toasts (non-blocking notifications)
// ============================================================
function showToast(text, type) {
  const stack = document.getElementById('toast-stack');
  if (!stack) {
    console.warn('toast-stack missing; message:', text);
    return;
  }
  const el = document.createElement('div');
  el.className = 'toast' + (type ? ' ' + type : '');
  el.textContent = text;
  stack.appendChild(el);
  setTimeout(() => {
    el.remove();
  }, 4200);
}

// ============================================================
// Messages
// ============================================================
function renderMessages(containerId, messages) {
  const container = document.getElementById(containerId);
  container.innerHTML = '';

  if (!messages || messages.length === 0) {
    container.innerHTML = `
      <div class="empty-state" style="justify-content:flex-start; padding-top:20px;">
        <div class="big" style="color:var(--text-muted); opacity:1; display:inline-flex;"><svg viewBox="0 0 24 24" width="44" height="44" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg></div>
        <h2>No messages yet</h2>
        <p style="color:var(--text-muted);">Send the first message.</p>
      </div>`;
    return;
  }

  let lastDate = null;
  messages.forEach((msg) => {
    const msgDate = new Date(msg.createdAt).toDateString();
    if (msgDate !== lastDate) {
      lastDate = msgDate;
      const sep = document.createElement('div');
      sep.className = 'date-sep';
      sep.textContent = new Date(msg.createdAt).toLocaleDateString(undefined, {
        weekday: 'long', month: 'long', day: 'numeric',
      });
      container.appendChild(sep);
    }
    container.appendChild(renderMessageEl(msg));
  });

  container.scrollTop = container.scrollHeight;
}

function renderMessageEl(msg) {
  const isYou = msg.userId === state.user.id;
  const avatarColor = msg.avatarColor || '#A855F7';
  const initials = (msg.username || 'U').charAt(0).toUpperCase();

  const el = document.createElement('div');
  el.className = 'message';

  const reactionsHtml = (msg.reactions || []).map((r) => {
    const hasMe = r.users && r.users.includes(state.user.id);
    return `<div class="reaction${hasMe ? ' me' : ''}" onclick="app.addReaction('${escapeHtml(msg.id)}', '${escapeHtml(r.emoji)}')">
      ${r.emoji}<span class="count">${r.count}</span>${hasMe ? '<span class="remove">✕</span>' : ''}
    </div>`;
  }).join('');

  const attachmentsHtml = (msg.attachments || []).map((a) => `
    <div class="attachment" data-file-id="${escapeHtml(String(a.id))}" data-file-name="${escapeHtml(a.filename)}" role="button" tabindex="0" title="Download ${escapeHtml(a.filename)}">
      <div class="icon">${fileIconSvg(fileIcon(a.mimeType))}</div>
      <div class="info">
        <div class="name">${escapeHtml(a.filename)}</div>
        <div class="size">${escapeHtml(humanSize(a.size))}</div>
      </div>
    </div>`).join('');

  el.innerHTML = `
    <div class="avatar-mini" style="background:${avatarColor};">${initials}</div>
    <div class="message-body">
      <div class="message-header">
        <span class="name">${escapeHtml(msg.username)}</span>
        ${isYou ? '<span class="you">You</span>' : ''}
        <span class="time">${shortTime(msg.createdAt)}</span>
        ${msg.replyCount > 0 ? `<a class="thread-badge" onclick="app.openThread('${escapeHtml(msg.id)}')">${msg.replyCount} reply${msg.replyCount === 1 ? '' : 's'}</a>` : ''}
      </div>
      <div class="message-text">${escapeHtml(msg.content)}</div>
      ${attachmentsHtml ? `<div class="attachments">${attachmentsHtml}</div>` : ''}
      <div class="message-actions">
        <a onclick="app.addReaction('${escapeHtml(msg.id)}', '👍')">React</a>
        <a onclick="app.openThread('${escapeHtml(msg.id)}')">Thread</a>
      </div>
      <div class="reactions">${reactionsHtml}</div>
    </div>`;

  el.querySelectorAll('.attachment').forEach((node) => {
    const go = () => downloadFile(node.dataset.fileId, node.dataset.fileName);
    node.addEventListener('click', go);
    node.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); }
    });
  });

  return el;
}

function shortTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  const diff = now - d;
  if (diff < 3600000) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":"&#39;" }[c]));
}

// ============================================================
// Sending Messages
// ============================================================
async function sendChannelMessage() {
  const text = els.messageInput.value.trim();
  if (!text) return;

  try {
    const res = await state.socket.emitWithAck ? null : null;
    // Use socket for real-time
    state.socket.emit('send_message', {
      channelId: state.currentChannelId,
      content: text,
    });
    els.messageInput.value = '';
  } catch (err) {
    console.error('Send message error:', err);
  }
}

async function sendDmMessage() {
  const text = els.dmMessageInput.value.trim();
  if (!text || !state.currentDMId) return;

  try {
    state.socket.emit('send_direct_message', {
      receiverId: state.currentDMId,
      content: text,
    });
    els.dmMessageInput.value = '';
  } catch (err) {
    console.error('Send DM error:', err);
  }
}

async function sendThreadReply() {
  const text = els.threadInput.value.trim();
  if (!text || !state.currentThreadId) return;

  try {
    const res = await api(`/api/messages/${state.currentThreadId}/replies`, {
      method: 'POST',
      body: JSON.stringify({ content: text }),
    });

    if (!res.ok) throw new Error('Failed to send reply');

    els.threadInput.value = '';
    loadThread(state.currentThreadId);
  } catch (err) {
    console.error('Send thread reply error:', err);
  }
}

// ============================================================
// Threads
// ============================================================
function openThread(messageId) {
  state.currentThreadId = messageId;
  const panel = document.getElementById('thread-panel');
  panel.classList.remove('closed');
  els.threadInput.value = '';
  loadThread(messageId);
}

function closeThreadPanel() {
  state.currentThreadId = null;
  document.getElementById('thread-panel').classList.add('closed');
}

async function loadThread(messageId) {
  try {
    const res = await api(`/api/messages/${messageId}/replies`);
    const data = await res.json();

    if (!res.ok) throw new Error(data.error || 'Failed to load thread');

    renderThreadMessages(data.replies);
  } catch (err) {
    console.error('Load thread error:', err);
  }
}

function renderThreadMessages(replies) {
  els.threadMessages.innerHTML = '';
  els.threadCount.textContent = `${replies.length} reply${replies.length === 1 ? '' : 's'}`;

  if (replies.length === 0) {
    els.threadMessages.innerHTML = '<div style="padding:16px 0; color:var(--text-muted); font-size:13px;">No replies yet.</div>';
    return;
  }

  replies.forEach((msg) => {
    const isYou = msg.userId === state.user.id;
    const el = document.createElement('div');
    el.className = 'message';
    el.innerHTML = `
      <div class="avatar-mini" style="width:26px;height:26px;font-size:11px;">${(msg.username||'U').charAt(0).toUpperCase()}</div>
      <div class="message-body" style="max-width:100%;">
        <div class="message-header">
          <span class="name" style="font-size:13px;">${escapeHtml(msg.username)}</span>
          ${isYou ? '<span class="you">You</span>' : ''}
          <span class="time" style="font-size:10px;">${shortTime(msg.createdAt)}</span>
        </div>
        <div class="message-text" style="font-size:13px;">${escapeHtml(msg.content)}</div>
      </div>`;
    els.threadMessages.appendChild(el);
  });

  els.threadMessages.scrollTop = els.threadMessages.scrollHeight;
}

// ============================================================
// Reactions
// ============================================================
async function addReaction(messageId, emoji) {
  try {
    const res = await api(`/api/messages/${messageId}/reactions`, {
      method: 'POST',
      body: JSON.stringify({ emoji }),
    });

    if (!res.ok) throw new Error('Failed to add reaction');

    // Reload current messages to update reaction counts
    if (state.currentChannelId) {
      await loadChannelMessages(state.currentChannelId);
    }
    if (state.currentDMId) {
      await loadDmMessages(state.currentDMId);
    }
    if (state.currentThreadId) {
      await loadThread(state.currentThreadId);
    }
  } catch (err) {
    console.error('Add reaction error:', err);
  }
}

// ============================================================
// File Attachments
// ============================================================
async function handleFilePick(e) {
  const files = e.target.files;
  if (!files || files.length === 0) return;

  const file = files[0];
  const formData = new FormData();
  formData.append('file', file);

  try {
    const res = await fetch(`${API_BASE}/api/messages/upload`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${state.token}` },
      body: formData,
    });

    const data = await res.json();

    if (!res.ok) throw new Error(data.error || 'Upload failed');

    // Send message with attachment
    state.socket.emit('send_message', {
      channelId: state.currentChannelId,
      content: '',
      attachmentId: data.fileId,
    });

    e.target.value = '';
  } catch (err) {
    console.error('File upload error:', err);
    showToast('File upload failed. Is the server running?', 'error');
  }
}

async function handleDmFilePick(e) {
  const files = e.target.files;
  if (!files || files.length === 0) return;

  const file = files[0];
  const formData = new FormData();
  formData.append('file', file);

  try {
    const res = await fetch(`${API_BASE}/api/messages/upload`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${state.token}` },
      body: formData,
    });

    const data = await res.json();

    if (!res.ok) throw new Error(data.error || 'Upload failed');

    state.socket.emit('send_direct_message', {
      receiverId: state.currentDMId,
      content: '',
      attachmentId: data.fileId,
    });

    e.target.value = '';
  } catch (err) {
    console.error('DM file upload error:', err);
    showToast('File upload failed. Is the server running?', 'error');
  }
}

// ============================================================
// Sections, rail and menus
// ============================================================
const SECTIONS = {
  home:     { pane: 'home',     view: 'channel' },
  dms:      { pane: 'dms',      view: 'dm' },
  activity: { pane: null,       view: 'activity' },
  files:    { pane: null,       view: 'files' },
  notes:    { pane: null,       view: 'notes' },
  huddle:   { pane: null,       view: 'huddle' },
};

function updateRail(section) {
  document.querySelectorAll('.rail-item[data-rail]').forEach((btn) => {
    const on = btn.dataset.rail === section;
    btn.classList.toggle('active', on);
    if (on) btn.setAttribute('aria-current', 'page');
    else btn.removeAttribute('aria-current');
  });
}

function showView(view) {
  document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
  const el = document.getElementById('view-' + view);
  if (el) el.classList.add('active');
}

function showPane(pane) {
  if (!els.pane) return;
  if (!pane) {
    els.pane.classList.add('collapsed');
    return;
  }
  els.pane.classList.remove('collapsed');
  if (els.paneHome) els.paneHome.hidden = pane !== 'home';
  if (els.paneDms) els.paneDms.hidden = pane !== 'dms';
  if (els.paneActivity) els.paneActivity.hidden = pane !== 'activity';
  if (els.paneTitle) {
    els.paneTitle.textContent = pane === 'home' ? 'Home' : pane === 'dms' ? 'Direct Messages' : 'Activity';
  }
  const paneAction = document.getElementById('btn-pane-action');
  if (paneAction) paneAction.style.display = pane === 'home' ? 'flex' : 'none';
}

async function setSection(section) {
  const def = SECTIONS[section] || SECTIONS.home;
  state.section = section;
  state.currentThreadId = null;
  closeThreadPanel();
  updateRail(section);
  showPane(def.pane);
  showView(def.view);

  if (section === 'home') {
    if (state.currentChannelId) await loadChannelMessages(state.currentChannelId);
    els.messageInput?.focus();
  } else if (section === 'dms') {
    if (state.currentDMId) {
      await loadDmMessages(state.currentDMId);
    } else if (state.dms.length > 0) {
      await openDM(state.dms[0].id);
    }
  } else if (section === 'files') {
    await loadFiles();
  } else if (section === 'notes') {
    await loadNotes();
  } else if (section === 'activity') {
    renderActivity();
  }
}

function renderActivity() {
  const unread = state.channels.filter((c) => (c.unreadCount || 0) > 0);
  const grid = els.activityGrid;
  if (grid) {
    if (unread.length === 0) {
      grid.innerHTML = `
        <div class="empty-state" style="padding:32px;">
          <h2>You are all caught up</h2>
          <p style="color:var(--text-muted);">Channels with unread messages will appear here.</p>
        </div>`;
    } else {
      grid.innerHTML = '';
      unread.forEach((ch) => {
        const card = document.createElement('div');
        card.className = 'card';
        card.innerHTML = `
          <div class="title">#${escapeHtml(ch.name)}</div>
          <div class="meta">${ch.unreadCount} unread message${ch.unreadCount === 1 ? '' : 's'}</div>
          <div class="meta">${escapeHtml(ch.topic || '')}</div>`;
        card.onclick = () => openChannel(ch.id);
        grid.appendChild(card);
      });
    }
  }

  if (els.activityList) {
    els.activityList.innerHTML = '';
    if (unread.length === 0) {
      els.activityList.innerHTML = '<div class="empty-state" style="padding:16px; color:var(--text-muted); font-size:13px;">No unread channels.</div>';
    } else {
      unread.forEach((ch) => {
        const item = document.createElement('div');
        item.className = 'nav-item';
        item.innerHTML = `<span>#</span><span>${escapeHtml(ch.name)}</span><span class="unread-badge">${ch.unreadCount}</span>`;
        item.onclick = () => openChannel(ch.id);
        els.activityList.appendChild(item);
      });
    }
  }

  const badge = document.getElementById('activity-badge');
  const total = state.channels.reduce((sum, c) => sum + (c.unreadCount || 0), 0);
  if (badge) {
    if (total > 0) {
      badge.hidden = false;
      badge.textContent = total > 99 ? '99+' : String(total);
    } else {
      badge.hidden = true;
    }
  }
}

function closeAllMenus() {
  let closed = false;
  document.querySelectorAll('.menu.open').forEach((m) => {
    m.classList.remove('open');
    closed = true;
  });
  document.querySelectorAll('#app-menu .has-submenu.open').forEach((t) => {
    t.classList.remove('open');
    t.setAttribute('aria-expanded', 'false');
    closed = true;
  });
  ['btn-create', 'btn-user-menu', 'btn-app-menu'].forEach((id) => {
    document.getElementById(id)?.setAttribute('aria-expanded', 'false');
  });
  return closed;
}

function toggleMenu(menuId, buttonId) {
  const menu = document.getElementById(menuId);
  if (!menu) return;
  const wasOpen = menu.classList.contains('open');
  closeAllMenus();
  if (!wasOpen) {
    menu.classList.add('open');
    document.getElementById(buttonId)?.setAttribute('aria-expanded', 'true');
  }
}

function handleCreate(kind) {
  if (kind === 'message') {
    setSection('home');
    els.messageInput?.focus();
  } else if (kind === 'channel') {
    openCreateChannelModal();
  } else if (kind === 'huddle') {
    setSection('huddle');
  } else if (kind === 'canvas') {
    showToast('Canvas is not implemented yet.', 'error');
  } else if (kind === 'list') {
    showToast('Lists are not implemented yet.', 'error');
  }
}

function handleAccountAction(action) {
  if (action === 'signout') {
    handleLogout();
    return;
  }
  if (action === 'profile') {
    showToast(`Signed in as ${state.user?.username || 'unknown'}. Profile editing is not implemented yet.`);
  } else if (action === 'preferences') {
    showToast('Preferences are not implemented yet.');
  } else if (action === 'account') {
    showToast('Account settings are not implemented yet.');
  }
}

function handleAppCommand(cmd) {
  switch (cmd) {
    case 'new-message':
      setSection('home');
      els.messageInput?.focus();
      break;
    case 'new-channel':
      openCreateChannelModal();
      break;
    case 'new-note':
      openNoteEditor(null);
      break;
    case 'sign-out':
      handleLogout();
      break;
    case 'shortcuts':
      showToast('Ctrl+K search · Ctrl+N new message · Esc closes panels');
      break;
    case 'about':
      showToast(`IT Avenue Workspace · Electron ${window.electronAPI?.getAppVersion?.() || ''}`);
      break;
    default:
      // Everything else maps to a main-process command:
      // undo, redo, cut, copy, paste, delete, select-all, reload, force-reload,
      // devtools, zoom-in, zoom-out, zoom-reset, fullscreen, minimize,
      // toggle-maximize, close-window, quit.
      window.electronAPI?.appCommand?.(cmd);
      break;
  }
}

// ============================================================
// Files view
// ============================================================
function fileIcon(mimeType) {
  const t = (mimeType || '').toLowerCase();
  if (t.startsWith('image/')) return 'image';
  if (t === 'application/pdf') return 'pdf';
  if (t.includes('zip') || t.includes('compressed')) return 'archive';
  return 'file';
}

function fileIconSvg(kind) {
  const base = 'viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"';
  if (kind === 'image') return `<svg ${base}><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>`;
  if (kind === 'pdf') return `<svg ${base}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="15" y2="17"/></svg>`;
  if (kind === 'archive') return `<svg ${base}><path d="M21 8v13H3V8"/><path d="M1 3h22v5H1z"/><line x1="10" y1="12" x2="14" y2="12"/></svg>`;
  return `<svg ${base}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`;
}

function humanSize(bytes) {
  if (!bytes && bytes !== 0) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

async function loadFiles() {
  const grid = els.filesGrid;
  if (!grid) return;
  grid.innerHTML = '<div class="empty-state" style="padding:24px;">Loading files…</div>';
  try {
    const res = await api('/api/files');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to load files');
    renderFiles(data.files || []);
  } catch (err) {
    console.error('Load files error:', err);
    grid.innerHTML = `<div class="empty-state" style="padding:24px;"><h2>Could not load files</h2><p style="color:var(--text-muted);">Check that the server is running.</p></div>`;
  }
}

function renderFiles(files) {
  const grid = els.filesGrid;
  if (!grid) return;
  if (!files.length) {
    grid.innerHTML = `
      <div class="empty-state" style="padding:32px;">
        <h2>No files yet</h2>
        <p style="color:var(--text-muted);">Files you attach to messages appear here.</p>
      </div>`;
    return;
  }
  grid.innerHTML = '';
  files.forEach((f) => {
    const card = document.createElement('div');
    card.className = 'card file-card';
    const where = f.channelName ? '#' + f.channelName : 'Direct message';
    card.innerHTML = `
      <div class="preview file-preview-icon">${fileIconSvg(fileIcon(f.mimeType))}</div>
      <div class="title" title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</div>
      <div class="meta">${escapeHtml(humanSize(f.size))} · ${escapeHtml(where)}</div>
      <div class="meta">Shared by ${escapeHtml(f.uploaderUsername)} · ${shortTime(f.uploadedAt)}</div>
    `;
    card.onclick = () => downloadFile(f.id, f.name);
    grid.appendChild(card);
  });
}

async function downloadFile(fileId, name) {
  try {
    const res = await fetch(`${API_BASE}/api/files/${fileId}/download`, {
      headers: { 'Authorization': `Bearer ${state.token}` },
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'Download failed');
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name || 'download';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  } catch (err) {
    console.error('Download file error:', err);
    showToast('Could not download file.', 'error');
  }
}

// ============================================================
// Notes view
// ============================================================
let notesCache = [];

async function loadNotes() {
  const grid = els.notesGrid;
  if (!grid) return;
  grid.innerHTML = '<div class="empty-state" style="padding:24px;">Loading notes…</div>';
  try {
    const res = await api('/api/notes');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to load notes');
    notesCache = data.notes || [];
    renderNotes(notesCache);
  } catch (err) {
    console.error('Load notes error:', err);
    grid.innerHTML = `<div class="empty-state" style="padding:24px;"><h2>Could not load notes</h2><p style="color:var(--text-muted);">Check that the server is running.</p></div>`;
  }
}

function renderNotes(notes) {
  const grid = els.notesGrid;
  if (!grid) return;
  if (!notes.length) {
    grid.innerHTML = `
      <div class="empty-state" style="padding:32px;">
        <h2>No notes yet</h2>
        <p style="color:var(--text-muted);">Use "New note" to write something down.</p>
      </div>`;
    return;
  }
  grid.innerHTML = '';
  notes.forEach((n) => {
    const card = document.createElement('div');
    card.className = 'card note-card';
    const preview = (n.content || '').split('\n').slice(0, 2).join(' ');
    card.innerHTML = `
      <div class="title">${escapeHtml(n.title)}</div>
      <div class="meta">${escapeHtml(preview || 'Empty note')}</div>
      <div class="meta">Updated ${shortTime(n.updatedAt)}</div>
      <div class="note-actions">
        <button class="btn-note-delete" title="Delete note" aria-label="Delete note">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>
        </button>
      </div>
    `;
    card.onclick = () => openNoteEditor(n);
    card.querySelector('.btn-note-delete').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm(`Delete note "${n.title}"?`)) return;
      try {
        const res = await api(`/api/notes/${n.id}`, { method: 'DELETE' });
        if (!res.ok) throw new Error('Delete failed');
        await loadNotes();
        showToast('Note deleted.', 'success');
      } catch (err) {
        console.error('Delete note error:', err);
        showToast('Could not delete note.', 'error');
      }
    });
    grid.appendChild(card);
  });
}

function openNoteEditor(note) {
  const editor = document.getElementById('note-editor');
  const titleInput = document.getElementById('note-title-input');
  const bodyInput = document.getElementById('note-body-input');
  if (!editor) return;
  editor.dataset.noteId = note ? note.id : '';
  document.getElementById('note-editor-title').textContent = note ? 'Edit note' : 'New note';
  titleInput.value = note ? note.title : '';
  bodyInput.value = note ? note.content : '';
  editor.classList.add('open');
  document.getElementById('modal-overlay').classList.add('open');
  setTimeout(() => titleInput.focus(), 40);
}

function closeNoteEditor() {
  const editor = document.getElementById('note-editor');
  if (editor) editor.classList.remove('open');
  document.getElementById('modal-overlay').classList.remove('open');
}

async function saveNoteFromEditor() {
  const editor = document.getElementById('note-editor');
  const title = document.getElementById('note-title-input').value.trim() || 'Untitled';
  const content = document.getElementById('note-body-input').value;
  const id = editor.dataset.noteId;
  try {
    const res = await api(id ? `/api/notes/${id}` : '/api/notes', {
      method: id ? 'PUT' : 'POST',
      body: JSON.stringify({ title, content }),
    });
    if (!res.ok) throw new Error('Save failed');
    closeNoteEditor();
    await loadNotes();
    showToast(id ? 'Note updated.' : 'Note created.', 'success');
  } catch (err) {
    console.error('Save note error:', err);
    showToast('Could not save note.', 'error');
  }
}

// ============================================================
// Channel Creation Modal
// ============================================================
function openCreateChannelModal() {
  document.getElementById('modal-create-channel').classList.add('open');
  document.getElementById('modal-overlay').classList.add('open');
}

function closeModalCreateChannel() {
  document.getElementById('modal-create-channel').classList.remove('open');
  document.getElementById('modal-overlay').classList.remove('open');
}

async function saveCreateChannel() {
  const name = document.getElementById('new-channel-name').value.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const topic = document.getElementById('new-channel-topic').value.trim();

  if (!name) return;

  try {
    const res = await api('/api/channels', {
      method: 'POST',
      body: JSON.stringify({ name, topic }),
    });

    if (!res.ok) throw new Error('Failed to create channel');

    const data = await res.json();
    closeModalCreateChannel();
    document.getElementById('new-channel-name').value = '';
    document.getElementById('new-channel-topic').value = '';

    await loadChannels();
    openChannel(data.channel.id);
  } catch (err) {
    console.error('Create channel error:', err);
    showToast('Failed to create channel.', 'error');
  }
}

// ============================================================
// Expose to window for inline HTML onclick
// ============================================================
window.app = {
  addReaction,
  openThread,
  closeThreadPanel,
};

// Start
init();
