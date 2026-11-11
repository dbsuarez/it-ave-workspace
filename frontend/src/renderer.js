// IT Avenue Workspace - Renderer (Main Chat Window)
// Handles UI, Socket.io connection, and all chat interactions

// electronAPI is exposed on window by the preload (contextBridge)
// Reference it directly - re-declaring it triggers a global parse error
// ("Identifier 'electronAPI' has already been declared"), which kills the
// renderer before any handler is attached.

// Configuration
const API_BASE = 'http://127.0.0.1:3001'; // Change to your deployed URL
const SOCKET_URL = 'http://127.0.0.1:3001';
const REACTION_EMOJI = {
  Smileys: [
    ['😀', 'grinning'], ['😃', 'smiley'], ['😄', 'smile'], ['😁', 'grin'], ['😆', 'laughing'],
    ['😅', 'sweat smile'], ['😂', 'joy'], ['🤣', 'rolling laugh'], ['🙂', 'slightly smiling'],
    ['😉', 'wink'], ['😊', 'blush'], ['😍', 'heart eyes'], ['🥰', 'love'], ['😘', 'kiss'],
    ['😋', 'yum'], ['😎', 'cool'], ['🤔', 'thinking'], ['🫡', 'salute'], ['🤗', 'hug'],
    ['🤩', 'star struck'], ['🥳', 'party'], ['😴', 'sleep'], ['😭', 'cry'], ['😤', 'frustrated'],
    ['😱', 'scream'], ['🙄', 'rolling eyes'], ['🤯', 'mind blown'], ['😬', 'grimace'],
    ['🤷', 'shrug'], ['🙏', 'please thanks'], ['👏', 'clap'], ['🙌', 'celebrate'],
  ],
  People: [
    ['👍', 'thumbs up'], ['👎', 'thumbs down'], ['👋', 'wave'], ['🤝', 'handshake'],
    ['💪', 'strong'], ['🫶', 'heart hands'], ['🤞', 'fingers crossed'], ['✌️', 'peace'],
    ['👌', 'ok'], ['👀', 'eyes'], ['💃', 'dance'], ['🕺', 'dancer'], ['🧑‍💻', 'developer'],
  ],
  Nature: [
    ['❤️', 'red heart'], ['🧡', 'orange heart'], ['💛', 'yellow heart'], ['💚', 'green heart'],
    ['💙', 'blue heart'], ['💜', 'purple heart'], ['🖤', 'black heart'], ['🤍', 'white heart'],
    ['💔', 'broken heart'], ['🔥', 'fire'], ['⭐', 'star'], ['✨', 'sparkles'], ['🌈', 'rainbow'],
    ['☀️', 'sun'], ['🌙', 'moon'], ['🌱', 'seedling'], ['🌻', 'sunflower'], ['🐱', 'cat'],
    ['🐶', 'dog'], ['🦄', 'unicorn'],
  ],
  Food: [
    ['☕', 'coffee'], ['🍵', 'tea'], ['🍕', 'pizza'], ['🍔', 'burger'], ['🍟', 'fries'],
    ['🌮', 'taco'], ['🍰', 'cake'], ['🎂', 'birthday cake'], ['🍩', 'donut'], ['🍪', 'cookie'],
    ['🍎', 'apple'], ['🍉', 'watermelon'], ['🥑', 'avocado'], ['🍺', 'beer'], ['🍻', 'cheers'],
  ],
  Activities: [
    ['🎉', 'party popper'], ['🎊', 'confetti'], ['🎈', 'balloon'], ['🏆', 'trophy'],
    ['🥇', 'gold medal'], ['⚽', 'soccer'], ['🏀', 'basketball'], ['🎮', 'game'], ['🎵', 'music'],
    ['🎯', 'target'], ['🚀', 'rocket'], ['💡', 'idea'], ['✅', 'check'], ['❌', 'cross'],
    ['💯', 'hundred'], ['💰', 'money'], ['📈', 'chart up'],
  ],
  Symbols: [
    ['👍🏻', 'light skin thumbs up'], ['👍🏼', 'medium light skin thumbs up'],
    ['👍🏽', 'medium skin thumbs up'], ['👍🏾', 'medium dark skin thumbs up'],
    ['👍🏿', 'dark skin thumbs up'], ['✔️', 'check mark'], ['❓', 'question'],
    ['❗', 'exclamation'], ['💬', 'speech bubble'], ['🔔', 'bell'], ['🔒', 'lock'],
    ['♻️', 'recycle'], ['⚡', 'lightning'], ['➕', 'plus'], ['🚩', 'flag'],
  ],
};

// State
let state = {
  token: null,
  user: null,
  channels: [],
  users: [],
  dms: [],
  usersLoaded: false,
  messages: {},       // channelId -> []
  pinnedMessages: {}, // channelId -> []
  pinPanelOpen: false,
  directMessages: {}, // userId -> []
  replyingTo: null,
  readReceipts: {},   // channelId -> [{id, username, avatarColor, readAt}]
  currentChannelId: null,
  currentDMId: null,
  view: 'channel',
  section: 'home',
  socket: null,
  socketAuthenticated: false,
  searchTimer: null,
  searchRequestId: 0,
  searchActiveIndex: -1,
  preferences: {
    theme: 'light',
    enterToSend: true,
  },
  huddle: {
    channelId: null,
    localStream: null,
    peers: new Map(),
    participants: new Map(),
    iceServers: [],
    joining: false,
    joinAttempt: 0,
    muted: false,
    status: 'Choose a channel and join to start an audio huddle.',
    statusType: '',
  },
  files: [],
  moderation: { isSuperadmin: false, moderatorChannelIds: [], channel: null, settings: null },
  notes: [],
  lists: [],
  listMembers: [],
  listsRequestId: 0,
  canvases: [],
  currentCanvasId: null,
  canvasChannelId: null,
  canvasDirty: false,
  canvasRequestId: 0,
  canvasDetailRequestId: 0,
  emojiPicker: { messageId: null, category: 'Smileys' },
};

// DOM elements
const els = {
  loginCard: document.querySelector('.login-card'),
  app: document.querySelector('.app'),
  viewChannel: document.getElementById('view-channel'),
  viewDm: document.getElementById('view-dm'),
  viewFiles: document.getElementById('view-files'),
  viewNotes: document.getElementById('view-notes'),
  viewLists: document.getElementById('view-lists'),
  viewCanvases: document.getElementById('view-canvases'),
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
  replyComposerPreview: document.getElementById('reply-composer-preview'),
  replyPreviewAuthor: document.getElementById('reply-preview-author'),
  replyPreviewContent: document.getElementById('reply-preview-content'),
  globalSearch: document.getElementById('global-search'),
  searchResults: document.getElementById('search-results'),
  filePicker: document.getElementById('file-picker'),
  dmFilePicker: document.getElementById('dm-file-picker'),
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
  profileModal: document.getElementById('modal-profile'),
  preferencesModal: document.getElementById('modal-preferences'),
  accountModal: document.getElementById('modal-account'),
  filesGrid: document.getElementById('files-grid'),
  notesGrid: document.getElementById('notes-grid'),
  listsChannelSelect: document.getElementById('lists-channel-select'),
  listsContainer: document.getElementById('lists-container'),
  canvasChannelSelect: document.getElementById('canvas-channel-select'),
  canvasDocList: document.getElementById('canvas-doc-list'),
  canvasEditorForm: document.getElementById('canvas-editor-form'),
  canvasTitleInput: document.getElementById('canvas-title-input'),
  canvasContentInput: document.getElementById('canvas-content-input'),
  canvasPreview: document.getElementById('canvas-preview'),
  canvasEmptyState: document.getElementById('canvas-empty-state'),
  emojiPicker: document.getElementById('emoji-picker'),
  emojiSearch: document.getElementById('emoji-search'),
  emojiPickerCategories: document.getElementById('emoji-picker-categories'),
  emojiPickerGrid: document.getElementById('emoji-picker-grid'),
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
    loadModerationAccess();
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

  // Global: Ctrl/Cmd+K focuses search, Esc closes menus and modals
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
      if (els.emojiPicker && !els.emojiPicker.hidden) { closeEmojiPicker(); return; }
      if (state.replyingTo) { cancelReply(); return; }
      const noteEditor = document.getElementById('note-editor');
      if (noteEditor && noteEditor.classList.contains('open')) { closeNoteEditor(); return; }
      const modalCreate = document.getElementById('modal-create-channel');
      if (modalCreate && modalCreate.classList.contains('open')) { closeModalCreateChannel(); return; }
      const modalOverlay = document.getElementById('modal-overlay');
      if (modalOverlay && modalOverlay.classList.contains('open')) {
        closeSettingsModal();
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
  on('btn-help', 'click', () => showToast('Ctrl+K searches. Esc cancels a reply or closes menus.', undefined));

  // Window controls (frameless window)
  on('btn-win-min', 'click', () => window.electronAPI?.appCommand?.('minimize'));
  on('btn-win-max', 'click', () => window.electronAPI?.appCommand?.('toggle-maximize'));
  on('btn-win-close', 'click', () => window.electronAPI?.appCommand?.('close-window'));
  document.querySelector('.topbar-brand')?.addEventListener('dblclick', () => {
    window.electronAPI?.appCommand?.('toggle-maximize');
  });

  // Close menus when clicking elsewhere
  document.addEventListener('click', (event) => {
    closeAllMenus();
    if (!event.target.closest('.search-box')) hideSearchResults();
    if (!event.target.closest('.emoji-picker') && !event.target.closest('[data-open-reactions]')) {
      closeEmojiPicker();
    }
  });

  on('global-search', 'input', handleGlobalSearchInput);
  on('global-search', 'keydown', handleGlobalSearchKeydown);
  els.searchResults?.addEventListener('click', (event) => {
    const result = event.target.closest('.search-result');
    if (result) activateSearchResult(result);
  });

  // Channel creation
  on('btn-create-channel', 'click', openCreateChannelModal);
  on('btn-pane-action', 'click', openCreateChannelModal);
  on('btn-save-create', 'click', saveCreateChannel);
  on('btn-cancel-create', 'click', closeModalCreateChannel);
  on('btn-close-create-channel', 'click', closeModalCreateChannel);

  on('btn-cancel-reply', 'click', cancelReply);
  on('profile-form', 'submit', saveProfile);
  on('preferences-form', 'submit', savePreferences);
  on('account-form', 'submit', saveAccountSettings);
  on('btn-close-profile', 'click', closeSettingsModal);
  on('btn-cancel-profile', 'click', closeSettingsModal);
  on('btn-close-preferences', 'click', closeSettingsModal);
  on('btn-cancel-preferences', 'click', closeSettingsModal);
  on('btn-close-account', 'click', closeSettingsModal);
  on('btn-cancel-account', 'click', closeSettingsModal);
  on('modal-overlay', 'click', closeSettingsModal);

  // Views
  on('btn-huddle-close', 'click', async () => {
    await cleanupHuddle();
    setSection('home');
  });
  on('btn-huddle-join', 'click', joinHuddle);
  on('btn-huddle-leave', 'click', () => cleanupHuddle());
  on('btn-huddle-mute', 'click', toggleHuddleMute);
  on('huddle-channel-select', 'change', renderHuddleView);
  on('btn-refresh-activity', 'click', () => renderActivity());
  on('lists-channel-select', 'change', () => loadLists());
  on('btn-new-list', 'click', openNewListForm);
  on('btn-cancel-new-list', 'click', closeNewListForm);
  on('lists-create-form', 'submit', createList);
  on('lists-container', 'change', handleListContainerChange);
  on('lists-container', 'click', handleListContainerClick);
  on('lists-container', 'submit', handleListContainerSubmit);
  on('canvas-channel-select', 'change', handleCanvasChannelChange);
  on('btn-new-canvas', 'click', createNewCanvas);
  on('canvas-doc-list', 'click', handleCanvasDocSelect);
  on('canvas-editor-form', 'submit', saveCanvas);
  on('canvas-title-input', 'input', markCanvasDirty);
  on('canvas-content-input', 'input', markCanvasDirty);
  on('btn-delete-canvas', 'click', deleteCanvas);
  on('messages', 'click', handleReactionClick);
  on('messages', 'click', handleMessagePinClick);
  on('messages', 'click', handleModerationMessageClick);
  on('moderation-content', 'click', handleModerationClick);
  on('moderation-content', 'submit', handleModerationSubmit);
  on('moderation-content', 'change', handleModerationChange);
  on('btn-channel-pins', 'click', togglePinnedMessages);
  on('btn-close-channel-pins', 'click', closePinnedMessages);
  on('channel-pins-list', 'click', handlePinnedMessageClick);
  on('dm-messages', 'click', handleReactionClick);
  on('emoji-picker-categories', 'click', handleEmojiCategoryClick);
  on('emoji-picker-grid', 'click', handleEmojiSelect);
  on('emoji-search', 'input', renderEmojiPickerGrid);
  on('btn-close-emoji-picker', 'click', closeEmojiPicker);

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

  // Message inputs
  if (els.messageInput) els.messageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && state.preferences.enterToSend) { e.preventDefault(); sendChannelMessage(); }
  });
  if (els.dmMessageInput) els.dmMessageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && state.preferences.enterToSend) { e.preventDefault(); sendDmMessage(); }
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
  if (els.userAvatar) {
    els.userAvatar.textContent = state.user.username.charAt(0).toUpperCase();
    els.userAvatar.parentElement.style.backgroundColor = state.user.avatarColor || '';
  }
  loadPreferences().catch((err) => console.error('Load preferences error:', err));
}

function openSettingsModal(modal) {
  document.querySelectorAll('.modal.open').forEach((openModal) => openModal.classList.remove('open'));
  modal?.classList.add('open');
  els.modalOverlay?.classList.add('open');
}

function closeSettingsModal() {
  document.querySelectorAll('.modal.open').forEach((modal) => modal.classList.remove('open'));
  els.modalOverlay?.classList.remove('open');
}

function openProfileModal() {
  document.getElementById('profile-username').value = state.user.username || '';
  document.getElementById('profile-avatar-color').value = state.user.avatarColor || '#6b21a8';
  openSettingsModal(els.profileModal);
}

function openPreferencesModal() {
  document.getElementById('preference-theme').value = state.preferences.theme;
  document.getElementById('preference-enter-to-send').checked = state.preferences.enterToSend;
  openSettingsModal(els.preferencesModal);
}

function openAccountModal() {
  document.getElementById('account-email').value = state.user.email || '';
  document.getElementById('account-current-password').value = '';
  document.getElementById('account-new-password').value = '';
  document.getElementById('account-confirm-password').value = '';
  openSettingsModal(els.accountModal);
}

function preferenceStorageKey() {
  return `preferences:${state.user.id}`;
}

async function loadPreferences() {
  const saved = await electronAPI.storeGet(preferenceStorageKey());
  if (saved && typeof saved === 'object') {
    state.preferences = {
      theme: saved.theme === 'dark' ? 'dark' : 'light',
      enterToSend: typeof saved.enterToSend === 'boolean' ? saved.enterToSend : true,
    };
  }
  applyPreferences();
}

function applyPreferences() {
  document.body.classList.toggle('theme-dark', state.preferences.theme === 'dark');
}

async function savePreferences(event) {
  event.preventDefault();
  state.preferences = {
    theme: document.getElementById('preference-theme').value === 'dark' ? 'dark' : 'light',
    enterToSend: document.getElementById('preference-enter-to-send').checked,
  };
  try {
    await electronAPI.storeSet(preferenceStorageKey(), state.preferences);
    applyPreferences();
    closeSettingsModal();
    showToast('Preferences saved on this device.', 'success');
  } catch (err) {
    console.error('Save preferences error:', err);
    showToast('Could not save preferences.', 'error');
  }
}

async function updateStoredSession(data) {
  state.token = data.token;
  state.user = { ...state.user, ...data.user };
  await electronAPI.storeSet('authToken', data.token);
  await electronAPI.storeSet('user', state.user);
  showApp();
  await loadModerationAccess();

  if (state.socket) {
    state.socket.auth = { token: data.token };
    state.socket.disconnect();
    state.socket.connect();
  }
}

async function saveProfile(event) {
  event.preventDefault();
  const username = document.getElementById('profile-username').value.trim();
  const avatarColor = document.getElementById('profile-avatar-color').value;
  try {
    const res = await api('/api/auth/me', {
      method: 'PATCH',
      body: JSON.stringify({ username, avatarColor }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not update profile');
    await updateStoredSession(data);
    closeSettingsModal();
    showToast('Profile updated.', 'success');
  } catch (err) {
    console.error('Update profile error:', err);
    showToast(err.message || 'Could not update profile.', 'error');
  }
}

async function saveAccountSettings(event) {
  event.preventDefault();
  const email = document.getElementById('account-email').value.trim();
  const currentPassword = document.getElementById('account-current-password').value;
  const newPassword = document.getElementById('account-new-password').value;
  const confirmPassword = document.getElementById('account-confirm-password').value;

  if (newPassword && newPassword !== confirmPassword) {
    showToast('New password and confirmation do not match.', 'error');
    return;
  }

  try {
    const res = await api('/api/auth/me/account', {
      method: 'PUT',
      body: JSON.stringify({ email, currentPassword, ...(newPassword ? { newPassword } : {}) }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not update account');
    await updateStoredSession(data);
    closeSettingsModal();
    showToast('Account settings updated.', 'success');
  } catch (err) {
    console.error('Update account error:', err);
    showToast(err.message || 'Could not update account.', 'error');
  }
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
    loadModerationAccess();
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
    loadModerationAccess();
  } catch (err) {
    errorEl.textContent = 'Cannot connect to server. Is it running?';
    errorEl.style.display = 'block';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Create account';
  }
}

async function handleLogout() {
  cleanupHuddle(false);
  cancelReply();
  if (state.socket) {
    state.socketAuthenticated = false;
    state.socket.disconnect();
    state.socket = null;
  }

  try {
    await electronAPI.logout();
  } catch (err) {
    console.error('Sign out error:', err);
    showToast('Could not open the sign-in window. Please restart the app.', 'error');
    return;
  }

  state.token = null;
  state.user = null;
  state.channels = [];
  state.messages = {};
  state.currentChannelId = null;
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
    state.socketAuthenticated = true;
    console.log('Socket authenticated:', data.username);
  });
  state.socket.on('message_error', ({ error, clientMessageId }) => {
    if (clientMessageId) removePendingMessage(clientMessageId);
    showToast(error || 'Message could not be sent.', 'error');
  });
  state.socket.on('message_sent', ({ message }) => {
    if (!message) return;
    const messages = state.messages[message.channelId] || (state.messages[message.channelId] = []);
    upsertMessage(messages, message);
    if (Number(state.currentChannelId) === Number(message.channelId) && state.view === 'channel') {
      renderMessages('messages', messages);
    }
  });
  state.socket.on('channel_error', ({ error }) => {
    showToast(error || 'Channel access denied.', 'error');
  });
  state.socket.on('channel_access_revoked', async ({ channelId }) => {
    state.channels = state.channels.filter((channel) => Number(channel.id) !== Number(channelId));
    delete state.messages[channelId];
    renderSidebar();
    showToast('Your access to a channel was removed.', 'error');
    if (Number(state.currentChannelId) === Number(channelId)) {
      state.currentChannelId = null;
      if (state.channels.length) await openChannel(state.channels[0].id);
      else {
        state.view = 'channel';
        showView('channel');
        els.channelTitle.textContent = 'No channels';
        els.channelTopic.textContent = '';
        renderMessages('messages', []);
      }
    }
  });

  state.socket.on('huddle:joined', handleHuddleJoined);
  state.socket.on('huddle:participant-joined', (participant) => {
    if (Number(state.huddle.channelId) !== Number(participant.channelId)) return;
    state.huddle.participants.set(participant.peerId, participant);
    renderHuddleParticipants();
  });
  state.socket.on('huddle:participant-left', ({ peerId }) => {
    removeHuddlePeer(peerId);
  });
  state.socket.on('huddle:signal', (message) => {
    handleHuddleSignal(message).catch((err) => {
      console.error('Huddle signaling error:', err);
      setHuddleStatus('Could not establish an audio connection.', 'error');
    });
  });
  state.socket.on('huddle:error', ({ error }) => {
    if (state.huddle.joining || state.huddle.channelId) {
      cleanupHuddle(false);
    }
    setHuddleStatus(error || 'Unable to join huddle.', 'error');
    renderHuddleView();
  });

  state.socket.on('new_message', (msg) => {
    const messages = state.messages[msg.channelId] || (state.messages[msg.channelId] = []);
    upsertMessage(messages, msg);

    const isActive = Number(state.currentChannelId) === Number(msg.channelId) && state.view === 'channel';

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

  state.socket.on('message_pin_updated', (event) => {
    const channelId = Number(event.channelId);
    const messages = state.messages[channelId] || [];
    const message = messages.find((item) => Number(item.id) === Number(event.messageId));
    if (message) {
      message.pinned = event.pinned;
      message.pinnedAt = event.pinnedAt;
      message.pinnedBy = event.pinnedBy;
      if (Number(state.currentChannelId) === channelId && state.view === 'channel') {
        renderMessages('messages', messages);
      }
    }
    if (Number(state.currentChannelId) === channelId) {
      loadPinnedMessages(channelId);
    }
  });

  state.socket.on('file_deleted', handleFileDeleted);
  state.socket.on('message_deleted', ({ messageId, channelId }) => {
    const messages = state.messages[channelId] || [];
    state.messages[channelId] = messages.filter((message) => Number(message.id) !== Number(messageId));
    if (Number(state.currentChannelId) === Number(channelId) && state.view === 'channel') {
      renderMessages('messages', state.messages[channelId]);
    }
    if (Number(state.currentChannelId) === Number(channelId)) loadPinnedMessages(channelId);
  });

  state.socket.on('new_direct_message', (dm) => {
    const otherUserId = Number(dm.senderId) === Number(state.user.id) ? dm.receiverId : dm.senderId;
    const messages = state.directMessages[otherUserId] || (state.directMessages[otherUserId] = []);
    upsertMessage(messages, dm);

    if (Number(state.currentDMId) === Number(otherUserId) && state.view === 'dm') {
      renderMessages('dm-messages', messages);
    }
  });

  state.socket.on('user_typing', (data) => {
    // Could show typing indicator
  });

  state.socket.on('disconnect', () => {
    state.socketAuthenticated = false;
    if (state.huddle.channelId || state.huddle.joining) {
      cleanupHuddle(false);
      setHuddleStatus('Disconnected from the call server. Rejoin to continue.', 'error');
      renderHuddleView();
    }
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

function handleGlobalSearchInput() {
  clearTimeout(state.searchTimer);
  const searchTerm = els.globalSearch.value.trim();
  const requestId = ++state.searchRequestId;
  state.searchActiveIndex = -1;

  if (searchTerm.length < 2) {
    hideSearchResults();
    return;
  }

  els.searchResults.replaceChildren();
  const loading = document.createElement('div');
  loading.className = 'search-message';
  loading.textContent = 'Searching…';
  els.searchResults.appendChild(loading);
  showSearchResults();

  state.searchTimer = setTimeout(() => {
    searchWorkspace(searchTerm, requestId);
  }, 250);
}

async function searchWorkspace(searchTerm, requestId) {
  try {
    const res = await api(`/api/search?q=${encodeURIComponent(searchTerm)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Search failed');
    if (requestId !== state.searchRequestId) return;
    renderSearchResults(data);
  } catch (err) {
    if (requestId !== state.searchRequestId) return;
    console.error('Search error:', err);
    renderSearchMessage('Search failed. Try again.');
  }
}

function showSearchResults() {
  els.searchResults.hidden = false;
  els.globalSearch.setAttribute('aria-expanded', 'true');
}

function hideSearchResults() {
  if (!els.searchResults || !els.globalSearch) return;
  els.searchResults.hidden = true;
  els.globalSearch.setAttribute('aria-expanded', 'false');
  els.globalSearch.removeAttribute('aria-activedescendant');
  state.searchActiveIndex = -1;
}

function renderSearchMessage(message) {
  els.searchResults.replaceChildren();
  const item = document.createElement('div');
  item.className = 'search-message';
  item.textContent = message;
  els.searchResults.appendChild(item);
  showSearchResults();
}

function renderSearchResults(data) {
  els.searchResults.replaceChildren();
  const groups = [
    ['Messages', 'message', data.messages || [], (item) => `#${item.channelName} · ${item.username}`, (item) => item.content],
    ['Direct messages', 'direct-message', data.directMessages || [], (item) => item.username, (item) => item.content],
    ['People', 'person', data.people || [], (item) => item.username, () => 'Open direct message'],
    ['Files', 'file', data.files || [], (item) => item.name, (item) => item.channelName ? `#${item.channelName} · ${item.uploaderUsername}` : item.username ? `DM with ${item.username}` : `Uploaded by ${item.uploaderUsername}`],
  ];

  let count = 0;
  groups.forEach(([label, kind, items, titleFor, detailFor]) => {
    if (!items.length) return;
    const heading = document.createElement('div');
    heading.className = 'search-group-label';
    heading.textContent = label;
    els.searchResults.appendChild(heading);

    items.forEach((item) => {
      const result = document.createElement('button');
      result.type = 'button';
      result.id = `search-result-${count}`;
      result.className = 'search-result';
      result.setAttribute('role', 'option');
      result.setAttribute('aria-selected', 'false');
      result.dataset.kind = kind;
      result.dataset.id = item.id;
      if (item.channelId) result.dataset.channelId = item.channelId;
      if (item.userId) result.dataset.userId = item.userId;
      if (item.name) result.dataset.name = item.name;

      const title = document.createElement('span');
      title.className = 'search-result-title';
      title.textContent = titleFor(item) || '';
      const detail = document.createElement('span');
      detail.className = 'search-result-detail';
      detail.textContent = detailFor(item) || '';
      result.append(title, detail);
      els.searchResults.appendChild(result);
      count += 1;
    });
  });

  if (!count) {
    renderSearchMessage('No matching messages, people, or files.');
    return;
  }

  showSearchResults();
}

function handleGlobalSearchKeydown(event) {
  if (event.key === 'Escape') {
    hideSearchResults();
    return;
  }

  const results = [...els.searchResults.querySelectorAll('.search-result')];
  if (!results.length) return;

  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    const direction = event.key === 'ArrowDown' ? 1 : -1;
    state.searchActiveIndex = (state.searchActiveIndex + direction + results.length) % results.length;
    results.forEach((result, index) => {
      result.setAttribute('aria-selected', String(index === state.searchActiveIndex));
    });
    els.globalSearch.setAttribute('aria-activedescendant', results[state.searchActiveIndex].id);
  } else if (event.key === 'Enter' && state.searchActiveIndex >= 0) {
    event.preventDefault();
    results[state.searchActiveIndex].click();
  }
}

async function activateSearchResult(result) {
  const { kind, id, channelId, userId, name } = result.dataset;
  hideSearchResults();
  els.globalSearch.value = '';
  clearTimeout(state.searchTimer);
  state.searchRequestId += 1;

  if (kind === 'message') {
    await openChannel(Number(channelId));
    await scrollToMessage(id);
  } else if (kind === 'direct-message') {
    await openDM(Number(userId));
    await scrollToDirectMessage(Number(userId), id);
  } else if (kind === 'person') {
    await openDM(Number(id));
  } else if (kind === 'file') {
    await downloadFile(id, name);
  }
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
    renderHuddleView();
    if (state.section === 'lists') populateListsChannelSelect();

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
  els.channelList.classList.toggle('has-empty-record', state.channels.length === 0);

  if (state.channels.length === 0) {
    els.channelList.innerHTML = emptyRecordMarkup(
      'No channels yet',
      'Create or join a channel to start chatting.',
      'compact sidebar-empty-record',
    );
  }

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
  cancelReply();
  state.view = 'channel';
  state.section = 'home';
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
  await loadPinnedMessages(channelId);
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

async function loadChannelMessages(channelId, offset = 0) {
  const container = document.getElementById('messages');
  renderSkeleton(container);
  try {
    const res = await api(`/api/messages/${channelId}?limit=100&offset=${offset}`);
    const data = await res.json();

    if (!res.ok) throw new Error(data.error || 'Failed to load messages');

    state.messages[channelId] = mergeLoadedMessages(data.messages, state.messages[channelId] || []);
    renderMessages('messages', state.messages[channelId]);
  } catch (err) {
    console.error('Load messages error:', err);
    container.innerHTML = `<div class="empty-state" style="justify-content:flex-start; padding-top:20px;"><h2>Could not load messages</h2><p style="color:var(--text-muted);">Check that the server is running.</p></div>`;
  }
}

async function loadPinnedMessages(channelId) {
  try {
    const res = await api(`/api/messages/${channelId}/pins`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to load pinned messages');

    state.pinnedMessages[channelId] = data.messages || [];
    if (Number(state.currentChannelId) === Number(channelId)) {
      renderPinnedMessages(channelId);
    }
  } catch (err) {
    console.error('Load pinned messages error:', err);
    if (Number(state.currentChannelId) === Number(channelId) && state.pinPanelOpen) {
      const list = document.getElementById('channel-pins-list');
      list.innerHTML = '<div class="channel-pins-empty">Could not load pinned messages.</div>';
    }
  }
}

function renderPinnedMessages(channelId) {
  const pinnedMessages = state.pinnedMessages[channelId] || [];
  const panel = document.getElementById('channel-pins');
  const toggle = document.getElementById('btn-channel-pins');
  const count = document.getElementById('channel-pin-count');
  const list = document.getElementById('channel-pins-list');
  if (!panel || !toggle || !count || !list) return;

  panel.hidden = !state.pinPanelOpen;
  toggle.setAttribute('aria-expanded', String(state.pinPanelOpen));
  count.hidden = pinnedMessages.length === 0;
  count.textContent = pinnedMessages.length > 99 ? '99+' : String(pinnedMessages.length);

  if (pinnedMessages.length === 0) {
    list.innerHTML = emptyRecordMarkup(
      'No pinned messages',
      'Pinned messages will appear here.',
      'compact pinned-empty-record',
    );
    return;
  }

  list.innerHTML = pinnedMessages.map((message) => `
    <article class="pinned-message">
      <button class="pinned-message-jump" type="button" data-pinned-message-id="${escapeHtml(String(message.id))}" aria-label="Jump to message by ${escapeHtml(message.username || 'Unknown')}">
        <span class="pinned-message-meta">
          <strong>${escapeHtml(message.username || 'Unknown')}</strong>
          <time>${escapeHtml(shortTime(message.createdAt))}</time>
        </span>
        <span class="pinned-message-content">${escapeHtml(message.content || (message.attachments?.length ? 'Attachment' : ''))}</span>
      </button>
      <button class="pinned-message-remove" type="button" data-unpin-message-id="${escapeHtml(String(message.id))}" aria-label="Unpin message">Unpin</button>
    </article>`).join('');
}

function togglePinnedMessages() {
  state.pinPanelOpen = !state.pinPanelOpen;
  renderPinnedMessages(state.currentChannelId);
  if (state.pinPanelOpen) loadPinnedMessages(state.currentChannelId);
}

function closePinnedMessages() {
  state.pinPanelOpen = false;
  renderPinnedMessages(state.currentChannelId);
}

async function handleMessagePinClick(event) {
  const button = event.target.closest('[data-message-pin]');
  if (!button) return;
  event.preventDefault();
  event.stopPropagation();
  await setMessagePinned(button.dataset.messagePin, button.dataset.pinned !== 'true');
}

async function handlePinnedMessageClick(event) {
  const unpinButton = event.target.closest('[data-unpin-message-id]');
  if (unpinButton) {
    await setMessagePinned(unpinButton.dataset.unpinMessageId, false);
    return;
  }

  const jumpButton = event.target.closest('[data-pinned-message-id]');
  if (jumpButton) await scrollToMessage(jumpButton.dataset.pinnedMessageId);
}

async function setMessagePinned(messageId, pinned) {
  try {
    const res = await api(`/api/messages/${messageId}/pin`, {
      method: 'PATCH',
      body: JSON.stringify({ pinned }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to update message pin');

    const message = (state.messages[state.currentChannelId] || [])
      .find((item) => Number(item.id) === Number(messageId));
    if (message) {
      message.pinned = data.message.pinned;
      message.pinnedAt = data.message.pinnedAt;
      message.pinnedBy = data.message.pinnedBy;
      renderMessages('messages', state.messages[state.currentChannelId]);
    }
    await loadPinnedMessages(state.currentChannelId);
  } catch (err) {
    console.error('Update message pin error:', err);
    showToast(err.message || 'Could not update message pin.', 'error');
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

    state.users = data.users;
    state.usersLoaded = true;
    state.dms = data.users.filter(u => u.id !== state.user.id);
    renderDmList();
    if (state.section === 'dms' && !state.currentDMId) {
      if (state.dms.length === 0) {
        els.dmTitle.textContent = 'Direct Messages';
        els.dmTopic.textContent = '';
        els.dmMessages.innerHTML = emptyRecordMarkup(
          'No people to message yet',
          'Workspace members will appear here.',
        );
      } else {
        await openDM(state.dms[0].id);
      }
    }
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
  els.dmList.classList.toggle('has-empty-record', state.usersLoaded && state.dms.length === 0);

  if (state.dms.length === 0) {
    if (!state.usersLoaded) return;
    els.dmList.innerHTML = emptyRecordMarkup(
      'No people to message yet',
      'Workspace members will appear here.',
      'compact sidebar-empty-record',
    );
    return;
  }

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
  cancelReply();
  state.view = 'dm';
  state.section = 'dms';
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

async function loadDmMessages(userId, offset = 0) {
  const container = document.getElementById('dm-messages');
  renderSkeleton(container);
  try {
    const res = await api(`/api/users/${userId}/direct-messages?limit=100&offset=${offset}`);
    const data = await res.json();

    if (!res.ok) throw new Error(data.error || 'Failed to load DMs');

    state.directMessages[userId] = mergeLoadedMessages(data.messages, state.directMessages[userId] || []);
    renderMessages('dm-messages', state.directMessages[userId]);
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
    container.innerHTML = emptyRecordMarkup('No messages yet', 'Send the first message.');
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
    container.appendChild(renderMessageEl(msg, containerId === 'messages'));
  });

  container.scrollTop = container.scrollHeight;
}

function upsertMessage(messages, message) {
  const index = messages.findIndex((existing) =>
    (message.clientMessageId && existing.clientMessageId === message.clientMessageId)
    || (existing.id != null && message.id != null && String(existing.id) === String(message.id)));
  if (index === -1) messages.push(message);
  else messages[index] = { ...messages[index], ...message, pending: false };
}

function mergeLoadedMessages(loadedMessages, currentMessages) {
  const merged = [...loadedMessages];
  currentMessages.forEach((message) => {
    if (message.pending || !merged.some((loaded) => String(loaded.id) === String(message.id))) {
      upsertMessage(merged, message);
    }
  });
  return merged;
}

function removePendingMessage(clientMessageId) {
  const removeFrom = (collection) => {
    Object.keys(collection).forEach((key) => {
      const messages = collection[key];
      const filtered = messages.filter((message) =>
        !(message.pending && message.clientMessageId === clientMessageId));
      if (filtered.length === messages.length) return;
      collection[key] = filtered;
      if (collection === state.messages && Number(state.currentChannelId) === Number(key)
        && state.view === 'channel') {
        renderMessages('messages', filtered);
      } else if (collection === state.directMessages && Number(state.currentDMId) === Number(key)
        && state.view === 'dm') {
        renderMessages('dm-messages', filtered);
      }
    });
  };
  removeFrom(state.messages);
  removeFrom(state.directMessages);
}

function renderMessageEl(msg, allowReply = false) {
  const isYou = (msg.userId ?? msg.senderId) === state.user.id;
  const username = msg.username || msg.senderUsername || 'Unknown';
  const avatarColor = msg.avatarColor || msg.senderAvatarColor || '#A855F7';
  const initials = username.charAt(0).toUpperCase();
  const isPinned = Boolean(msg.pinned || msg.pinnedAt);
  const canModerate = state.moderation.isSuperadmin
    || state.moderation.moderatorChannelIds.some((id) => Number(id) === Number(msg.channelId || state.currentChannelId));

  const el = document.createElement('div');
  el.className = `message${msg.pending ? ' pending' : ''}`;
  el.id = `message-${msg.id}`;

  const reactionsHtml = (msg.reactions || []).map((r) => {
    const hasMe = r.users && r.users.includes(state.user.id);
    return `<button type="button" class="reaction${hasMe ? ' me' : ''}" data-reaction-message="${escapeHtml(String(msg.id))}" data-reaction-emoji="${escapeHtml(r.emoji)}" aria-label="${escapeHtml(r.emoji)} reaction, ${r.count} people">
      ${r.emoji}<span class="count">${r.count}</span>${hasMe ? '<span class="remove">✕</span>' : ''}
    </button>`;
  }).join('');

  const attachmentsHtml = (msg.attachments || []).map((a) => `
    <div class="attachment-row">
      <div class="attachment" data-file-id="${escapeHtml(String(a.id))}" data-file-name="${escapeHtml(a.filename)}" role="button" tabindex="0" title="Download ${escapeHtml(a.filename)}">
        <div class="icon">${fileIconSvg(fileIcon(a.mimeType))}</div>
        <div class="info">
          <div class="name">${escapeHtml(a.filename)}</div>
          <div class="size">${escapeHtml(humanSize(a.size))}</div>
        </div>
      </div>
      ${Number(a.uploadedBy) === Number(state.user.id) || (allowReply && canModerate) ? `<button class="attachment-delete" type="button" data-delete-file="${escapeHtml(String(a.id))}" data-file-name="${escapeHtml(a.filename)}" data-moderator-delete="${Number(a.uploadedBy) !== Number(state.user.id)}">${Number(a.uploadedBy) === Number(state.user.id) ? 'Delete' : 'Remove attachment'}</button>` : ''}
    </div>`).join('');
  const replyPreview = msg.replyTo ? (msg.replyToMessage || {}) : null;

  el.innerHTML = `
    <div class="avatar-mini" style="background:${avatarColor};">${initials}</div>
    <div class="message-body">
      <div class="message-header">
        <span class="name">${escapeHtml(username)}</span>
        ${isYou ? '<span class="you">You</span>' : ''}
        <span class="time">${shortTime(msg.createdAt)}</span>
        ${allowReply && isPinned ? '<span class="message-pinned-badge">Pinned</span>' : ''}
      </div>
      ${msg.replyTo ? `<button class="message-reply-preview" type="button" data-target-id="${escapeHtml(String(msg.replyTo))}" title="Go to original message">
        <span class="message-reply-author">${escapeHtml(replyPreview.username || 'Original message')}</span>
        <span class="message-reply-content">${escapeHtml(replyPreview.content || 'Attachment')}</span>
      </button>` : ''}
      <div class="message-text">${escapeHtml(msg.content)}</div>
      ${attachmentsHtml ? `<div class="attachments">${attachmentsHtml}</div>` : ''}
      <div class="message-actions">
        ${allowReply ? `<button class="message-reaction-action" type="button" data-open-reactions="${escapeHtml(String(msg.id))}" aria-label="Add reaction" title="Add reaction">Add reaction</button>` : ''}
        ${allowReply ? '<a class="message-reply-action" href="#">Reply</a>' : ''}
        ${allowReply ? `<button class="message-pin-action" type="button" data-message-pin="${escapeHtml(String(msg.id))}" data-pinned="${isPinned}" aria-label="${isPinned ? 'Unpin' : 'Pin'} message">${isPinned ? 'Unpin' : 'Pin'}</button>` : ''}
        ${allowReply ? `<button class="message-report-action" type="button" data-report-message="${escapeHtml(String(msg.id))}">Report</button>` : ''}
        ${allowReply && canModerate ? `<button class="message-delete-action" type="button" data-moderate-delete="${escapeHtml(String(msg.id))}">Remove</button>` : ''}
      </div>
      <div class="reactions">${reactionsHtml}</div>
    </div>`;

  const replyAction = el.querySelector('.message-reply-action');
  if (replyAction) {
    replyAction.addEventListener('click', (event) => {
      event.preventDefault();
      beginReply(msg);
    });
  }

  const replyQuote = el.querySelector('.message-reply-preview');
  if (replyQuote) {
    replyQuote.addEventListener('click', () => scrollToMessage(replyQuote.dataset.targetId));
  }

  el.querySelectorAll('.attachment').forEach((node) => {
    const go = () => downloadFile(node.dataset.fileId, node.dataset.fileName);
    node.addEventListener('click', go);
    node.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); }
    });
  });
  el.querySelectorAll('[data-delete-file]').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      deleteFileAttachment(
        button.dataset.deleteFile,
        button.dataset.fileName,
        button.dataset.moderatorDelete === 'true',
      );
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

function emptyRecordMarkup(title, description, className = '') {
  return `
    <div class="empty-record-state ${className}">
      <div class="empty-record-illustration" aria-hidden="true">
        <svg viewBox="0 0 96 96" fill="none">
          <path class="empty-record-shadow" d="M22 78h52"/>
          <path class="empty-record-page" d="M31 17h24l14 14v39a5 5 0 0 1-5 5H31a5 5 0 0 1-5-5V22a5 5 0 0 1 5-5Z"/>
          <path class="empty-record-fold" d="M55 17v14h14"/>
          <path class="empty-record-line" d="M37 43h20M37 51h20M37 59h12"/>
          <path class="empty-record-spark" d="M19 31v8m-4-4h8M77 49v8m-4-4h8"/>
          <circle class="empty-record-dot" cx="73" cy="27" r="2"/>
        </svg>
      </div>
      <div class="empty-record-copy">
        <h2>${escapeHtml(title)}</h2>
        <p>${escapeHtml(description)}</p>
      </div>
    </div>`;
}

// ============================================================
// Sending Messages
// ============================================================
async function sendChannelMessage() {
  const text = els.messageInput.value.trim();
  if (!text) return;
  if (!state.socketAuthenticated) {
    showToast('Chat is reconnecting. Please try again in a moment.', 'error');
    return;
  }

  try {
    const clientMessageId = createClientMessageId();
    const replyTo = state.replyingTo?.id || null;
    const messages = state.messages[state.currentChannelId] || (state.messages[state.currentChannelId] = []);
    upsertMessage(messages, {
      id: `pending-${clientMessageId}`,
      clientMessageId,
      channelId: state.currentChannelId,
      userId: state.user.id,
      username: state.user.username,
      avatarColor: state.user.avatarColor,
      content: text,
      createdAt: new Date().toISOString(),
      attachments: [],
      reactions: [],
      pending: true,
    });
    renderMessages('messages', messages);
    els.messageInput.value = '';
    cancelReply();
    state.socket.emit('send_message', {
      channelId: state.currentChannelId,
      content: text,
      replyTo,
      clientMessageId,
    });
  } catch (err) {
    console.error('Send message error:', err);
  }
}

async function sendDmMessage() {
  const text = els.dmMessageInput.value.trim();
  if (!text || !state.currentDMId) return;
  if (!state.socketAuthenticated) {
    showToast('Chat is reconnecting. Please try again in a moment.', 'error');
    return;
  }

  try {
    const clientMessageId = createClientMessageId();
    const messages = state.directMessages[state.currentDMId] || (state.directMessages[state.currentDMId] = []);
    upsertMessage(messages, {
      id: `pending-${clientMessageId}`,
      clientMessageId,
      senderId: state.user.id,
      receiverId: state.currentDMId,
      senderUsername: state.user.username,
      senderAvatarColor: state.user.avatarColor,
      content: text,
      createdAt: new Date().toISOString(),
      attachments: [],
      pending: true,
    });
    renderMessages('dm-messages', messages);
    els.dmMessageInput.value = '';
    state.socket.emit('send_direct_message', {
      receiverId: state.currentDMId,
      content: text,
      clientMessageId,
    });
  } catch (err) {
    console.error('Send DM error:', err);
  }
}

function createClientMessageId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function beginReply(message) {
  state.replyingTo = message;
  els.replyPreviewAuthor.textContent = message.username || 'Unknown';
  els.replyPreviewContent.textContent = message.content || 'Attachment';
  els.replyComposerPreview.hidden = false;
  els.messageInput.focus();
}

function cancelReply() {
  state.replyingTo = null;
  if (els.replyComposerPreview) els.replyComposerPreview.hidden = true;
}

async function scrollToMessage(messageId) {
  let message = document.getElementById(`message-${messageId}`);
  if (!message) {
    try {
      if (!state.currentChannelId) throw new Error('No channel is selected');
      const res = await api(`/api/messages/${state.currentChannelId}/context/${messageId}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not find the original message');
      await loadChannelMessages(state.currentChannelId, data.offset);
      message = document.getElementById(`message-${messageId}`);
    } catch (err) {
      console.error('Load original message error:', err);
      showToast('Could not load the original message.', 'error');
      return;
    }
  }
  if (!message) {
    showToast('Could not find the original message in this channel.', 'error');
    return;
  }

  message.scrollIntoView({ behavior: 'smooth', block: 'center' });
  message.classList.add('message-highlight');
  setTimeout(() => message.classList.remove('message-highlight'), 1500);
}

async function scrollToDirectMessage(userId, messageId) {
  let message = document.getElementById(`message-${messageId}`);
  if (!message) {
    try {
      const res = await api(`/api/users/${userId}/direct-messages/context/${messageId}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not find the direct message');
      await loadDmMessages(userId, data.offset);
      message = document.getElementById(`message-${messageId}`);
    } catch (err) {
      console.error('Load direct message context error:', err);
      showToast('Could not load the matching direct message.', 'error');
      return;
    }
  }
  if (!message) {
    showToast('Could not find the matching direct message.', 'error');
    return;
  }

  message.scrollIntoView({ behavior: 'smooth', block: 'center' });
  message.classList.add('message-highlight');
  setTimeout(() => message.classList.remove('message-highlight'), 1500);
}

// ============================================================
// Reactions
// ============================================================
function handleReactionClick(event) {
  const addButton = event.target.closest('[data-open-reactions]');
  if (addButton) {
    openEmojiPicker(addButton.dataset.openReactions, addButton);
    return;
  }
  const reaction = event.target.closest('[data-reaction-message][data-reaction-emoji]');
  if (reaction) {
    addReaction(reaction.dataset.reactionMessage, reaction.dataset.reactionEmoji);
  }
}

function openEmojiPicker(messageId, anchor) {
  state.emojiPicker.messageId = messageId;
  state.emojiPicker.category = 'Smileys';
  els.emojiSearch.value = '';
  renderEmojiPickerCategories();
  renderEmojiPickerGrid();
  els.emojiPicker.hidden = false;

  const rect = anchor.getBoundingClientRect();
  const pickerRect = els.emojiPicker.getBoundingClientRect();
  const left = Math.max(12, Math.min(rect.left, window.innerWidth - pickerRect.width - 12));
  const top = rect.bottom + pickerRect.height + 12 <= window.innerHeight
    ? rect.bottom + 8
    : Math.max(12, rect.top - pickerRect.height - 8);
  els.emojiPicker.style.left = `${left}px`;
  els.emojiPicker.style.top = `${top}px`;
  els.emojiSearch.focus();
}

function closeEmojiPicker() {
  if (!els.emojiPicker || els.emojiPicker.hidden) return;
  els.emojiPicker.hidden = true;
  state.emojiPicker.messageId = null;
}

function renderEmojiPickerCategories() {
  els.emojiPickerCategories.innerHTML = Object.keys(REACTION_EMOJI).map((category) => `
    <button class="emoji-category${category === state.emojiPicker.category ? ' active' : ''}"
      type="button" role="tab" aria-selected="${category === state.emojiPicker.category}"
      data-emoji-category="${escapeHtml(category)}">${escapeHtml(category)}</button>`).join('');
}

function handleEmojiCategoryClick(event) {
  const button = event.target.closest('[data-emoji-category]');
  if (!button) return;
  state.emojiPicker.category = button.dataset.emojiCategory;
  renderEmojiPickerCategories();
  renderEmojiPickerGrid();
}

function renderEmojiPickerGrid() {
  if (!els.emojiPickerGrid) return;
  const search = (els.emojiSearch.value || '').trim().toLowerCase();
  const choices = Object.entries(REACTION_EMOJI)
    .filter(([category]) => !search && category === state.emojiPicker.category || search)
    .flatMap(([category, emojis]) => emojis
      .filter(([emoji, name]) => !search || `${emoji} ${name} ${category}`.toLowerCase().includes(search))
      .map(([emoji, name]) => ({ emoji, name })));
  els.emojiPickerGrid.innerHTML = choices.length
    ? choices.map(({ emoji, name }) => `
      <button type="button" class="emoji-choice" data-emoji="${escapeHtml(emoji)}"
        aria-label="${escapeHtml(name)}" title="${escapeHtml(name)}">${emoji}</button>`).join('')
    : '<p class="emoji-picker-empty">No matching emojis.</p>';
}

async function handleEmojiSelect(event) {
  const button = event.target.closest('[data-emoji]');
  if (!button || !state.emojiPicker.messageId) return;
  const { messageId } = state.emojiPicker;
  const emoji = button.dataset.emoji;
  closeEmojiPicker();
  await addReaction(messageId, emoji);
}

async function addReaction(messageId, emoji) {
  try {
    const res = await api(`/api/messages/${messageId}/reactions`, {
      method: 'POST',
      body: JSON.stringify({ emoji }),
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to update reaction');

    // Reload current messages to update reaction counts
    if (state.currentChannelId) {
      await loadChannelMessages(state.currentChannelId);
    }
    if (state.currentDMId) {
      await loadDmMessages(state.currentDMId);
    }
  } catch (err) {
    console.error('Add reaction error:', err);
    showToast(err.message || 'Could not update reaction.', 'error');
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
      replyTo: state.replyingTo?.id || null,
    });

    cancelReply();
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
  lists:    { pane: null,       view: 'lists' },
  canvases: { pane: null,       view: 'canvases' },
  huddle:   { pane: null,       view: 'huddle' },
  moderation: { pane: null,     view: 'moderation' },
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
  cancelReply();
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
    } else if (state.usersLoaded) {
      els.dmTitle.textContent = 'Direct Messages';
      els.dmTopic.textContent = '';
      els.dmMessages.innerHTML = emptyRecordMarkup(
        'No people to message yet',
        'Workspace members will appear here.',
      );
    }
  } else if (section === 'files') {
    await loadFiles();
  } else if (section === 'notes') {
    await loadNotes();
  } else if (section === 'lists') {
    populateListsChannelSelect();
    await loadLists();
  } else if (section === 'canvases') {
    populateCanvasChannelSelect();
    await loadCanvases();
  } else if (section === 'activity') {
    renderActivity();
  } else if (section === 'huddle') {
    renderHuddleView();
  } else if (section === 'moderation') {
    await loadModerationView();
  }
}

async function loadModerationAccess() {
  try {
    const res = await api('/api/moderation/access');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not load moderation access');
    state.moderation.isSuperadmin = Boolean(data.isSuperadmin);
    state.moderation.moderatorChannelIds = data.moderatorChannelIds || [];
    const nav = document.getElementById('nav-moderation');
    if (nav) nav.hidden = !state.moderation.isSuperadmin && !state.moderation.moderatorChannelIds.length;
  } catch (err) {
    console.error('Load moderation access error:', err);
  }
}

async function loadModerationView() {
  const container = document.getElementById('moderation-content');
  if (!container) return;
  const channels = state.moderation.isSuperadmin
    ? state.channels
    : state.channels.filter((channel) => state.moderation.moderatorChannelIds
      .some((id) => Number(id) === Number(channel.id)));
  if (!channels.length) {
    container.innerHTML = emptyRecordMarkup(
      'No channels to moderate',
      'You do not have moderation access to a channel yet.',
    );
    return;
  }
  const selectedId = channels.some((channel) => Number(channel.id) === Number(state.moderation.channel?.id))
    ? Number(state.moderation.channel.id) : Number(channels[0].id);
  container.innerHTML = `
    <div class="moderation-toolbar">
      <label for="moderation-channel-select">Channel</label>
      <select id="moderation-channel-select">${channels.map((channel) => `<option value="${channel.id}"${Number(channel.id) === selectedId ? ' selected' : ''}>#${escapeHtml(channel.name)}</option>`).join('')}</select>
    </div>
    ${state.moderation.isSuperadmin ? `
      <form class="moderation-card moderation-settings" data-moderation-form="settings">
        <h2>Workspace timeout policy</h2>
        <label>Default timeout (minutes)<input name="defaultTimeoutMinutes" type="number" min="1" max="10080" value="${state.moderation.settings?.defaultTimeoutMinutes || 5}" required></label>
        <label>Maximum timeout (minutes)<input name="maxTimeoutMinutes" type="number" min="1" max="10080" value="${state.moderation.settings?.maxTimeoutMinutes || 10080}" required></label>
        <button class="btn primary" type="submit">Save timeout policy</button>
      </form>` : ''}
    <div id="moderation-channel-data" class="moderation-channel-data"><div class="loading-state">Loading channel moderation…</div></div>
    ${state.moderation.isSuperadmin ? '<div id="moderation-workspace-audit"></div>' : ''}`;
  if (state.moderation.isSuperadmin) {
    try {
      const response = await api('/api/moderation/settings');
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not load timeout policy');
      state.moderation.settings = data.settings;
      const form = container.querySelector('[data-moderation-form="settings"]');
      if (form) {
        form.elements.defaultTimeoutMinutes.value = data.settings.defaultTimeoutMinutes;
        form.elements.maxTimeoutMinutes.value = data.settings.maxTimeoutMinutes;
      }
    } catch (err) {
      console.error('Load moderation settings error:', err);
      showToast(err.message || 'Could not load timeout policy.', 'error');
    }
  }
  await loadModerationChannel(selectedId);
  if (state.moderation.isSuperadmin) await loadModerationAudit();
}

async function loadModerationAudit() {
  const container = document.getElementById('moderation-workspace-audit');
  if (!container) return;
  try {
    const response = await api('/api/moderation/audit?limit=100');
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not load workspace audit log');
    container.innerHTML = `
      <div class="moderation-card"><h2>Workspace audit log</h2><div class="moderation-list">${(data.entries || []).map((entry) => `
        <div class="moderation-row"><span>${escapeHtml(entry.actorUsername || 'former user')} · ${escapeHtml(entry.action)}${entry.channelName ? ` · #${escapeHtml(entry.channelName)}` : ''}${entry.targetUsername ? ` · ${escapeHtml(entry.targetUsername)}` : ''} ${entry.details ? ` ${escapeHtml(JSON.stringify(entry.details))}` : ''}</span><time>${escapeHtml(new Date(entry.createdAt).toLocaleString())}</time></div>
      `).join('') || '<p>No moderation actions yet.</p>'}</div></div>`;
  } catch (err) {
    console.error('Load workspace audit log error:', err);
    container.innerHTML = '<div class="moderation-card"><h2>Workspace audit log</h2><p>Could not load the audit log.</p></div>';
  }
}

async function loadModerationChannel(channelId) {
  const dataContainer = document.getElementById('moderation-channel-data');
  if (!dataContainer) return;
  dataContainer.innerHTML = '<div class="loading-state">Loading channel moderation…</div>';
  try {
    const response = await api(`/api/moderation/channels/${channelId}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not load channel moderation');
    state.moderation.channel = data.channel;
    const members = data.members || [];
    const memberRows = members.map((member) => `
      <div class="moderation-row">
        <span>${escapeHtml(member.username)}</span>
        <span>${escapeHtml(member.role)}</span>
        <div class="moderation-row-actions">
          ${state.moderation.isSuperadmin ? `<select data-member-role="${member.id}" aria-label="Role for ${escapeHtml(member.username)}"><option value="member"${member.role === 'member' ? ' selected' : ''}>Member</option><option value="moderator"${member.role === 'moderator' ? ' selected' : ''}>Moderator</option></select><button class="btn" data-action="save-role" data-user-id="${member.id}">Save role</button><button class="btn" data-action="remove-member" data-user-id="${member.id}">Remove access</button>` : ''}
          <button class="btn" data-action="timeout" data-user-id="${member.id}">Timeout</button>
        </div>
      </div>`).join('');
    const memberIds = new Set(members.map((member) => Number(member.id)));
    const addableUsers = state.users.filter((user) => !memberIds.has(Number(user.id)));
    dataContainer.innerHTML = `
      <div class="moderation-card">
        <h2>Channel rules</h2>
        <div class="moderation-inline"><label>Slow mode (seconds)<input id="moderation-slowmode" type="number" min="0" max="3600" value="${data.channel.slowmodeSeconds}" ${state.moderation.isSuperadmin || state.moderation.moderatorChannelIds.some((id) => Number(id) === Number(channelId)) ? '' : 'disabled'}></label><button class="btn primary" data-action="save-slowmode">Save</button></div>
      </div>
      ${state.moderation.isSuperadmin ? `
        <form class="moderation-card moderation-inline" data-moderation-form="add-member">
          <h2>Add channel access</h2>
          <select name="userId" required aria-label="Choose a user">${addableUsers.length
            ? addableUsers.map((user) => `<option value="${user.id}">${escapeHtml(user.username)}</option>`).join('')
            : '<option value="">All users already have access</option>'}</select>
          <select name="role" aria-label="Choose a channel role"><option value="member">Member</option><option value="moderator">Moderator</option></select>
          <button class="btn primary" type="submit" ${addableUsers.length ? '' : 'disabled'}>Add user</button>
        </form>` : ''}
      <div class="moderation-card"><h2>Channel members</h2><div class="moderation-list">${memberRows || '<p>No channel members.</p>'}</div></div>
      <div class="moderation-card"><h2>Active timeouts</h2><div class="moderation-list">${(data.timeouts || []).map((timeout) => `
        <div class="moderation-row"><span>${escapeHtml(timeout.username)} · until ${escapeHtml(new Date(timeout.expiresAt).toLocaleString())}${timeout.reason ? ` · ${escapeHtml(timeout.reason)}` : ''}</span><button class="btn" data-action="remove-timeout" data-user-id="${timeout.userId}">Remove timeout</button></div>
      `).join('') || '<p>No active timeouts.</p>'}</div></div>
      <div class="moderation-card"><h2>Open reports</h2><div class="moderation-list">${(data.reports || []).map((report) => `
        <div class="moderation-row moderation-report"><span>Message #${report.messageId} · reported by ${escapeHtml(report.reporterUsername || 'former user')} · ${escapeHtml(report.targetUsername)}: ${escapeHtml(report.reason)}</span><div class="moderation-row-actions"><button class="btn" data-action="resolve-report" data-report-id="${report.id}">Resolve</button><button class="btn" data-action="dismiss-report" data-report-id="${report.id}">Dismiss</button></div></div>
      `).join('') || '<p>No open reports.</p>'}</div></div>
      <div class="moderation-card"><h2>Recent audit log</h2><div class="moderation-list">${(data.auditLog || []).map((entry) => `
        <div class="moderation-row"><span>${escapeHtml(entry.actorUsername || 'former user')} · ${escapeHtml(entry.action)}${entry.targetUsername ? ` · ${escapeHtml(entry.targetUsername)}` : ''} ${entry.details ? ` ${escapeHtml(JSON.stringify(entry.details))}` : ''}</span><time>${escapeHtml(new Date(entry.createdAt).toLocaleString())}</time></div>
      `).join('') || '<p>No moderation actions yet.</p>'}</div></div>`;
  } catch (err) {
    console.error('Load channel moderation error:', err);
    dataContainer.innerHTML = `<div class="empty-state"><h2>Could not load moderation data</h2><p>${escapeHtml(err.message || 'Please try again.')}</p><button class="btn" data-action="refresh-channel">Try again</button></div>`;
  }
}

async function handleModerationClick(event) {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const channelId = Number(document.getElementById('moderation-channel-select')?.value);
  const userId = Number(button.dataset.userId);
  const action = button.dataset.action;
  try {
    if (action === 'refresh-channel') return loadModerationChannel(channelId);
    if (action === 'save-role') {
      const role = document.querySelector(`[data-member-role="${userId}"]`).value;
      await checkedApi(`/api/moderation/channels/${channelId}/members/${userId}`, 'PUT', { role });
    } else if (action === 'remove-member') {
      if (!confirm('Remove this user from the channel?')) return;
      await checkedApi(`/api/moderation/channels/${channelId}/members/${userId}`, 'DELETE');
    } else if (action === 'timeout') {
      const duration = prompt('Timeout duration in minutes (blank uses the workspace default):');
      if (duration === null) return;
      const reason = prompt('Reason (optional):') || '';
      await checkedApi(`/api/moderation/channels/${channelId}/timeouts/${userId}`, 'POST', {
        ...(duration.trim() ? { durationMinutes: Number(duration) } : {}), reason,
      });
    } else if (action === 'remove-timeout') {
      await checkedApi(`/api/moderation/channels/${channelId}/timeouts/${userId}`, 'DELETE');
    } else if (action === 'save-slowmode') {
      await checkedApi(`/api/moderation/channels/${channelId}/slowmode`, 'PATCH', {
        seconds: Number(document.getElementById('moderation-slowmode').value),
      });
    } else if (action === 'resolve-report' || action === 'dismiss-report') {
      await checkedApi(`/api/moderation/reports/${button.dataset.reportId}`, 'PATCH', {
        status: action === 'resolve-report' ? 'resolved' : 'dismissed',
      });
    } else {
      return;
    }
    showToast('Moderation change saved.', 'success');
    await loadModerationChannel(channelId);
  } catch (err) {
    console.error('Moderation action error:', err);
    showToast(err.message || 'Could not apply moderation action.', 'error');
  }
}

async function handleModerationSubmit(event) {
  const form = event.target.closest('[data-moderation-form]');
  if (!form) return;
  event.preventDefault();
  try {
    const values = Object.fromEntries(new FormData(form));
    if (form.dataset.moderationForm === 'settings') {
      const settings = {
        defaultTimeoutMinutes: Number(values.defaultTimeoutMinutes),
        maxTimeoutMinutes: Number(values.maxTimeoutMinutes),
      };
      await checkedApi('/api/moderation/settings', 'PUT', settings);
      state.moderation.settings = settings;
    } else if (form.dataset.moderationForm === 'add-member') {
      const channelId = Number(document.getElementById('moderation-channel-select').value);
      await checkedApi(`/api/moderation/channels/${channelId}/members/${Number(values.userId)}`, 'PUT', { role: values.role });
      await loadModerationChannel(channelId);
    }
    showToast('Moderation settings saved.', 'success');
  } catch (err) {
    console.error('Save moderation form error:', err);
    showToast(err.message || 'Could not save moderation settings.', 'error');
  }
}

async function handleModerationChange(event) {
  if (event.target.id !== 'moderation-channel-select') return;
  await loadModerationChannel(Number(event.target.value));
}

async function handleModerationMessageClick(event) {
  const reportButton = event.target.closest('[data-report-message]');
  const deleteButton = event.target.closest('[data-moderate-delete]');
  if (reportButton) {
    const reason = prompt('Why are you reporting this message?');
    if (reason === null) return;
    try {
      await checkedApi(`/api/moderation/channels/${state.currentChannelId}/reports`, 'POST', {
        messageId: Number(reportButton.dataset.reportMessage), reason,
      });
      showToast('Report sent to channel moderators.', 'success');
    } catch (err) {
      showToast(err.message || 'Could not report this message.', 'error');
    }
  } else if (deleteButton) {
    if (!confirm('Remove this message for everyone?')) return;
    try {
      await checkedApi(`/api/moderation/messages/${deleteButton.dataset.moderateDelete}`, 'DELETE');
      showToast('Message removed.', 'success');
    } catch (err) {
      showToast(err.message || 'Could not remove this message.', 'error');
    }
  }
}

async function checkedApi(url, method, body) {
  const response = await api(url, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function setHuddleStatus(message, type = '') {
  state.huddle.status = message;
  state.huddle.statusType = type;
  const status = document.getElementById('huddle-status');
  if (status) status.textContent = message;
  const badge = document.getElementById('huddle-status-badge');
  if (badge) {
    badge.classList.toggle('connected', type === 'connected');
    badge.classList.toggle('error', type === 'error');
  }
}

function renderHuddleView() {
  const select = document.getElementById('huddle-channel-select');
  const joinButton = document.getElementById('btn-huddle-join');
  const muteButton = document.getElementById('btn-huddle-mute');
  const leaveButton = document.getElementById('btn-huddle-leave');
  const title = document.getElementById('huddle-title');
  if (!select) return;

  const selectedChannelId = state.huddle.channelId
    || select.value
    || state.currentChannelId
    || state.channels[0]?.id;
  select.replaceChildren();

  if (!state.channels.length) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'No channels available';
    select.appendChild(option);
  } else {
    state.channels.forEach((channel) => {
      const option = document.createElement('option');
      option.value = String(channel.id);
      option.textContent = `#${channel.name}`;
      select.appendChild(option);
    });
    select.value = String(selectedChannelId || state.channels[0].id);
  }

  const joined = state.huddle.channelId !== null;
  const channel = state.channels.find((item) => Number(item.id) === Number(selectedChannelId));
  if (title) title.textContent = joined && channel ? `Huddle in #${channel.name}` : 'Channel huddle';
  select.disabled = joined || state.huddle.joining || !state.channels.length;
  if (joinButton) {
    joinButton.disabled = joined || state.huddle.joining || !state.channels.length;
    joinButton.textContent = state.huddle.joining ? 'Connecting…' : joined ? 'In huddle' : 'Join huddle';
  }
  if (muteButton) {
    muteButton.disabled = !joined;
    muteButton.classList.toggle('muted', state.huddle.muted);
    muteButton.title = state.huddle.muted ? 'Unmute microphone' : 'Mute microphone';
    muteButton.setAttribute('aria-label', muteButton.title);
    muteButton.setAttribute('aria-pressed', String(state.huddle.muted));
  }
  if (leaveButton) leaveButton.disabled = !joined && !state.huddle.joining;
  setHuddleStatus(state.huddle.status, state.huddle.statusType);
  renderHuddleParticipants();
}

function renderHuddleParticipants() {
  const container = document.getElementById('huddle-participants');
  if (!container) return;
  container.replaceChildren();

  const participants = Array.from(state.huddle.participants.values());
  if (!participants.length) {
    container.innerHTML = emptyRecordMarkup(
      state.huddle.channelId ? 'You are here first' : 'No one in the huddle yet',
      state.huddle.channelId
        ? 'Others can join from the same channel.'
        : 'Participants will appear here when someone joins.',
      'compact huddle-empty-record',
    );
    return;
  }

  participants.forEach((participant) => {
    const item = document.createElement('div');
    item.className = 'huddle-participant';
    const avatar = document.createElement('span');
    avatar.className = 'huddle-participant-avatar';
    avatar.textContent = (participant.username || 'U').charAt(0).toUpperCase();
    const name = document.createElement('span');
    name.textContent = participant.peerId === state.socket?.id
      ? `${participant.username} (you)`
      : participant.username || 'Workspace member';
    item.append(avatar, name);
    container.appendChild(item);
  });
}

async function joinHuddle() {
  const select = document.getElementById('huddle-channel-select');
  const channelId = Number(select?.value);
  if (!Number.isSafeInteger(channelId) || !state.channels.some((channel) => Number(channel.id) === channelId)) {
    setHuddleStatus('Choose a channel you belong to before joining.', 'error');
    return;
  }
  if (!state.socket?.connected || !state.socketAuthenticated) {
    setHuddleStatus('Connecting to the call server. Try again in a moment.', 'error');
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia || typeof RTCPeerConnection === 'undefined') {
    setHuddleStatus('This environment does not support WebRTC audio.', 'error');
    return;
  }

  state.huddle.joining = true;
  const joinAttempt = ++state.huddle.joinAttempt;
  state.huddle.muted = false;
  setHuddleStatus('Requesting microphone access…');
  renderHuddleView();

  try {
    state.huddle.localStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });
    if (!state.huddle.joining || state.huddle.joinAttempt !== joinAttempt) {
      state.huddle.localStream.getTracks().forEach((track) => track.stop());
      state.huddle.localStream = null;
      return;
    }
    state.huddle.participants.set(state.socket.id, {
      peerId: state.socket.id,
      id: state.user.id,
      username: state.user.username,
    });
    setHuddleStatus('Joining channel huddle…');
    state.socket.emit('huddle:join', channelId);
  } catch (err) {
    if (state.huddle.joinAttempt !== joinAttempt) return;
    console.error('Huddle microphone access failed:', err);
    cleanupHuddle(false);
    const message = err.name === 'NotAllowedError'
      ? 'Microphone access was denied. Allow microphone access in your system settings and try again.'
      : err.name === 'NotFoundError'
        ? 'No microphone was found on this device.'
        : 'Could not start the microphone. Check your audio device and try again.';
    setHuddleStatus(message, 'error');
    renderHuddleView();
  }
}

function handleHuddleJoined(data) {
  if (!state.huddle.joining || !state.huddle.localStream) {
    state.socket.emit('huddle:leave');
    return;
  }

  state.huddle.channelId = data.channelId;
  state.huddle.iceServers = data.iceServers || [];
  state.huddle.joining = false;
  state.huddle.participants.set(state.socket.id, {
    peerId: state.socket.id,
    id: state.user.id,
    username: state.user.username,
  });

  (data.participants || []).forEach((participant) => {
    state.huddle.participants.set(participant.peerId, participant);
  });

  const channel = state.channels.find((item) => Number(item.id) === Number(data.channelId));
  setHuddleStatus(
    `Connected to #${channel?.name || 'channel'}${data.participants?.length ? '' : '. Waiting for others to join.'}`,
    'connected'
  );
  renderHuddleView();

  (data.participants || []).forEach((participant) => {
    createHuddlePeer(participant, true).catch((err) => {
      console.error('Could not create huddle connection:', err);
      setHuddleStatus('Could not connect to a huddle participant.', 'error');
    });
  });
}

async function createHuddlePeer(participant, createOffer = false) {
  const existing = state.huddle.peers.get(participant.peerId);
  if (existing) return existing.connection;

  const connection = new RTCPeerConnection({ iceServers: state.huddle.iceServers });
  const peer = { connection, participant, audio: null, pendingCandidates: [] };
  state.huddle.peers.set(participant.peerId, peer);
  state.huddle.localStream.getTracks().forEach((track) => connection.addTrack(track, state.huddle.localStream));

  connection.onicecandidate = ({ candidate }) => {
    if (candidate && state.socket?.connected) {
      state.socket.emit('huddle:signal', {
        to: participant.peerId,
        signal: { candidate: candidate.toJSON() },
      });
    }
  };
  connection.ontrack = (event) => {
    const stream = event.streams[0];
    if (!stream) return;
    if (!peer.audio) {
      peer.audio = document.createElement('audio');
      peer.audio.autoplay = true;
      peer.audio.playsInline = true;
      peer.audio.dataset.peerId = participant.peerId;
      document.getElementById('huddle-audio-container')?.appendChild(peer.audio);
    }
    peer.audio.srcObject = stream;
    peer.audio.play().catch((err) => {
      console.error('Remote huddle audio playback failed:', err);
      setHuddleStatus('Remote audio playback was blocked by the system.', 'error');
    });
  };
  connection.onconnectionstatechange = () => {
    if (connection.connectionState === 'failed') {
      setHuddleStatus('Audio connection failed. This network may require a TURN server.', 'error');
    }
  };

  if (createOffer) {
    const offer = await connection.createOffer();
    await connection.setLocalDescription(offer);
    state.socket.emit('huddle:signal', {
      to: participant.peerId,
      signal: { description: connection.localDescription.toJSON() },
    });
  }

  return connection;
}

async function handleHuddleSignal(message) {
  if (!state.huddle.channelId || !message.from || !message.signal) return;

  const participant = {
    peerId: message.from,
    id: message.id,
    username: message.username,
  };
  state.huddle.participants.set(participant.peerId, participant);
  const connection = await createHuddlePeer(participant);
  const peer = state.huddle.peers.get(participant.peerId);

  if (message.signal.description) {
    await connection.setRemoteDescription(new RTCSessionDescription(message.signal.description));
    for (const candidate of peer.pendingCandidates.splice(0)) {
      await connection.addIceCandidate(new RTCIceCandidate(candidate));
    }
    if (message.signal.description.type === 'offer') {
      const answer = await connection.createAnswer();
      await connection.setLocalDescription(answer);
      state.socket.emit('huddle:signal', {
        to: participant.peerId,
        signal: { description: connection.localDescription.toJSON() },
      });
    }
  } else if (message.signal.candidate) {
    const candidate = new RTCIceCandidate(message.signal.candidate);
    if (connection.remoteDescription) {
      await connection.addIceCandidate(candidate);
    } else {
      peer.pendingCandidates.push(message.signal.candidate);
    }
  }
  renderHuddleParticipants();
}

function removeHuddlePeer(peerId) {
  const peer = state.huddle.peers.get(peerId);
  if (peer) {
    peer.connection.close();
    peer.audio?.remove();
    state.huddle.peers.delete(peerId);
  }
  state.huddle.participants.delete(peerId);
  renderHuddleParticipants();
}

function cleanupHuddle(notifyServer = true) {
  state.huddle.joinAttempt += 1;
  if (notifyServer && state.socket?.connected && (state.huddle.channelId || state.huddle.joining)) {
    state.socket.emit('huddle:leave');
  }
  state.huddle.peers.forEach((peer) => {
    peer.connection.close();
    peer.audio?.remove();
  });
  state.huddle.localStream?.getTracks().forEach((track) => track.stop());
  state.huddle.localStream = null;
  state.huddle.peers.clear();
  state.huddle.participants.clear();
  state.huddle.channelId = null;
  state.huddle.iceServers = [];
  state.huddle.joining = false;
  state.huddle.muted = false;
  const audioContainer = document.getElementById('huddle-audio-container');
  if (audioContainer) audioContainer.replaceChildren();
  setHuddleStatus('Choose a channel and join to start an audio huddle.');
  renderHuddleView();
}

function toggleHuddleMute() {
  if (!state.huddle.localStream) return;
  state.huddle.muted = !state.huddle.muted;
  state.huddle.localStream.getAudioTracks().forEach((track) => {
    track.enabled = !state.huddle.muted;
  });
  renderHuddleView();
}

function renderActivity() {
  const unread = state.channels.filter((c) => (c.unreadCount || 0) > 0);
  const grid = els.activityGrid;
  if (grid) {
    grid.classList.toggle('has-empty-record', unread.length === 0);
    if (unread.length === 0) {
      grid.innerHTML = emptyRecordMarkup(
        'You are all caught up',
        'Channels with unread messages will appear here.',
      );
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
    els.activityList.classList.toggle('has-empty-record', unread.length === 0);
    if (unread.length === 0) {
      els.activityList.innerHTML = emptyRecordMarkup(
        'All caught up',
        'No unread channels.',
        'compact sidebar-empty-record',
      );
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
    openCreateCanvas();
  } else if (kind === 'list') {
    openCreateList();
  }
}

async function openCreateList() {
  await setSection('lists');
  if (els.listsChannelSelect?.disabled) {
    showToast('Choose a channel before creating a shared list.', 'error');
    return;
  }
  openNewListForm();
}

function handleAccountAction(action) {
  if (action === 'signout') {
    handleLogout();
    return;
  }
  if (action === 'profile') {
    openProfileModal();
  } else if (action === 'preferences') {
    openPreferencesModal();
  } else if (action === 'account') {
    openAccountModal();
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
      showToast('Ctrl+K search · Ctrl+N new message · Esc cancels reply or closes menus');
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
  grid.classList.remove('files-empty-grid');
  grid.classList.add('files-state-grid');
  grid.innerHTML = '<div class="files-message-state">Loading files…</div>';
  try {
    const res = await api('/api/files');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to load files');
    renderFiles(data.files || []);
  } catch (err) {
    console.error('Load files error:', err);
    grid.innerHTML = '<div class="files-message-state"><div><h2>Could not load files</h2><p>Check that the server is running.</p></div></div>';
  }
}

function renderFiles(files) {
  const grid = els.filesGrid;
  if (!grid) return;
  state.files = files;
  if (!files.length) {
    grid.classList.remove('files-state-grid');
    grid.classList.add('files-empty-grid');
    grid.innerHTML = emptyRecordMarkup(
      'No files yet',
      'Files you attach to messages appear here.',
      'files-empty-state',
    );
    return;
  }
  grid.classList.remove('files-empty-grid', 'files-state-grid');
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
      ${Number(f.uploadedBy) === Number(state.user.id) || (f.channelId && canModerateChannel(f.channelId)) ? `<button class="file-card-delete" type="button" data-delete-file="${escapeHtml(String(f.id))}" data-file-name="${escapeHtml(f.name)}" data-moderator-delete="${Number(f.uploadedBy) !== Number(state.user.id)}">${Number(f.uploadedBy) === Number(state.user.id) ? 'Delete attachment' : 'Remove attachment'}</button>` : ''}
    `;
    card.addEventListener('click', (event) => {
      if (event.target.closest('[data-delete-file]')) return;
      downloadFile(f.id, f.name);
    });
    card.querySelector('[data-delete-file]')?.addEventListener('click', (event) => {
      event.stopPropagation();
      deleteFileAttachment(
        f.id,
        f.name,
        Number(f.uploadedBy) !== Number(state.user.id) && Boolean(f.channelId && canModerateChannel(f.channelId)),
      );
    });
    grid.appendChild(card);
  });
}

function canModerateChannel(channelId) {
  return state.moderation.isSuperadmin
    || state.moderation.moderatorChannelIds.some((id) => Number(id) === Number(channelId));
}

async function deleteFileAttachment(fileId, name, requireReason = false) {
  const reason = requireReason
    ? prompt(`Why are you removing "${name}"? (Required, up to 500 characters)`)
    : '';
  if (requireReason && !reason?.trim()) return;
  if (reason && reason.trim().length > 500) {
    showToast('The reason must be 500 characters or fewer.', 'error');
    return;
  }
  if (!confirm(`Delete "${name}" for everyone? This cannot be undone.`)) return;

  try {
    const res = await api(`/api/files/${fileId}`, {
      method: 'DELETE',
      ...(requireReason ? { body: JSON.stringify({ reason: reason.trim() }) } : {}),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not delete the attachment');
    handleFileDeleted({ fileId: data.fileId });
    showToast('Attachment deleted for everyone.', 'success');
  } catch (err) {
    console.error('Delete attachment error:', err);
    if (state.section === 'files') await loadFiles();
    showToast(err.message || 'Could not delete the attachment.', 'error');
  }
}

function handleFileDeleted(event) {
  const fileId = String(event.fileId);
  let channelMessagesChanged = false;
  for (const [channelId, messages] of Object.entries(state.messages)) {
    for (const message of messages) {
      const previousCount = (message.attachments || []).length;
      message.attachments = (message.attachments || []).filter((file) => String(file.id) !== fileId);
      if (message.attachments.length !== previousCount && Number(state.currentChannelId) === Number(channelId)) {
        channelMessagesChanged = true;
      }
    }
  }
  if (channelMessagesChanged && state.view === 'channel') {
    renderMessages('messages', state.messages[state.currentChannelId]);
  }

  let dmMessagesChanged = false;
  for (const messages of Object.values(state.directMessages)) {
    for (const message of messages) {
      if ((message.attachments || []).some((file) => String(file.id) === fileId)) {
        dmMessagesChanged = true;
      }
      message.attachments = (message.attachments || []).filter((file) => String(file.id) !== fileId);
    }
  }
  if (dmMessagesChanged && state.currentDMId && state.view === 'dm') {
    renderMessages('dm-messages', state.directMessages[state.currentDMId] || []);
  }

  for (const messages of Object.values(state.pinnedMessages)) {
    for (const message of messages) {
      message.attachments = (message.attachments || []).filter((file) => String(file.id) !== fileId);
    }
  }
  if (state.currentChannelId && state.pinPanelOpen) renderPinnedMessages(state.currentChannelId);

  if (state.section === 'files') {
    renderFiles((state.files || []).filter((file) => String(file.id) !== fileId));
  } else {
    state.files = (state.files || []).filter((file) => String(file.id) !== fileId);
  }
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
  grid.classList.remove('has-empty-record');
  grid.innerHTML = '<div class="empty-state" style="padding:24px;">Loading notes…</div>';
  try {
    const res = await api('/api/notes');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to load notes');
    notesCache = data.notes || [];
    renderNotes(notesCache);
  } catch (err) {
    console.error('Load notes error:', err);
    grid.classList.remove('has-empty-record');
    grid.innerHTML = `<div class="empty-state" style="padding:24px;"><h2>Could not load notes</h2><p style="color:var(--text-muted);">Check that the server is running.</p></div>`;
  }
}

function renderNotes(notes) {
  const grid = els.notesGrid;
  if (!grid) return;
  grid.classList.toggle('has-empty-record', notes.length === 0);
  if (!notes.length) {
    grid.innerHTML = emptyRecordMarkup(
      'No notes yet',
      'Use "New note" to write something down.',
    );
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
// Shared channel lists
// ============================================================
function populateListsChannelSelect() {
  const select = els.listsChannelSelect;
  if (!select) return;
  const selectedChannelId = select.value || String(state.currentChannelId || state.channels[0]?.id || '');
  select.innerHTML = '';
  state.channels.forEach((channel) => {
    const option = document.createElement('option');
    option.value = channel.id;
    option.textContent = `#${channel.name}`;
    select.appendChild(option);
  });
  if (state.channels.some((channel) => String(channel.id) === selectedChannelId)) {
    select.value = selectedChannelId;
  }
  select.disabled = state.channels.length === 0;
  const createButton = document.getElementById('btn-new-list');
  if (createButton) createButton.disabled = state.channels.length === 0;
}

async function loadLists() {
  const channelId = Number(els.listsChannelSelect?.value);
  const requestId = ++state.listsRequestId;
  els.listsContainer.classList.remove('has-empty-record');
  if (!Number.isSafeInteger(channelId) || channelId < 1) {
    state.lists = [];
    state.listMembers = [];
    renderLists();
    return;
  }
  els.listsContainer.innerHTML = '<div class="empty-state"><p>Loading lists…</p></div>';
  try {
    const res = await api(`/api/lists?channelId=${channelId}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to load lists');
    if (requestId !== state.listsRequestId) return;
    state.lists = data.lists || [];
    state.listMembers = data.members || [];
    renderLists();
  } catch (err) {
    if (requestId !== state.listsRequestId) return;
    console.error('Load lists error:', err);
    els.listsContainer.classList.remove('has-empty-record');
    els.listsContainer.innerHTML = '<div class="empty-state"><h2>Could not load lists</h2><p>Check your channel access and try again.</p></div>';
  }
}

function openNewListForm() {
  if (els.listsChannelSelect?.disabled) {
    showToast('Join a channel before creating a shared list.', 'error');
    return;
  }
  const form = document.getElementById('lists-create-form');
  form.hidden = false;
  document.getElementById('new-list-title').focus();
}

function closeNewListForm() {
  const form = document.getElementById('lists-create-form');
  form.reset();
  form.hidden = true;
}

async function createList(event) {
  event.preventDefault();
  const channelId = Number(els.listsChannelSelect.value);
  const titleInput = document.getElementById('new-list-title');
  const title = titleInput.value.trim();
  try {
    const res = await api('/api/lists', {
      method: 'POST',
      body: JSON.stringify({ channelId, title }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not create list');
    closeNewListForm();
    await loadLists();
    showToast('List created.', 'success');
  } catch (err) {
    console.error('Create list error:', err);
    showToast(err.message || 'Could not create list.', 'error');
  }
}

function renderLists() {
  const container = els.listsContainer;
  if (!container) return;
  if (state.channels.length === 0) {
    container.classList.add('has-empty-record');
    container.innerHTML = emptyRecordMarkup(
      'No channels yet',
      'Create or join a channel to share a list.',
    );
    return;
  }
  if (state.lists.length === 0) {
    container.classList.add('has-empty-record');
    container.innerHTML = emptyRecordMarkup(
      'No lists in this channel',
      'Create a list to plan and track shared work.',
    );
    return;
  }

  container.classList.remove('has-empty-record');
  container.innerHTML = state.lists.map((list) => {
    const completed = list.items.filter((item) => item.completed).length;
    const items = list.items.map((item) => `
      <div class="shared-list-item${item.completed ? ' completed' : ''}">
        <label class="shared-list-item-main">
          <input type="checkbox" data-list-item-completed="${item.id}" aria-label="Mark ${escapeHtml(item.title)} complete"${item.completed ? ' checked' : ''}>
          <span>${escapeHtml(item.title)}</span>
        </label>
        <span class="shared-list-item-meta">${escapeHtml(item.assigneeName || 'Unassigned')}${item.dueDate ? ` · Due ${escapeHtml(String(item.dueDate).slice(0, 10))}` : ''}</span>
        <button class="btn-list-delete-item" type="button" data-delete-list-item="${item.id}" aria-label="Delete ${escapeHtml(item.title)}" title="Delete item">×</button>
      </div>`).join('');
    const assignees = [
      '<option value="">Unassigned</option>',
      ...state.listMembers.map((member) => `<option value="${member.id}">${escapeHtml(member.username)}</option>`),
    ].join('');
    return `
      <article class="card shared-list-card" data-list-id="${list.id}">
        <div class="shared-list-card-header">
          <div>
            <h2>${escapeHtml(list.title)}</h2>
            <span class="meta">${completed} of ${list.items.length} complete</span>
          </div>
          <button class="btn-list-delete" type="button" data-delete-list="${list.id}" aria-label="Delete ${escapeHtml(list.title)}" title="Delete list">Delete</button>
        </div>
        <div class="shared-list-items">${items || '<p class="shared-list-empty">No items yet.</p>'}</div>
        <form class="shared-list-item-form" data-add-list-item="${list.id}">
          <input type="text" name="title" maxlength="200" required placeholder="Add an item" aria-label="New item title">
          <select name="assigneeId" aria-label="Assign to">${assignees}</select>
          <input type="date" name="dueDate" aria-label="Due date">
          <button class="btn primary" type="submit">Add</button>
        </form>
      </article>`;
  }).join('');
}

async function handleListContainerSubmit(event) {
  const form = event.target.closest('form[data-add-list-item]');
  if (!form) return;
  event.preventDefault();
  const listId = form.dataset.addListItem;
  const formData = new FormData(form);
  try {
    const res = await api(`/api/lists/${listId}/items`, {
      method: 'POST',
      body: JSON.stringify({
        title: formData.get('title'),
        assigneeId: formData.get('assigneeId') || null,
        dueDate: formData.get('dueDate') || null,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not add list item');
    await loadLists();
    showToast('Item added.', 'success');
  } catch (err) {
    console.error('Add list item error:', err);
    showToast(err.message || 'Could not add item.', 'error');
  }
}

async function handleListContainerChange(event) {
  const checkbox = event.target.closest('input[data-list-item-completed]');
  if (!checkbox) return;
  const listCard = checkbox.closest('[data-list-id]');
  await updateListItem(listCard.dataset.listId, checkbox.dataset.listItemCompleted, {
    completed: checkbox.checked,
  });
}

async function handleListContainerClick(event) {
  const deleteListButton = event.target.closest('[data-delete-list]');
  if (deleteListButton) {
    const list = state.lists.find((entry) => String(entry.id) === deleteListButton.dataset.deleteList);
    if (!list || !confirm(`Delete "${list.title}" and all its items?`)) return;
    try {
      const res = await api(`/api/lists/${list.id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Could not delete list');
      await loadLists();
      showToast('List deleted.', 'success');
    } catch (err) {
      console.error('Delete list error:', err);
      showToast('Could not delete list.', 'error');
    }
    return;
  }

  const deleteItemButton = event.target.closest('[data-delete-list-item]');
  if (!deleteItemButton) return;
  const listCard = deleteItemButton.closest('[data-list-id]');
  try {
    const res = await api(`/api/lists/${listCard.dataset.listId}/items/${deleteItemButton.dataset.deleteListItem}`, {
      method: 'DELETE',
    });
    if (!res.ok) throw new Error('Could not delete item');
    await loadLists();
    showToast('Item deleted.', 'success');
  } catch (err) {
    console.error('Delete list item error:', err);
    showToast('Could not delete item.', 'error');
  }
}

async function updateListItem(listId, itemId, changes) {
  try {
    const res = await api(`/api/lists/${listId}/items/${itemId}`, {
      method: 'PATCH',
      body: JSON.stringify(changes),
    });
    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || 'Could not update item');
    }
    await loadLists();
  } catch (err) {
    console.error('Update list item error:', err);
    showToast(err.message || 'Could not update item.', 'error');
    await loadLists();
  }
}

// ============================================================
// Channel-shared Markdown canvases
// ============================================================
function populateCanvasChannelSelect() {
  const select = els.canvasChannelSelect;
  if (!select) return;
  const selectedChannelId = select.value
    || String(state.canvasChannelId || state.currentChannelId || state.channels[0]?.id || '');
  select.innerHTML = '';
  state.channels.forEach((channel) => {
    const option = document.createElement('option');
    option.value = channel.id;
    option.textContent = `#${channel.name}`;
    select.appendChild(option);
  });
  if (state.channels.some((channel) => String(channel.id) === selectedChannelId)) {
    select.value = selectedChannelId;
  }
  select.disabled = state.channels.length === 0;
  const createButton = document.getElementById('btn-new-canvas');
  if (createButton) createButton.disabled = state.channels.length === 0;
}

async function openCreateCanvas() {
  await setSection('canvases');
  if (els.canvasChannelSelect?.disabled) {
    showToast('Join a channel before creating a canvas.', 'error');
    return;
  }
  createNewCanvas();
}

async function handleCanvasChannelChange() {
  if (state.canvasDirty && !confirm('Discard unsaved canvas changes?')) {
    els.canvasChannelSelect.value = String(state.canvasChannelId || '');
    return;
  }
  state.canvasDirty = false;
  state.currentCanvasId = null;
  state.canvasChannelId = null;
  await loadCanvases();
}

async function loadCanvases() {
  const channelId = Number(els.canvasChannelSelect?.value);
  const requestId = ++state.canvasRequestId;
  if (!Number.isSafeInteger(channelId) || channelId < 1) {
    state.canvasDetailRequestId += 1;
    state.canvases = [];
    state.currentCanvasId = null;
    state.canvasChannelId = null;
    renderCanvasDocList();
    clearCanvasEditor('Join a channel to create a canvas.');
    return;
  }
  if (state.canvasDirty && state.canvasChannelId === channelId) return;

  state.canvasDetailRequestId += 1;
  els.canvasDocList.innerHTML = '<div class="empty-state"><p>Loading canvases…</p></div>';
  try {
    const res = await api(`/api/canvases?channelId=${channelId}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to load canvases');
    if (requestId !== state.canvasRequestId) return;
    state.canvases = data.canvases || [];
    state.canvasChannelId = channelId;
    renderCanvasDocList();
    const currentExists = state.canvases.some((canvas) => canvas.id === state.currentCanvasId);
    if (currentExists) {
      await openCanvas(state.currentCanvasId, false);
    } else if (state.canvases.length > 0) {
      await openCanvas(state.canvases[0].id, false);
    } else {
      clearCanvasEditor('No canvases in this channel yet. Create one to get started.');
    }
  } catch (err) {
    if (requestId !== state.canvasRequestId) return;
    console.error('Load canvases error:', err);
    state.canvases = [];
    els.canvasDocList.innerHTML = '<div class="empty-state canvas-doc-list-error">Could not load canvases.</div>';
    clearCanvasEditor('Check your channel access and try again.', true);
  }
}

async function openCanvas(canvasId, confirmDiscard = true) {
  if (confirmDiscard && state.canvasDirty && !confirm('Discard unsaved canvas changes?')) return;
  const requestId = ++state.canvasDetailRequestId;
  try {
    const res = await api(`/api/canvases/${canvasId}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to load canvas');
    if (requestId !== state.canvasDetailRequestId) return;
    const canvas = data.canvas;
    state.currentCanvasId = canvas.id;
    state.canvasChannelId = canvas.channelId;
    state.canvasDirty = false;
    els.canvasTitleInput.value = canvas.title;
    els.canvasContentInput.value = canvas.content;
    els.canvasEditorForm.hidden = false;
    els.canvasEmptyState.hidden = true;
    document.getElementById('btn-delete-canvas').disabled = false;
    renderCanvasDocList();
    renderCanvasPreview();
  } catch (err) {
    if (requestId !== state.canvasDetailRequestId) return;
    console.error('Open canvas error:', err);
    showToast('Could not open canvas.', 'error');
  }
}

function renderCanvasDocList() {
  if (!els.canvasDocList) return;
  if (state.canvases.length === 0) {
    els.canvasDocList.innerHTML = emptyRecordMarkup(
      'No canvases',
      'Create one to get started.',
      'compact canvas-doc-empty-record',
    );
    return;
  }
  els.canvasDocList.innerHTML = state.canvases.map((canvas) => `
    <button class="canvas-doc-item${canvas.id === state.currentCanvasId ? ' active' : ''}"
      type="button" data-canvas-id="${canvas.id}" aria-current="${canvas.id === state.currentCanvasId ? 'page' : 'false'}">
      <span>${escapeHtml(canvas.title)}</span>
      <small>Updated ${shortTime(canvas.updatedAt)}</small>
    </button>`).join('');
}

function handleCanvasDocSelect(event) {
  const button = event.target.closest('[data-canvas-id]');
  if (button) openCanvas(button.dataset.canvasId);
}

function createNewCanvas() {
  if (els.canvasChannelSelect?.disabled) {
    showToast('Join a channel before creating a canvas.', 'error');
    return;
  }
  if (state.canvasDirty && !confirm('Discard unsaved canvas changes?')) return;
  state.canvasDetailRequestId += 1;
  state.currentCanvasId = null;
  state.canvasChannelId = Number(els.canvasChannelSelect.value);
  state.canvasDirty = false;
  els.canvasTitleInput.value = '';
  els.canvasContentInput.value = '';
  els.canvasEditorForm.hidden = false;
  els.canvasEmptyState.hidden = true;
  document.getElementById('btn-delete-canvas').disabled = true;
  els.canvasTitleInput.focus();
  renderCanvasDocList();
  renderCanvasPreview();
}

function clearCanvasEditor(message, isError = false) {
  state.currentCanvasId = null;
  state.canvasDirty = false;
  els.canvasEditorForm.hidden = true;
  els.canvasEmptyState.hidden = false;
  document.getElementById('btn-delete-canvas').disabled = true;
  els.canvasEmptyState.innerHTML = isError
    ? `<div class="canvas-empty-message"><h2>Could not load canvases</h2><p>${escapeHtml(message)}</p></div>`
    : emptyRecordMarkup('No canvas selected', message);
}

function markCanvasDirty() {
  state.canvasDirty = true;
  renderCanvasPreview();
}

async function saveCanvas(event) {
  event.preventDefault();
  const channelId = Number(els.canvasChannelSelect.value);
  const title = els.canvasTitleInput.value.trim();
  const content = els.canvasContentInput.value;
  if (!Number.isSafeInteger(channelId) || channelId < 1) {
    showToast('Choose a channel before saving.', 'error');
    return;
  }
  if (!title) {
    els.canvasTitleInput.focus();
    showToast('Canvas title is required.', 'error');
    return;
  }

  const isNew = state.currentCanvasId === null;
  try {
    const res = await api(isNew ? '/api/canvases' : `/api/canvases/${state.currentCanvasId}`, {
      method: isNew ? 'POST' : 'PUT',
      body: JSON.stringify({ channelId, title, content }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not save canvas');
    state.currentCanvasId = data.canvas.id;
    state.canvasChannelId = data.canvas.channelId;
    state.canvasDirty = false;
    await loadCanvases();
    showToast('Canvas saved.', 'success');
  } catch (err) {
    console.error('Save canvas error:', err);
    showToast(err.message || 'Could not save canvas.', 'error');
  }
}

async function deleteCanvas() {
  if (!state.currentCanvasId || !confirm(`Delete "${els.canvasTitleInput.value}"?`)) return;
  try {
    const res = await api(`/api/canvases/${state.currentCanvasId}`, { method: 'DELETE' });
    if (!res.ok) throw new Error('Could not delete canvas');
    state.currentCanvasId = null;
    state.canvasDirty = false;
    await loadCanvases();
    showToast('Canvas deleted.', 'success');
  } catch (err) {
    console.error('Delete canvas error:', err);
    showToast('Could not delete canvas.', 'error');
  }
}

function renderCanvasPreview() {
  if (!els.canvasPreview || !els.canvasContentInput) return;
  els.canvasPreview.innerHTML = renderMarkdown(els.canvasContentInput.value);
}

function renderMarkdown(markdown) {
  const lines = String(markdown).split(/\r?\n/);
  const output = [];
  let listOpen = false;
  let codeLines = null;
  const closeList = () => {
    if (!listOpen) return;
    output.push('</ul>');
    listOpen = false;
  };
  const renderInline = (value) => escapeHtml(value)
    .split(/(`[^`]+`|\*\*.+?\*\*|\*[^*]+\*)/g)
    .map((token) => {
      if (token.startsWith('`') && token.endsWith('`')) return `<code>${token.slice(1, -1)}</code>`;
      if (token.startsWith('**') && token.endsWith('**')) return `<strong>${token.slice(2, -2)}</strong>`;
      if (token.startsWith('*') && token.endsWith('*')) return `<em>${token.slice(1, -1)}</em>`;
      return token;
    }).join('');

  lines.forEach((line) => {
    if (line.startsWith('```')) {
      closeList();
      if (codeLines === null) codeLines = [];
      else {
        output.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
        codeLines = null;
      }
      return;
    }
    if (codeLines !== null) {
      codeLines.push(line);
      return;
    }
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) {
      closeList();
      const level = heading[1].length;
      output.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
    } else if (/^\s*[-*]\s+/.test(line)) {
      if (!listOpen) {
        output.push('<ul>');
        listOpen = true;
      }
      output.push(`<li>${renderInline(line.replace(/^\s*[-*]\s+/, ''))}</li>`);
    } else if (line.trim() === '') {
      closeList();
    } else {
      closeList();
      output.push(`<p>${renderInline(line)}</p>`);
    }
  });
  if (codeLines !== null) output.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
  closeList();
  return output.join('') || '<p class="canvas-preview-empty">Nothing to preview yet.</p>';
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
};

// Start
init();
