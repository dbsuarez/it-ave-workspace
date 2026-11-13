// IT Avenue Workspace - Renderer (Main Chat Window)
// Handles UI, Socket.io connection, and all chat interactions

// electronAPI is exposed on window by the preload (contextBridge)
// Reference it directly - re-declaring it triggers a global parse error
// ("Identifier 'electronAPI' has already been declared"), which kills the
// renderer before any handler is attached.

const ICON_REACT = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="13" r="8"/><path d="M7.6 15.2s1.3 1.9 3.4 1.9 3.4-1.9 3.4-1.9"/><line x1="8.6" y1="11" x2="8.61" y2="11"/><line x1="13.4" y1="11" x2="13.41" y2="11"/><line x1="19.5" y1="2.3" x2="19.5" y2="6.7"/><line x1="17.3" y1="4.5" x2="21.7" y2="4.5"/></svg>';

const ICON_REPLY = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="10 16 5 11 10 6"/><path d="M5 11h9a5 5 0 0 1 5 5v2.5"/></svg>';

const ICON_MORE = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><circle cx="12" cy="5" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="12" cy="19" r="1.7"/></svg>';

const ICON_DOWNLOAD = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12"/><polyline points="7 10 12 15 17 10"/><line x1="4" y1="20" x2="20" y2="20"/></svg>';

const ICON_TRASH = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1.5 14a2 2 0 0 1-2 2h-11a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>';

function messageMoreMenuHtml(msg, isYou, canModerate) {
  const id = escapeHtml(String(msg.id));
  const pinned = Boolean(msg.pinned || msg.pinnedAt);
  const edited = Boolean(msg.editedAt && !msg.pending);
  const saved = typeof savedItemForMessage === 'function' && Boolean(savedItemForMessage(msg.id));
  const attachments = msg.attachments || [];
  const channelId = msg.channelId || state.currentChannelId;
  const canRemoveAttachment = (a) =>
    Number(a.uploadedBy) === Number(state.user.id) || canModerateChannel(channelId);
  const imageAttachments = attachments.filter((a) => (a.mimeType || '').toLowerCase().startsWith('image/'));
  const imageItems = imageAttachments.map((a, index) => {
    const aid = escapeHtml(String(a.id));
    const aname = escapeHtml(a.filename || 'image');
    const multiple = imageAttachments.length > 1;
    const label = multiple ? ` <span class="menu-kbd">${escapeHtml(a.filename || '')}</span>` : '';
    const canRemove = canRemoveAttachment(a);
    const removeLabel = !Number(a.uploadedBy) || Number(a.uploadedBy) === Number(state.user.id)
      ? 'Remove image'
      : 'Remove image for everyone';
    return `<button class="menu-item" type="button" role="menuitem" data-copy-image="${aid}">Copy image${label}</button>
      <button class="menu-item" type="button" role="menuitem" data-download-image="${aid}" data-image-name="${aname}">Download image${label}</button>
      ${canRemove ? `<button class="menu-item danger" type="button" role="menuitem" data-remove-image="${aid}" data-image-name="${aname}" data-moderator="${Number(a.uploadedBy) !== Number(state.user.id)}">${removeLabel}${label}</button>` : ''}${index < imageAttachments.length - 1 ? '<div class="menu-sep"></div>' : ''}`;
  }).join('');
  return `
    <div class="menu msg-more-menu" data-more-menu="${id}" role="menu" aria-label="More actions">
      ${imageItems}
      ${imageItems ? '<div class="menu-sep"></div>' : ''}
      <button class="menu-item" type="button" role="menuitem" data-message-pin="${id}" data-pinned="${pinned}">${pinned ? 'Unpin message' : 'Pin message'}</button>
      <button class="menu-item" type="button" role="menuitem" data-save-message="${id}">${saved ? 'Unsave message' : 'Save message'}</button>
      <button class="menu-item" type="button" role="menuitem" data-remind-message="${id}">Remind me</button>
      ${edited ? `<button class="menu-item" type="button" role="menuitem" data-message-edits="${id}">Earlier versions</button>` : ''}
      ${isYou ? `<button class="menu-item" type="button" role="menuitem" data-edit-message="${id}">Edit</button>
      <div class="menu-sep"></div>
      <button class="menu-item danger" type="button" role="menuitem" data-delete-own-message="${id}">Delete message</button>` : ''}
      ${!isYou ? `<button class="menu-item" type="button" role="menuitem" data-report-message="${id}">Report</button>` : ''}
      ${!isYou && canModerate ? `<button class="menu-item danger" type="button" role="menuitem" data-moderate-delete="${id}">Remove for everyone</button>` : ''}
    </div>`;
}

// Configuration
const API_BASE = window.electronAPI?.apiBase || 'http://127.0.0.1:3001';
const SOCKET_URL = window.electronAPI?.socketUrl || 'http://127.0.0.1:3001';
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
    soundTheme: 'chime',   // the default notification sound
    soundVolume: 70,
  },
  huddle: {
    channelId: null,
    direct: null,   // { userId, username } while in (or starting) a one-to-one call
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
  moderation: { isSuperadmin: false, isHr: false, canManageChannels: false, canManageWorkspace: false, canCreateChannels: false, moderatorChannelIds: [], channel: null, settings: null, tab: 'channels' },
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
  editTopicBtn: document.getElementById('btn-edit-topic'),
  channelTopicForm: document.getElementById('channel-topic-form'),
  channelTopicInput: document.getElementById('channel-topic-input'),
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
  userProfileModal: document.getElementById('modal-user-profile'),
  userContextMenu: document.getElementById('user-context-menu'),
  userContextName: document.getElementById('user-context-name'),
  userContextStatus: document.getElementById('user-context-status'),
  userContextProfile: document.getElementById('user-context-profile'),
  userContextPersonalPage: document.getElementById('user-context-personal-page'),
  userContextSep: document.getElementById('user-context-sep'),
  userContextMessage: document.getElementById('user-context-message'),
  userContextEdit: document.getElementById('user-context-edit'),
  userContextPreferences: document.getElementById('user-context-preferences'),
  userContextSignout: document.getElementById('user-context-signout'),
  userProfileAvatar: document.getElementById('user-profile-avatar'),
  userProfileName: document.getElementById('user-profile-name'),
  userProfileDot: document.getElementById('user-profile-dot'),
  userProfileStatusText: document.getElementById('user-profile-status-text'),
  userProfileEmail: document.getElementById('user-profile-email'),
  userProfileEmailRow: document.getElementById('user-profile-email-row'),
  userProfileMemberSince: document.getElementById('user-profile-member-since'),
  userProfileLastSeen: document.getElementById('user-profile-last-seen'),
  userProfileMessageBtn: document.getElementById('btn-user-profile-message'),
  userProfileEditBtn: document.getElementById('btn-user-profile-edit'),
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
  canvasSheet: document.getElementById('canvas-sheet'),
  canvasSheetKind: document.getElementById('canvas-sheet-kind'),
  canvasSheetTitle: document.getElementById('canvas-sheet-title'),
  canvasSheetEditor: document.getElementById('canvas-sheet-editor'),
  canvasSheetStatus: document.getElementById('canvas-sheet-status'),
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
    const viewing = typeof viewAsClaims === 'function' ? viewAsClaims(storedToken) : null;
    showApp();
    updateRail('home');
    showPane('home');
    if (viewing) {
      // View as: read-only, no live connection, and none of the person's private things (see features/view-as.js)
      applyViewAsMode(viewing);
      connectSocket(); // listen-only: the server joins it to the person's channels, never as them
      loadChannels();
      loadUsers();
      loadModerationAccess();
      loadUserGroups();
      loadRoleMentions();
      // their private screens too: real while Pre-launch (testing), made-up samples once Live; read-only either way
      loadActivity();
      loadUserSettings();
      loadGroups();
      loadSaved();
      loadReminders();
      loadSidebarLayout();
    } else {
    connectSocket();
    loadChannels();
    loadUsers();
    loadModerationAccess();
    loadActivity();
    loadUserSettings();
    loadGroups();
    loadSaved();
    loadReminders();
    loadSidebarLayout();
    loadUserGroups();
    loadRoleMentions();
    // Presence keepalive / refresh: mark self online and re-render dot colors
    startPresenceLoop();
    }
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
    if (mod && e.shiftKey && (e.key === 'i' || e.key === 'I') && state.user?.isSuperadmin) {
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
      if (els.canvasSheet?.getAttribute('aria-hidden') === 'false') { closeCanvas2(); return; }
      if (document.getElementById('image-viewer-modal')?.classList.contains('open')) { closeImageViewer(); return; }
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

  // More menu (Lists, Canvas, Wiki)
  on('btn-rail-more', 'click', (e) => { e.stopPropagation(); toggleMenu('more-menu', 'btn-rail-more'); });
  document.querySelectorAll('#more-menu [data-more-section]').forEach((item) => {
    item.addEventListener('click', () => {
      closeAllMenus();
      setSection(item.dataset.moreSection);
    });
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
  // opening the account menu first catches up with the account, so the name and email are never stale
  on('btn-user-menu', 'click', (e) => { e.stopPropagation(); refreshOwnProfile(); toggleMenu('user-menu', 'btn-user-menu'); });
  document.querySelectorAll('#user-menu .menu-item').forEach((item) => {
    item.addEventListener('click', () => {
      closeAllMenus();
      handleAccountAction(item.dataset.account);
    });
  });

  // User context menu (avatars in chat, reaction popup, saved items, read receipts)
  document.querySelectorAll('#user-context-menu [data-user-action]').forEach((item) => {
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      const userId = activeUserContextMenuId;
      closeAllMenus();
      if (!userId) return;
      const action = item.dataset.userAction;
      if (action === 'profile') {
        showUserProfile(userId);
      } else if (action === 'personal-page' && typeof openPersonPage === 'function') {
        openPersonPage(Number(userId));
      } else if (action === 'message') {
        openDM(userId);
      } else if (action === 'edit') {
        openProfileModal();
      } else if (action === 'preferences') {
        openPreferencesModal();
      } else if (action === 'signout') {
        handleLogout();
      }
    });
  });

  // Profile modal close buttons
  on('btn-close-user-profile', 'click', closeSettingsModal);

  // Image viewer (lightbox)
  on('btn-close-image-viewer', 'click', closeImageViewer);
  on('btn-viewer-close', 'click', closeImageViewer);
  on('btn-viewer-copy', 'click', copyImageViewerImage);
  on('btn-viewer-download', 'click', () => imageViewerState.fileId && downloadFile(imageViewerState.fileId, imageViewerState.name || 'image'));
  on('btn-viewer-remove', 'click', removeImageViewerImage);
  on('image-viewer-modal', 'click', (event) => {
    if (event.target && event.target.id === 'image-viewer-modal') closeImageViewer();
  });

  // Image action buttons (kebab + inline hover) share the same delegation
  document.addEventListener('click', handleImageAction);

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

  // Document-level clicks in the capture phase: toggle the "More actions" menu
  // and close floating UI. Capture ensures item clicks that stop propagation
  // (e.g. pin/unpin) still close the menu.
  document.addEventListener('click', handleDocumentClick, true);
  initLongPress();
  // Fixed-position menus should close when scrollable content moves behind them
  ['messages', 'dm-messages'].forEach((id) => {
    document.getElementById(id)?.addEventListener('scroll', () => closeAllMenus(), { passive: true });
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
  on('btn-refresh-activity', 'click', () => { renderActivity(); loadActivity({ markSeen: true }); });
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
  on('moderation-content', 'input', handleModerationFilter);
  on('btn-channel-pins', 'click', togglePinnedMessages);
  on('btn-close-channel-pins', 'click', closePinnedMessages);
  on('channel-pins-list', 'click', handlePinnedMessageClick);
  on('btn-edit-topic', 'click', startEditChannelTopic);
  on('channel-topic-form', 'submit', saveEditChannelTopic);
  on('btn-cancel-topic', 'click', cancelEditChannelTopic);
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

  setupFileSending();
  setupActivityFeatures();
  setupNotificationFeatures();
  setupProfilePhoto();
  setupGroupFeatures();
  setupLaterFeatures();
  setupAdminFeatures();
  setupWorkspaceFeatures();
  setupHuddleVideoFeatures();
  setupIntegrationFeatures();

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
  paintAccountMenu();
  if (els.userAvatar) {
    els.userAvatar.textContent = state.user.username.charAt(0).toUpperCase();
    els.userAvatar.parentElement.style.backgroundColor = state.user.avatarColor || '';
    paintOwnAvatar();
  }
  refreshOwnProfile();
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
  document.getElementById('profile-job-title').value = state.user.jobTitle || '';
  paintProfilePhotoPreview();
  openSettingsModal(els.profileModal);
}

function openPreferencesModal() {
  document.getElementById('preference-theme').value = state.preferences.theme;
  document.getElementById('preference-enter-to-send').checked = state.preferences.enterToSend;
  if (window.electronAPI?.getTraySetting) {
    window.electronAPI.getTraySetting().then((tray) => {
      document.getElementById('preference-close-to-tray').checked = Boolean(tray && tray.enabled);
      document.getElementById('preference-tray-row').hidden = false;
    }).catch(() => {});
  }
  fillNotificationSettingsForm();
  openSettingsModal(els.preferencesModal);
}

function openAccountModal() {
  document.getElementById('account-email').value = state.user.email || '';
  // the saved sign-in can be out of date (HR may have corrected the address): catch up, unless they already started typing
  refreshOwnProfile().then(() => { const field = document.getElementById('account-email'); if (field && document.activeElement !== field) field.value = state.user.email || ''; });
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
      soundTheme: soundThemeId(saved.soundTheme),
      soundVolume: soundVolumePercent(saved.soundVolume === undefined ? DEFAULT_SOUND_VOLUME : saved.soundVolume),
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
    soundTheme: soundThemeId(document.getElementById('sound-theme')?.value),
    soundVolume: soundVolumePercent(document.getElementById('sound-volume')?.value),
  };
  try {
    await electronAPI.storeSet(preferenceStorageKey(), state.preferences);
    const trayRow = document.getElementById('preference-tray-row');
    if (trayRow && !trayRow.hidden && window.electronAPI?.setTraySetting) {
      await window.electronAPI.setTraySetting(document.getElementById('preference-close-to-tray').checked);
    }
    applyPreferences();
    await saveNotificationSettingsFromForm();
    closeSettingsModal();
    showToast('Preferences saved.', 'success');
  } catch (err) {
    console.error('Save preferences error:', err);
    showToast(err.message || 'Could not save preferences.', 'error');
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
  const jobTitle = document.getElementById('profile-job-title').value.trim();
  try {
    const res = await api('/api/auth/me', {
      method: 'PATCH',
      body: JSON.stringify({ username, avatarColor, jobTitle }),
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
    if (clientMessageId) {
      removePendingMessage(clientMessageId);
      removePendingGroupMessage(clientMessageId);
    }
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
  // A channel was deleted (by the Superadmin or its creator): drop it from the sidebar and move on if it was open.
  state.socket.on('channel_deleted', async ({ channelId, name }) => {
    if (!state.channels.some((channel) => Number(channel.id) === Number(channelId))) return;
    state.channels = state.channels.filter((channel) => Number(channel.id) !== Number(channelId));
    delete state.messages[channelId];
    renderSidebar();
    showToast(`#${name || 'A channel'} was deleted.`, 'info');
    if (Number(state.currentChannelId) === Number(channelId)) {
      state.currentChannelId = null;
      if (state.channels.length) await openChannel(state.channels[0].id);
    }
    if (state.section === 'moderation') loadModerationView();
  });
  // Roles or channel permissions changed: re-read what this person can see and do (debounced: a burst of edits is one refresh).
  let permissionsTimer = null;
  state.socket.on('permissions_updated', (info) => {
    clearTimeout(permissionsTimer);
    const mine = Boolean(info && Number(info.byUserId) === Number(state.user && state.user.id));
    permissionsTimer = setTimeout(async () => {
      await loadChannels();
      await loadModerationAccess();
      loadUsers();
      loadRoleMentions();
      if (typeof refreshOwnProfile === 'function') refreshOwnProfile();
      if (state.currentChannelId && !state.channels.some((c) => Number(c.id) === Number(state.currentChannelId))) {
        state.currentChannelId = null;
        if (state.channels.length) await openChannel(state.channels[0].id);
        showToast('A channel is no longer available to you.', 'info');
      }
      // the screen of the person who made the change is already up to date; for anyone else, rebuild it where they were
      if (state.section === 'moderation' && !mine && !document.getElementById('role-modal-overlay')) {
        const scroller = document.getElementById('moderation-content');
        const top = scroller ? scroller.scrollTop : 0;
        await loadModerationView();
        const after = document.getElementById('moderation-content');
        if (after) after.scrollTop = top;
      }
    }, 400);
  });
  state.socket.on('workspace_sections_updated', () => loadSidebarLayout());
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

  state.socket.on('user_photo_updated', handleUserPhotoUpdated);
  state.socket.on('profile_updated', () => refreshOwnProfile());
  state.socket.on('leave_updated', handleLeaveUpdated);
  state.socket.on('attendance_updated', handleAttendanceUpdated);
  state.socket.on('huddle:joined', handleHuddleJoined);
  state.socket.on('huddle:invite', handleHuddleInvite);
  state.socket.on('huddle:invite-cancelled', handleHuddleInviteCancelled);
  state.socket.on('huddle:participant-joined', (participant) => {
    if (String(state.huddle.channelId) !== String(participant.channelId)) return;
    state.huddle.participants.set(participant.peerId, participant);
    renderHuddleParticipants();
    updateHuddleConnectedStatus();
    // Tell the newcomer whether this client's camera or screen is on.
    setTimeout(announceHuddleVideoState, 1500);
  });
  state.socket.on('huddle:media-state', handleHuddleMediaState);
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
    }
    // Unread counts for channels that are not on screen come from `channel_activity`.
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

  state.socket.on('activity', handleActivityEvent);
  state.socket.on('canvas_activity', handleCanvasActivityEvent);
  state.socket.on('user_groups_updated', handleUserGroupsUpdated);
  state.socket.on('scheduled_message_sent', handleScheduledDelivered);
  state.socket.on('scheduled_message_failed', handleScheduledFailed);
  state.socket.on('channel_links_updated', handleChannelLinksUpdated);
  state.socket.on('account_updated', handleAccountUpdated);
  state.socket.on('message_updated', handleMessageUpdated);
  state.socket.on('reminder_due', handleReminderDue);
  state.socket.on('channel_activity', handleChannelActivity);
  state.socket.on('channel_topic_updated', (event) => {
    const channelId = Number(event.channelId);
    const channel = state.channels.find((c) => Number(c.id) === channelId);
    if (channel) channel.topic = event.topic || '';
    if (Number(state.currentChannelId) === channelId) {
      if (els.channelTopic && els.channelTopic.hidden !== true) {
        els.channelTopic.textContent = event.topic || '';
      } else if (els.channelTopicInput && document.activeElement !== els.channelTopicInput) {
        els.channelTopicInput.value = event.topic || '';
      }
      updateEditTopicVisibility(channelId);
    }
  });
  state.socket.on('channel_availability_updated', async () => {
    await loadChannels();
    if (typeof loadSidebarLayout === 'function') await loadSidebarLayout();
  });
  state.socket.on('user_status_updated', handleUserStatusUpdated);
  // the owner deleted a canvas somebody else has open
  state.socket.on('canvas_deleted', (event) => {
    if (typeof canvasDeletedElsewhere === 'function') canvasDeletedElsewhere(Number(event.canvasId));
  });
  state.socket.on('canvas_comments_updated', (event) => {
    if (typeof canvasCommentsChanged === 'function') canvasCommentsChanged(Number(event.canvasId));
  });
  state.socket.on('canvas_updated', (event) => {
    const incomingCanvasId = Number(event.canvasId);
    // Standalone canvas manager editor
    const activeId = Number(canvas2StandaloneState.activeId || 0);
    if (activeId && incomingCanvasId === activeId) {
      applyRemoteCanvasUpdate(canvas2StandaloneState, event, {
        title: document.getElementById('canvas2-editor-title'),
        content: document.getElementById('canvas2-editor'),
      });
      canvasViewRefresh(incomingCanvasId, event.revision);
      return;
    }
    // Header-anchored channel/DM canvas sheet
    if (canvas2State.activeId && Number(canvas2State.activeId) === incomingCanvasId) {
      applyRemoteCanvasUpdate(canvas2State, event, { title: els.canvasSheetTitle, content: els.canvasSheetEditor });
      canvasViewRefresh(incomingCanvasId, event.revision);
    }
  });
  state.socket.on('new_group_message', handleNewGroupMessage);
  state.socket.on('conversation_updated', handleConversationUpdated);
  state.socket.on('conversation_removed', handleConversationRemoved);

  state.socket.on('message_reactions_updated', (event) => {
    const channelId = Number(event.channelId);
    const messages = state.messages[channelId] || [];
    const message = messages.find((item) => Number(item.id) === Number(event.messageId));
    if (!message) return;
    message.reactions = event.reactions || [];
    if (Number(state.currentChannelId) === channelId && state.view === 'channel') {
      applyReactionsInPlace('messages', messages, event.messageId, event.reactions);
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
    handleDirectMessageNotification(dm);
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
    // View as listens to every channel the person is in, so what they see updates live
    if (state.viewAs && state.socket) state.channels.forEach((channel) => state.socket.emit('join_channel', channel.id));
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

  renderChannelNav();

  // renderSidebar rebuilds the whole nav, so re-render the DM list too
  renderDmList();
  updateActivityBadge();
}

async function openChannel(channelId) {
  const previousChannelId = state.currentChannelId;
  closeCanvasSheetForOtherConversation({ channelId });

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
  updateEditTopicVisibility(channelId);

  resetChannelTab();

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
  const names = visibleUsers.map((u) => u.name || u.username).join(', ');
  const more = users.length > visibleUsers.length ? ` +${users.length - visibleUsers.length} more` : '';

  container.style.display = 'flex';
  container.innerHTML = `
    <div class="read-receipt-avatars">
      ${visibleUsers.map((u) => { const name = u.name || u.username || 'User'; return `<span class="read-receipt-avatar" title="${escapeHtml(name)}" style="background:${escapeHtml(u.avatarColor || '#A855F7')};" data-user-id="${escapeHtml(String(u.id ?? u.userId ?? ''))}" role="button" tabindex="0" aria-label="View ${escapeHtml(name.trim())}'s profile">${escapeHtml(name.charAt(0).toUpperCase())}</span>`; }).join('')}
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
    if (typeof repaintAllAvatars === 'function') repaintAllAvatars();
    state.usersLoaded = true;
    state.dms = data.users.filter(u => u.id !== state.user.id);
    renderDmList();
    if (state.section === 'dms' && !state.currentDMId && !state.currentGroupId) {
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
  renderGroupList();
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
      <span class="nav-avatar" style="background:${escapeHtml(dm.avatarColor || '#A855F7')};" data-avatar-user="${escapeHtml(String(dm.id))}">${escapeHtml((dm.username || '?').charAt(0).toUpperCase())}<span class="nav-avatar-dot" style="background:${color};" title="${escapeHtml(slabel)}"></span></span>
      <span>${escapeHtml(dm.username)}</span>${userStatusMarkup(dm)}
      <span style="margin-left:auto; font-size:11px; opacity:0.6;">${escapeHtml(slabel)}</span>
    `;
    item.onclick = (e) => { e.stopPropagation(); openDM(dm.id); };
    els.dmList.appendChild(item);
  });
}

async function openDM(userId) {
  closeCanvasSheetForOtherConversation({ userId });
  leaveGroupView();
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
    els.dmTopic.textContent = dmTopicText(user);
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
// ---- the message list ----------------------------------------------------------------------------------------------------
// Sending or receiving one message must not rebuild the whole list: that threw the view back to the top and made pictures
// reload. Each message element carries a key (its client id while pending, else its id); when the new list is the old one with
// messages added at the end, only the changed elements are replaced and the new ones appended. Anything else (another
// conversation, a deletion, older history loaded) rebuilds the list as before.
const messageKeyOf = (message) => String(message.clientMessageId || message.id);
const nearBottom = (container) => container.scrollHeight - container.scrollTop - container.clientHeight < 120;

// Keeps the view at the bottom while pictures and avatars finish loading, until the person scrolls up themselves.
function keepBottomWhileLoading(container) {
  if (container._stickyBottom) return;
  container._stickyBottom = true;
  container._pinned = true;
  container.addEventListener('scroll', () => { container._pinned = nearBottom(container); }, { passive: true });
  container.addEventListener('load', () => { if (container._pinned) container.scrollTop = container.scrollHeight; }, true);
}

function scrollToBottom(container) {
  container._pinned = true;
  container.scrollTop = container.scrollHeight;
}

function dateSeparator(message) {
  const sep = document.createElement('div');
  sep.className = 'date-sep';
  sep.textContent = new Date(message.createdAt).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  return sep;
}

function renderMessages(containerId, messages) {
  const container = document.getElementById(containerId);
  keepBottomWhileLoading(container);

  if (!messages || messages.length === 0) {
    container._messageList = null;
    container.innerHTML = emptyRecordMarkup('No messages yet', 'Send the first message.');
    return;
  }

  const allowReply = containerId === 'messages';
  const keys = messages.map(messageKeyOf);
  const previous = container._messageList;
  const onlyAdded = previous && previous.keys.length > 0 && previous.keys.length <= keys.length
    && previous.keys.every((key, index) => key === keys[index])
    // the list on screen is still the one we drew (something else may have cleared or changed the container)
    && [...container.children].filter((child) => child.dataset && child.dataset.messageKey).length === previous.keys.length;

  if (onlyAdded) {
    const wasAtBottom = nearBottom(container);
    messages.slice(0, previous.keys.length).forEach((message, index) => {
      const signature = JSON.stringify(message);
      if (signature === previous.signatures[index]) return;
      previous.signatures[index] = signature;
      const old = [...container.children].find((child) => child.dataset && child.dataset.messageKey === keys[index]);
      if (!old) return;
      const fresh = renderMessageEl(message, allowReply);
      fresh.dataset.messageKey = keys[index];
      old.replaceWith(fresh);
    });
    let lastDate = new Date(messages[previous.keys.length - 1].createdAt).toDateString();
    for (let index = previous.keys.length; index < messages.length; index += 1) {
      const message = messages[index];
      const day = new Date(message.createdAt).toDateString();
      if (day !== lastDate) { lastDate = day; container.appendChild(dateSeparator(message)); }
      const el = renderMessageEl(message, allowReply);
      el.dataset.messageKey = keys[index];
      container.appendChild(el);
      previous.signatures.push(JSON.stringify(message));
    }
    const added = messages.length > previous.keys.length;
    previous.keys = keys;
    const lastOne = messages[messages.length - 1];
    const mine = Number(lastOne.userId ?? lastOne.senderId) === Number(state.user && state.user.id);
    if (added && (wasAtBottom || mine)) scrollToBottom(container);
    return;
  }

  container.innerHTML = '';
  let lastDate = null;
  messages.forEach((msg, index) => {
    const msgDate = new Date(msg.createdAt).toDateString();
    if (msgDate !== lastDate) {
      lastDate = msgDate;
      container.appendChild(dateSeparator(msg));
    }
    const el = renderMessageEl(msg, allowReply);
    el.dataset.messageKey = keys[index];
    container.appendChild(el);
  });
  container._messageList = { keys, signatures: messages.map((message) => JSON.stringify(message)) };
  scrollToBottom(container);
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

// Swap one message's reactions in place without re-rendering the whole list
function applyReactionsInPlace(containerId, list, messageId, reactions) {
  if (!Array.isArray(list)) return;
  const item = list.find((m) => Number(m.id) === Number(messageId));
  if (!item) return;
  item.reactions = reactions || [];
  const container = document.getElementById(containerId);
  const old = container ? container.querySelector(`#message-${String(messageId).replace(/[^0-9]/g, '')}`) : null;
  if (!old) return;
  const fresh = renderMessageEl(item, containerId === 'messages');
  if (fresh) old.replaceWith(fresh);
}

// How a message author is shown: their full name (username when they have none), in their top role's color.
function messageAuthor(userId, username) {
  const person = Number(userId) === Number(state.user && state.user.id) ? state.user : (state.users || []).find((u) => Number(u.id) === Number(userId));
  const name = person && typeof personName === 'function' ? personName(person) : '';
  return { name: name || username, color: person && /^#[0-9a-fA-F]{6}$/.test(person.roleColor || '') ? person.roleColor : '' };
}

function renderMessageEl(msg, allowReply = false) {
  const isYou = (msg.userId ?? msg.senderId) === state.user.id;
  const username = msg.username || msg.senderUsername || 'Unknown';
  const author = messageAuthor(msg.userId ?? msg.senderId, username);
  const avatarColor = msg.avatarColor || msg.senderAvatarColor || '#A855F7';
  const initials = username.charAt(0).toUpperCase();
  const isPinned = Boolean(msg.pinned || msg.pinnedAt);
  const canModerate = state.moderation.isSuperadmin
    || state.moderation.moderatorChannelIds.some((id) => Number(id) === Number(msg.channelId || state.currentChannelId));

  const el = document.createElement('div');
  el.className = `message${msg.pending ? ' pending' : ''}${isYou ? ' own' : ''}`;
  el.id = `message-${msg.id}`;

  // Single combined pill: all unique reaction emojis + total count
  const reactionList = msg.reactions || [];
  const reactionTotal = reactionList.reduce((sum, r) => sum + Number(r.count || 0), 0);
  const reactionEmojis = [...new Set(reactionList.map((r) => r.emoji))];
  const reactionHasMe = reactionList.some((r) => r.users && r.users.includes(state.user.id));
  const reactionTitle = reactionList.map((r) => `${r.emoji} × ${r.count}`).join(', ');
  const reactionsHtml = reactionTotal > 0
    ? `<button type="button" class="reaction${reactionHasMe ? ' me' : ''}" data-reaction-message="${escapeHtml(String(msg.id))}" data-reaction-emoji="" aria-label="Reactions, ${reactionTotal} ${reactionTotal === 1 ? 'person' : 'people'}" title="${escapeHtml(reactionTitle)}">
      ${reactionEmojis.map((emoji) => `<span class="emoji">${emoji}</span>`).join('')}${reactionTotal === 1 ? '' : `<span class="count">${reactionTotal}</span>`}
    </button>`
    : '';

  const downloadsHtml = (msg.attachments || []).map((a) => {
    const id = escapeHtml(String(a.id));
    const name = escapeHtml(a.filename || 'file');
    const mime = (a.mimeType || '').toLowerCase();
    const isImage = mime.startsWith('image/');
    const label = isImage ? `Download image${name ? `: ${name}` : ''}` : `Download ${name}`;
    return `<button class="msg-action-btn" type="button" data-download-attachment="${id}" data-file-name="${name}" aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}">${ICON_DOWNLOAD}</button>`;
  }).join('');

  // With no text, the attachment itself carries the reaction pill (lower corner), not an empty bubble.
  const reactOnAttachment = !String(msg.content || '').trim() && (msg.attachments || []).length > 0 && !!reactionsHtml;
  const attachmentReactions = reactOnAttachment ? `<span class="reactions">${reactionsHtml}</span>` : '';
  const lastAttachmentIndex = (msg.attachments || []).length - 1;
  const attachmentsHtml = (msg.attachments || []).map((a, index) => {
    const extra = index === lastAttachmentIndex ? attachmentReactions : '';
    const id = escapeHtml(String(a.id));
    const name = escapeHtml(a.filename);
    const mime = (a.mimeType || '').toLowerCase();
    const isImage = mime.startsWith('image/');
    if (isImage) {
      return `<div class="attachment-row attachment-row-image">
        <span class="attachment-image-wrap">
          <button class="attachment-image" type="button" data-file-id="${id}" data-file-name="${name}" data-file-mime="${escapeHtml(a.mimeType || '')}" data-file-size="${escapeHtml(String(a.size || ''))}" data-uploaded-by="${escapeHtml(String(a.uploadedBy ?? ''))}" data-moderator="${Number(a.uploadedBy) !== Number(state.user.id)}" aria-label="${name}" title="${name}">
            <img alt="${name}" loading="lazy">
          </button>
        </span>${extra}
      </div>`;
    }
    return `<div class="attachment-row attachment-row-file">
      <div class="attachment" data-file-id="${id}" data-file-name="${name}" role="button" tabindex="0" title="Download ${name}">
        <div class="icon">${fileIconSvg(fileIcon(a.mimeType))}</div>
        <div class="info">
          <div class="name">${name}</div>
          <div class="size">${escapeHtml(humanSize(a.size))}</div>
        </div>
      </div>${extra}
    </div>`;
  }).join('');
  const replyPreview = msg.replyTo ? (msg.replyToMessage || {}) : null;

  el.innerHTML = `
    <div class="avatar-mini" style="background:${avatarColor};" data-user-id="${escapeHtml(String(msg.userId ?? msg.senderId ?? ''))}" role="button" tabindex="0" title="View profile" aria-label="View profile">${initials}</div>
    <div class="message-body">
      <div class="message-header">
        <span class="name"${author.color ? ` style="color:${escapeHtml(author.color)}"` : ''}>${escapeHtml(author.name)}</span>
        ${isYou ? '<span class="you">You</span>' : ''}
        <span class="time">${shortTime(msg.createdAt)}</span>
        ${allowReply ? messageEditedHtml(msg) : ''}
        ${allowReply && isPinned ? '<span class="message-pinned-badge">Pinned</span>' : ''}
      </div>
      ${msg.replyTo ? `<button class="message-reply-preview" type="button" data-target-id="${escapeHtml(String(msg.replyTo))}" title="Go to original message">
        <span class="message-reply-author">${escapeHtml(replyPreview.username || 'Original message')}</span>
        <span class="message-reply-content">${escapeHtml(replyPreview.content || 'Attachment')}</span>
      </button>` : ''}
      <div class="message-bubble-row">
        <div class="message-text">${formatMessageText(msg.content)}${reactionsHtml && !reactOnAttachment ? `<span class="reactions">${reactionsHtml}</span>` : ''}</div>
        ${!attachmentsHtml && allowReply && !msg.pending && msg.id != null ? `<span class="message-actions" aria-label="Message actions">
          <button class="msg-action-btn" type="button" data-open-reactions="${escapeHtml(String(msg.id))}" aria-label="React with an emoji" title="React with an emoji">${ICON_REACT}</button>
          <button class="msg-action-btn" type="button" data-reply-message="${escapeHtml(String(msg.id))}" aria-label="Reply to this message" title="Reply to this message">${ICON_REPLY}</button>
          ${downloadsHtml}<button class="msg-action-btn" type="button" data-message-more="${escapeHtml(String(msg.id))}" aria-label="More actions" title="More actions" aria-haspopup="true" aria-expanded="false">${ICON_MORE}</button>
          ${messageMoreMenuHtml(msg, isYou, canModerate)}
        </span>` : ''}
      </div>
      ${attachmentsHtml ? `<div class="attachments${reactOnAttachment ? ' has-reactions' : ''}">${attachmentsHtml}${allowReply && !msg.pending && msg.id != null ? `<span class="message-actions" aria-label="Message actions">
          <button class="msg-action-btn" type="button" data-open-reactions="${escapeHtml(String(msg.id))}" aria-label="React with an emoji" title="React with an emoji">${ICON_REACT}</button>
          <button class="msg-action-btn" type="button" data-reply-message="${escapeHtml(String(msg.id))}" aria-label="Reply to this message" title="Reply to this message">${ICON_REPLY}</button>
          ${downloadsHtml}<button class="msg-action-btn" type="button" data-message-more="${escapeHtml(String(msg.id))}" aria-label="More actions" title="More actions" aria-haspopup="true" aria-expanded="false">${ICON_MORE}</button>
          ${messageMoreMenuHtml(msg, isYou, canModerate)}
        </span>` : ''}</div>` : ''}
    </div>`;

  const replyAction = el.querySelector('[data-reply-message]');
  if (replyAction) {
    replyAction.addEventListener('click', () => beginReply(msg));
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

  // Image attachments: load the bytes with the bearer token and wire preview
  el.querySelectorAll('.attachment-image').forEach((node) => {
    const fileId = node.dataset.fileId;
    const fileName = node.dataset.fileName;
    const fileSize = node.dataset.fileSize;
    const uploaderId = node.dataset.uploadedBy;
    const moderator = node.dataset.moderator === 'true';
    const img = node.querySelector('img');
    fetch(`${API_BASE}/api/files/${fileId}/download`, {
      headers: { 'Authorization': `Bearer ${state.token}` },
    })
      .then((res) => (res.ok ? res.blob() : Promise.reject(new Error('Could not load image'))))
      .then((blob) => {
        const url = URL.createObjectURL(blob);
        if (img) {
          img.src = url;
          img.dataset.objectUrl = url;
        }
      })
      .catch((err) => {
        console.error('Load image preview error:', err);
        node.classList.add('image-failed');
        if (img) {
          img.alt = `${fileName} (failed to load)`;
        }
      });

    // Click opens the lightbox
    node.addEventListener('click', () => {
      openImageViewer({ fileId, name: fileName, size: fileSize, imgAlt: img?.alt || fileName, uploaderId, canModerate: moderator, mimeType: node.dataset.fileMime });
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
  if (state.currentGroupId) {
    sendGroupMessage();
    return;
  }
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
    showReactionDetails(reaction.dataset.reactionMessage);
    return;
  }
}

async function showReactionDetails(messageId) {
  try {
    const res = await api(`/api/messages/${messageId}/reactions`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to load reactions');

    const rows = data.reactions || [];
    if (rows.length === 0) {
      closeSettingsModal();
      return;
    }

    // Group by emoji for display, one line per reactor
    const byEmoji = new Map();
    for (const row of rows) {
      if (!byEmoji.has(row.emoji)) byEmoji.set(row.emoji, []);
      byEmoji.get(row.emoji).push(row);
    }

    const meId = String(state.user?.id);
    const blocks = [...byEmoji.entries()].map(([emoji, reactors]) => {
      const entries = reactors.map((u) => {
        const you = String(u.user_id) === meId;
        const initial = (u.username || '?').charAt(0).toUpperCase();
        const name = escapeHtml(u.username || 'Unknown');
        const inner = `<span class="avatar-mini" style="background:${escapeHtml(u.avatar_color || '#A855F7')};" data-user-id="${escapeHtml(String(u.user_id ?? ''))}" role="button" tabindex="0" title="View profile" aria-label="View profile">${initial}</span>
          <span class="reaction-row-name">${name}${you ? ' (You)' : ''}</span>
          <span class="reaction-row-emoji">${emoji}</span>`;
        return you
          ? `<button type="button" class="reaction-row me" data-remove-reaction="${escapeHtml(String(messageId))}" data-remove-reaction-emoji="${escapeHtml(emoji)}" title="Tap to remove your reaction">${inner}</button>`
          : `<div class="reaction-row">${inner}</div>`;
      }).join('');
      return `<div class="reaction-group" role="group" aria-label="${escapeHtml(emoji)} reactions">
        <div class="reaction-group-label">${emoji} <span>${reactors.length}</span></div>
        ${entries}
      </div>`;
    }).join('');

    openInfoModal('Reactions', `<p class="reaction-info-note">Tap your name to remove your reaction.</p>${blocks}`);

    // Wire up the remove buttons for the current user
    const body = document.getElementById('info-modal-body');
    body.querySelectorAll('[data-remove-reaction]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const targetMessageId = btn.dataset.removeReaction;
        const targetEmoji = btn.dataset.removeReactionEmoji;
        if (!targetMessageId) return;
        await addReaction(targetMessageId, targetEmoji);
        await showReactionDetails(targetMessageId);
      });
    });
  } catch (err) {
    console.error('Show reaction details error:', err);
    showToast(err.message || 'Could not load reactions.', 'error');
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

    // Apply the server's authoritative reaction state in place; no full reload
    const channelId = state.currentChannelId;
    if (state.view === 'channel' && channelId && state.messages[channelId]) {
      applyReactionsInPlace('messages', state.messages[channelId], messageId, data.reactions);
    }
    const dmId = state.currentDMId;
    if (state.view === 'dm' && dmId && state.directMessages[dmId]) {
      applyReactionsInPlace('dm-messages', state.directMessages[dmId], messageId, data.reactions);
    }
  } catch (err) {
    console.error('Add reaction error:', err);
    showToast(err.message || 'Could not update reaction.', 'error');
  }
}

// ============================================================
// File Attachments
// ============================================================
// The paperclip: pick one or several files; they go out together in one message (see features/attachments.js).
async function handleFilePick(e) {
  const files = Array.from(e.target.files || []);
  e.target.value = '';
  if (files.length) await sendFilesTo('channel', files);
}

async function handleDmFilePick(e) {
  const files = Array.from(e.target.files || []);
  e.target.value = '';
  if (files.length) await sendFilesTo('dm', files);
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
  canvas2:  { pane: null,       view: 'canvas2' },
  people:   { pane: null,       view: 'people' },
  huddle:   { pane: null,       view: 'huddle' },
  moderation: { pane: null,     view: 'moderation' },
  later:    { pane: null,       view: 'later' },
};

// Sections reached from the rail's More menu rather than their own rail buttons.
const MORE_SECTIONS = ['lists', 'canvases'];

function updateRail(section) {
  document.querySelectorAll('.rail-item[data-rail]').forEach((btn) => {
    const on = btn.dataset.rail === section;
    btn.classList.toggle('active', on);
    if (on) btn.setAttribute('aria-current', 'page');
    else btn.removeAttribute('aria-current');
  });
  // The More button lights up while one of its sections is open, and the menu marks which.
  const moreButton = document.getElementById('btn-rail-more');
  const inMore = MORE_SECTIONS.includes(section);
  if (moreButton) {
    moreButton.classList.toggle('active', inMore);
    if (inMore) moreButton.setAttribute('aria-current', 'page');
    else moreButton.removeAttribute('aria-current');
  }
  document.querySelectorAll('#more-menu [data-more-section]').forEach((item) => {
    item.classList.toggle('active', item.dataset.moreSection === section);
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
  if (paneAction) paneAction.style.display = pane === 'home' && state.moderation.canCreateChannels ? 'flex' : 'none';
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
    if (state.currentGroupId) {
      await openGroup(state.currentGroupId);
    } else if (state.currentDMId) {
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
  } else if (section === 'canvas2') {
    showPane(null);
    showView('canvas2');
    await loadCanvas2StandaloneList();
  } else if (section === 'people') {
    showPane(null);
    showView('people');
    peopleState.pageId = null;
    peopleState.page = null;
    await loadPeople(true);
  } else if (section === 'activity') {
    renderActivity();
    await loadActivity({ markSeen: true });
  } else if (section === 'later') {
    await loadLaterView();
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
    state.moderation.isHr = Boolean(data.isHr);
    state.moderation.canManageRoles = Boolean(data.canManageRoles);
    state.moderation.canManageChannels = Boolean(data.canManageChannels);
    state.moderation.canManageWorkspace = Boolean(data.canManageWorkspace);
    state.moderation.canCreateChannels = Boolean(data.canCreateChannels);
    if (typeof refreshLeaveSummary === 'function' && state.moderation.accountType !== 'guest') refreshLeaveSummary();
    if (typeof refreshAttendanceSummary === 'function' && state.moderation.accountType !== 'guest') refreshAttendanceSummary();
    state.moderation.moderatorChannelIds = data.moderatorChannelIds || [];
    state.moderation.accountType = data.accountType || 'member';
    applyAccountRestrictions();
    applyChannelCreationAccess();
    const nav = document.getElementById('nav-moderation');
    if (nav) nav.hidden = !state.moderation.canManageChannels && !state.moderation.canManageRoles && !state.moderation.moderatorChannelIds.length;
    updateEditTopicVisibility(state.currentChannelId);
  } catch (err) {
    console.error('Load moderation access error:', err);
  }
}

function applyChannelCreationAccess() {
  const allowed = Boolean(state.moderation.canCreateChannels);
  document.querySelectorAll('[data-command="new-channel"], [data-create="channel"]').forEach((control) => {
    control.hidden = !allowed;
  });
  const paneAction = document.getElementById('btn-pane-action');
  if (paneAction) paneAction.style.display = state.section === 'home' && allowed ? 'flex' : 'none';
}

async function loadModerationView() {
  const container = document.getElementById('moderation-content');
  if (!container) return;
  const channels = state.moderation.canManageChannels
    ? state.channels
    : state.channels.filter((channel) => state.moderation.moderatorChannelIds
      .some((id) => Number(id) === Number(channel.id)));
  if (!channels.length && !state.moderation.canManageRoles && !state.moderation.canManageChannels) {
    container.innerHTML = emptyRecordMarkup(
      'No channels to moderate',
      'You do not have moderation access to a channel yet.',
    );
    return;
  }
  const selectedId = !channels.length ? null : channels.some((channel) => Number(channel.id) === Number(state.moderation.channel?.id))
    ? Number(state.moderation.channel.id) : Number(channels[0].id);
  const canRoles = Boolean(state.moderation.isSuperadmin || state.moderation.canManageRoles);
  // Moderation is split into tabs for the Superadmin; a channel moderator only has Channels.
  const tabs = state.moderation.isSuperadmin
    ? [['channels', 'Channels'], ['people', 'People and groups'], ['signup', 'Sign-up and invitations'], ['roles', 'Roles'], ['rules', 'Rules and audit log']]
    : [...(channels.length ? [['channels', 'Channels']] : []), ...(canRoles ? [['roles', 'Roles']] : [])];
  if (!tabs.some(([key]) => key === state.moderation.tab)) state.moderation.tab = tabs.length ? tabs[0][0] : 'channels';
  container.dataset.tab = state.moderation.tab;
  container.innerHTML = `
    ${tabs.length > 1 ? `<div class="lv-tabs mod-tabs" role="tablist">${tabs.map(([key, label]) => `<button type="button" class="lv-tab${state.moderation.tab === key ? ' active' : ''}" data-mod-tab-button="${key}" role="tab">${label}</button>`).join('')}</div>` : ''}
    ${channels.length ? `<div class="moderation-toolbar" data-mod-tab="channels">
      <label for="moderation-channel-select">Channel</label>
      <input type="search" id="moderation-channel-select" list="moderation-channel-options" value="#${escapeHtml(channels.find((channel) => Number(channel.id) === selectedId)?.name || '')}" data-channel-id="${selectedId}" placeholder="Type to find a channel…" aria-label="Search and select channel" autocomplete="off">
      <datalist id="moderation-channel-options">${channels.map((channel) => `<option value="#${escapeHtml(channel.name)}" data-channel-id="${channel.id}"></option>`).join('')}</datalist>
    </div>` : ''}
    ${state.moderation.isSuperadmin ? `
      <form class="moderation-card moderation-settings" data-moderation-form="settings" data-mod-tab="rules">
        <h2>Workspace timeout policy</h2>
        <label>Default timeout (minutes)<input name="defaultTimeoutMinutes" type="number" min="1" max="10080" value="${state.moderation.settings?.defaultTimeoutMinutes || 5}" required></label>
        <label>Maximum timeout (minutes)<input name="maxTimeoutMinutes" type="number" min="1" max="10080" value="${state.moderation.settings?.maxTimeoutMinutes || 10080}" required></label>
        <button class="btn primary" type="submit">Save timeout policy</button>
      </form>` : ''}
    ${state.moderation.isSuperadmin ? `<div class="moderation-card" data-mod-tab="rules">
      <h2>Slow mode for all channels</h2>
      <p class="admin-help">Slow mode makes people wait between messages in a channel. New channels start with the default below; you can also set one value on every channel that already exists.</p>
      <div class="moderation-inline"><label>Default for new channels (seconds)<input id="slowmode-default" type="number" min="0" max="3600" value="5"></label><button class="btn primary" type="button" data-action="save-default-slowmode">Save default</button></div>
      <div class="moderation-inline"><label>Set every existing channel to (seconds)<input id="slowmode-all" type="number" min="0" max="3600" value="5"></label><button class="btn" type="button" data-action="apply-slowmode-all">Apply to all channels</button></div>
    </div>` : ''}
    ${channels.length ? '<div id="moderation-channel-data" class="moderation-channel-data" data-mod-tab="channels"><div class="loading-state">Loading channel moderation…</div></div>' : ''}
    ${state.moderation.isSuperadmin ? '<div id="moderation-launch" data-mod-tab="rules"></div><div id="moderation-workspace-audit" data-mod-tab="rules"></div>' : ''}
    ${canRoles ? '<div id="moderation-roles" data-mod-tab="roles"></div>' : ''}`;
  if (canRoles && state.moderation.tab === 'roles') loadRolesPanel();
  if (state.moderation.isSuperadmin && typeof loadLaunchCard === 'function') loadLaunchCard();
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
  if (state.moderation.isSuperadmin) {
    try {
      const policy = await (await api('/api/moderation/slowmode-policy')).json();
      const field = document.getElementById('slowmode-default');
      if (field && Number.isInteger(policy.defaultSeconds)) field.value = policy.defaultSeconds;
    } catch (err) {
      console.error('Load slow mode policy error:', err);
    }
  }
  if (selectedId) await loadModerationChannel(selectedId);
  if (state.moderation.isSuperadmin) await loadModerationAudit();
  if (state.moderation.isSuperadmin) await loadWorkspaceAdmin();
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
        ${renderAuditEntry(entry)}
      `).join('') || '<p>No moderation actions yet.</p>'}</div></div>`;
  } catch (err) {
    console.error('Load workspace audit log error:', err);
    container.innerHTML = '<div class="moderation-card"><h2>Workspace audit log</h2><p>Could not load the audit log.</p></div>';
  }
}

const AUDIT_ACTION_LABELS = {
  account_role_changed: 'changed the account role for',
  back_to_prelaunch: 'returned the workspace to pre-launch mode',
  channel_deleted: 'deleted a channel',
  default_slowmode_changed: 'changed the default slow mode',
  email_changed: 'changed the email address for',
  invitation_created: 'created an invitation',
  invitation_revoked: 'revoked an invitation',
  member_removed: 'removed channel access for',
  member_role_changed: 'changed the channel role for',
  message_deleted: 'deleted a message',
  message_reported: 'reported a message',
  prelaunch_password_applied: 'applied the pre-launch password',
  prelaunch_password_off: 'turned off the pre-launch password',
  prelaunch_password_on: 'turned on the pre-launch password',
  prelaunch_went_live: 'moved the workspace out of pre-launch',
  registration_mode_changed: 'changed the registration mode',
  role_created: 'created a workspace role',
  role_deleted: 'deleted a workspace role',
  role_moved: 'reordered a workspace role',
  role_updated: 'updated a workspace role',
  roles_assigned: 'changed workspace roles for',
  settings_updated: 'updated moderation settings',
  slowmode_changed: 'changed channel slow mode',
  slowmode_set_for_all_channels: 'changed slow mode for all channels',
  timeout_removed: 'removed the timeout for',
  user_created: 'created a user account',
  user_timed_out: 'temporarily restricted',
  username_changed: 'changed the username for',
  view_as_started: 'started viewing the workspace as',
  went_live: 'made the workspace live',
};

function humanizeAuditAction(action) {
  if (AUDIT_ACTION_LABELS[action]) return AUDIT_ACTION_LABELS[action];
  return String(action || 'performed an action').replace(/_/g, ' ').toLowerCase();
}

function renderAuditEntry(entry) {
  const actor = entry.actorUsername || 'A former user';
  const target = entry.targetUsername ? ` ${entry.targetUsername}` : '';
  const channel = entry.channelName ? ` in #${entry.channelName}` : '';
  const occurredAt = new Date(entry.createdAt).toLocaleString();
  const technicalDetails = {
    eventId: entry.id,
    action: entry.action,
    channelId: entry.channelId,
    details: entry.details || {},
  };
  return `<article class="moderation-row audit-entry">
    <div class="audit-entry-summary">
      <span><strong>${escapeHtml(actor)}</strong> ${escapeHtml(humanizeAuditAction(entry.action))}${escapeHtml(target)}${escapeHtml(channel)}.</span>
      <time datetime="${escapeHtml(entry.createdAt)}">${escapeHtml(occurredAt)}</time>
    </div>
    <details class="audit-entry-details">
      <summary>View details</summary>
      <pre>${escapeHtml(JSON.stringify(technicalDetails, null, 2))}</pre>
    </details>
  </article>`;
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
      <div class="moderation-row moderation-member-row">
        <span class="moderation-member-name">${escapeHtml(member.username)}</span>
        <span class="moderation-member-role">${escapeHtml(member.role)}</span>
        <div class="moderation-row-actions">
          ${state.moderation.canManageChannels ? `<select data-member-role="${member.id}" aria-label="Role for ${escapeHtml(member.username)}"><option value="member"${member.role === 'member' ? ' selected' : ''}>Member</option><option value="moderator"${member.role === 'moderator' ? ' selected' : ''}>Moderator</option></select><button class="btn" data-action="save-role" data-member-id="${member.id}">Save role</button><button class="btn" data-action="remove-member" data-member-id="${member.id}">Remove access</button>` : ''}
          <button class="btn" data-action="timeout" data-member-id="${member.id}">Timeout</button>
        </div>
      </div>`).join('');
    const memberIds = new Set(members.map((member) => Number(member.id)));
    const addableUsers = state.users.filter((user) => !memberIds.has(Number(user.id)));
    const selectedChannel = state.channels.find((channel) => Number(channel.id) === Number(channelId));
    const ownerName = selectedChannel
      ? ([selectedChannel.creatorFirstName, selectedChannel.creatorMiddleName, selectedChannel.creatorLastName].filter(Boolean).join(' ') || selectedChannel.creatorUsername || 'Unknown owner')
      : 'Unknown owner';
    dataContainer.innerHTML = `
      ${state.moderation.canManageChannels && selectedChannel ? `<div class="moderation-card moderation-channel-owner"><h2>Channel ownership</h2><div class="moderation-owner-row"><button type="button" class="avatar-mini" data-user-id="${selectedChannel.createdBy}" data-moderation-owner style="background:${escapeHtml(selectedChannel.creatorAvatarColor || '#64748b')}" title="${escapeHtml(ownerName)}" aria-label="Open ${escapeHtml(ownerName)}'s menu">${escapeHtml(ownerName.charAt(0).toUpperCase())}</button><span><strong>${escapeHtml(ownerName)}</strong><small>Owner of #${escapeHtml(selectedChannel.name)}</small></span></div></div>` : ''}
      <div class="moderation-card">
        <h2>Channel rules</h2>
        <div class="moderation-inline"><label>Slow mode (seconds)<input id="moderation-slowmode" type="number" min="0" max="3600" value="${data.channel.slowmodeSeconds}" ${state.moderation.isSuperadmin || state.moderation.moderatorChannelIds.some((id) => Number(id) === Number(channelId)) ? '' : 'disabled'}></label><button class="btn primary" data-action="save-slowmode">Save</button></div>
      </div>
      <div id="moderation-channel-permissions"></div>
      ${state.moderation.canManageChannels ? `
        <form class="moderation-card moderation-inline" data-moderation-form="add-member">
          <h2>Add channel access</h2>
          <select name="userId" required aria-label="Choose a user">${addableUsers.length
            ? addableUsers.map((user) => `<option value="${user.id}">${escapeHtml(user.username)}</option>`).join('')
            : '<option value="">All users already have access</option>'}</select>
          <select name="role" aria-label="Choose a channel role"><option value="member">Member</option><option value="moderator">Moderator</option></select>
          <button class="btn primary" type="submit" ${addableUsers.length ? '' : 'disabled'}>Add user</button>
        </form>` : ''}
      <div class="moderation-card"><h2>Channel members</h2><p class="admin-help">Search this channel's explicit members. Workspace roles and channel permission rules can grant access without adding every employee one by one.</p><input type="search" id="moderation-member-filter" placeholder="Search members…" aria-label="Filter channel members"><div class="moderation-list" id="moderation-member-list">${memberRows || '<p>No channel members.</p>'}</div></div>
      <div class="moderation-card"><h2>Active timeouts</h2><div class="moderation-list">${(data.timeouts || []).map((timeout) => `
        <div class="moderation-row"><span>${escapeHtml(timeout.username)} · until ${escapeHtml(new Date(timeout.expiresAt).toLocaleString())}${timeout.reason ? ` · ${escapeHtml(timeout.reason)}` : ''}</span><button class="btn" data-action="remove-timeout" data-member-id="${timeout.userId}">Remove timeout</button></div>
      `).join('') || '<p>No active timeouts.</p>'}</div></div>
      <div class="moderation-card"><h2>Open reports</h2><div class="moderation-list">${(data.reports || []).map((report) => `
        <div class="moderation-row moderation-report"><span>Message #${report.messageId} · reported by ${escapeHtml(report.reporterUsername || 'former user')} · ${escapeHtml(report.targetUsername)}: ${escapeHtml(report.reason)}</span><div class="moderation-row-actions"><button class="btn" data-action="resolve-report" data-report-id="${report.id}">Resolve</button><button class="btn" data-action="dismiss-report" data-report-id="${report.id}">Dismiss</button></div></div>
      `).join('') || '<p>No open reports.</p>'}</div></div>
      ${canDeleteChannel(channelId) ? `<div class="moderation-card moderation-danger"><h2>Delete this channel</h2><p class="admin-help">Deletes #${escapeHtml(data.channel.name)} for everyone: its messages, files, canvas, lists and links. This cannot be undone. The audit log keeps a record that it happened.</p><button class="btn danger" type="button" data-action="delete-channel">Delete channel…</button></div>` : ''}
      <div class="moderation-card"><h2>Recent audit log</h2><div class="moderation-list">${(data.auditLog || []).map((entry) => `
        ${renderAuditEntry({ ...entry, channelName: data.channel.name })}
      `).join('') || '<p>No moderation actions yet.</p>'}</div></div>`;
    const ownerAvatar = dataContainer.querySelector('[data-moderation-owner]');
    if (ownerAvatar && typeof paintAvatar === 'function') {
      paintAvatar(ownerAvatar, { id: selectedChannel.createdBy, photoVersion: selectedChannel.creatorPhotoVersion }, ownerName.charAt(0).toUpperCase());
    }
    loadChannelPermissionsCard(channelId);
    await loadChannelWebhooks(channelId);
  } catch (err) {
    console.error('Load channel moderation error:', err);
    dataContainer.innerHTML = `<div class="empty-state"><h2>Could not load moderation data</h2><p>${escapeHtml(err.message || 'Please try again.')}</p><button class="btn" data-action="refresh-channel">Try again</button></div>`;
  }
}

// The Superadmin, or the person who created the channel, may delete it.
function canDeleteChannel(channelId) {
  if (state.moderation.canManageChannels) return true;
  const channel = state.channels.find((c) => Number(c.id) === Number(channelId));
  return Boolean(channel && state.user && Number(channel.createdBy) === Number(state.user.id));
}

async function handleModerationClick(event) {
  const tabButton = event.target.closest('[data-mod-tab-button]');
  if (tabButton) {
    state.moderation.tab = tabButton.dataset.modTabButton;
    const host = document.getElementById('moderation-content');
    if (host) host.dataset.tab = state.moderation.tab;
    host?.querySelectorAll('[data-mod-tab-button]').forEach((b) => b.classList.toggle('active', b === tabButton));
    if (state.moderation.tab === 'roles') loadRolesPanel();
    return;
  }
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const channelId = moderationChannelId();
  const userId = Number(button.dataset.memberId ?? button.dataset.userId);
  const action = button.dataset.action;
  try {
    if (action === 'refresh-channel') return loadModerationChannel(channelId);
    if (action === 'save-role') {
      const role = document.querySelector(`[data-member-role="${userId}"]`).value;
      await checkedApi(`/api/moderation/channels/${channelId}/members/${userId}`, 'PUT', { role });
    } else if (action === 'remove-member') {
      if (!(await confirmAction({
        title: 'Remove from channel',
        message: 'Remove this user from the channel?',
        confirmLabel: 'Remove',
        danger: true,
      }))) return;
      await checkedApi(`/api/moderation/channels/${channelId}/members/${userId}`, 'DELETE');
    } else if (action === 'timeout') {
      const duration = await askText('Timeout duration in minutes (blank uses the workspace default):', { maxLength: 6 });
      if (duration === null) return;
      const reason = await askText('Reason (optional):');
      if (reason === null) return;
      await checkedApi(`/api/moderation/channels/${channelId}/timeouts/${userId}`, 'POST', {
        ...(duration.trim() ? { durationMinutes: Number(duration) } : {}), reason,
      });
    } else if (action === 'remove-timeout') {
      await checkedApi(`/api/moderation/channels/${channelId}/timeouts/${userId}`, 'DELETE');
    } else if (action === 'delete-channel') {
      const name = state.moderation.channel && state.moderation.channel.name;
      const typed = await askText(`This deletes #${name} and everything in it for good. Type the channel name to confirm.`, { placeholder: name, maxLength: 80 });
      if (typed === null) return;
      if (typed.trim() !== name) { showToast('The name did not match, so nothing was deleted.', 'error'); return; }
      await checkedApi(`/api/moderation/channels/${channelId}`, 'DELETE');
      state.moderation.channel = null;
      showToast(`#${name} was deleted.`, 'success');
      await loadChannels();
      await loadModerationView();
      return;
    } else if (action === 'save-default-slowmode') {
      await checkedApi('/api/moderation/slowmode-policy', 'PUT', { defaultSeconds: Number(document.getElementById('slowmode-default').value) });
    } else if (action === 'apply-slowmode-all') {
      const seconds = Number(document.getElementById('slowmode-all').value);
      if (!(await confirmAction({ title: 'Slow mode for every channel', message: `Set slow mode to ${seconds} seconds on every existing channel? Each channel's own setting is replaced.`, confirmLabel: 'Apply to all' }))) return;
      const result = await checkedApi('/api/moderation/slowmode-all', 'POST', { seconds });
      showToast(`Slow mode is ${seconds} seconds on ${result.channels} channel${result.channels === 1 ? '' : 's'}.`, 'success');
      await loadModerationChannel(channelId);
      return;
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
      const channelId = moderationChannelId();
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
  const channelId = moderationChannelId(event.target);
  if (channelId) await loadModerationChannel(channelId);
}

function handleModerationFilter(event) {
  if (event.target.id === 'moderation-channel-select') {
    moderationChannelId(event.target);
  } else if (event.target.id === 'moderation-member-filter') {
    const query = event.target.value.trim().toLowerCase();
    document.querySelectorAll('#moderation-member-list .moderation-member-row').forEach((row) => {
      row.hidden = Boolean(query) && !row.textContent.toLowerCase().includes(query);
    });
  }
}

function moderationChannelId(input = document.getElementById('moderation-channel-select')) {
  if (!input) return null;
  const name = input.value.trim().replace(/^#/, '').toLowerCase();
  const channel = (state.channels || []).find((item) => item.name.toLowerCase() === name);
  input.dataset.channelId = channel ? String(channel.id) : '';
  return channel ? Number(channel.id) : null;
}

async function handleModerationMessageClick(event) {
  const reportButton = event.target.closest('[data-report-message]');
  const deleteButton = event.target.closest('[data-moderate-delete]');
  if (reportButton) {
    const reason = await askText('Why are you reporting this message?');
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
    if (!(await confirmAction({
      title: 'Remove for everyone',
      message: 'Remove this message for everyone?',
      confirmLabel: 'Remove',
      danger: true,
    }))) return;
    try {
      await checkedApi(`/api/moderation/messages/${deleteButton.dataset.moderateDelete}`, 'DELETE');
      showToast('Message removed.', 'success');
    } catch (err) {
      showToast(err.message || 'Could not remove this message.', 'error');
    }
  }
}

// Reusable confirmation dialog (replaces native window.confirm).
// Resolves with true if the user confirms, false on cancel / Escape / backdrop click.
function confirmAction({ title = '', message = '', confirmLabel = 'Delete', cancelLabel = 'Cancel', danger = true } = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay open';
    const modal = document.createElement('div');
    modal.className = 'modal confirm-modal open';
    modal.setAttribute('role', 'alertdialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', title || message || 'Confirm action');
    modal.innerHTML = `
      <div class="modal-body">
        ${title ? `<h3 class="confirm-title">${escapeHtml(title)}</h3>` : ''}
        ${message ? `<p class="confirm-message">${escapeHtml(message)}</p>` : ''}
      </div>
      <div class="modal-footer">
        <button class="btn" type="button" data-confirm-cancel>${escapeHtml(cancelLabel)}</button>
        <button class="btn ${danger ? 'danger' : 'primary'}" type="button" data-confirm-ok>${escapeHtml(confirmLabel)}</button>
      </div>`;
    const finish = (value) => {
      document.removeEventListener('keydown', onKeydown, true);
      overlay.remove();
      modal.remove();
      resolve(value);
    };
    const onKeydown = (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      finish(false);
    };
    modal.querySelector('[data-confirm-ok]').addEventListener('click', () => finish(true));
    modal.querySelectorAll('[data-confirm-cancel]').forEach((btn) => btn.addEventListener('click', () => finish(false)));
    overlay.addEventListener('click', () => finish(false));
    document.addEventListener('keydown', onKeydown, true);
    document.body.append(overlay, modal);
    // Focus the Cancel button so Enter does not accidentally confirm a destructive action
    modal.querySelector('[data-confirm-cancel]')?.focus();
  });
}

// Electron does not implement window.prompt(), so text input uses an in-app dialog.
// Resolves with the entered text, or null when the dialog is cancelled.
function askText(message, { placeholder = '', maxLength = 500, required = false } = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay open';
    const modal = document.createElement('form');
    modal.className = 'modal open';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.innerHTML = `
      <div class="modal-body">
        <div class="form-group">
          <label for="ask-text-input">${escapeHtml(message)}</label>
          <input id="ask-text-input" type="text" autocomplete="off" maxlength="${Number(maxLength)}" placeholder="${escapeHtml(placeholder)}"${required ? ' required' : ''}>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn" type="button" data-ask-cancel>Cancel</button>
        <button class="btn primary" type="submit">OK</button>
      </div>`;
    const input = modal.querySelector('input');
    const finish = (value) => {
      document.removeEventListener('keydown', onKeydown, true);
      overlay.remove();
      modal.remove();
      resolve(value);
    };
    const onKeydown = (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      finish(null);
    };
    modal.addEventListener('submit', (event) => {
      event.preventDefault();
      if (required && !input.value.trim()) return;
      finish(input.value);
    });
    modal.querySelector('[data-ask-cancel]').addEventListener('click', () => finish(null));
    overlay.addEventListener('click', () => finish(null));
    document.addEventListener('keydown', onKeydown, true);
    document.body.append(overlay, modal);
    input.focus();
  });
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

  const directCall = state.huddle.direct;
  const selectedChannelId = (directCall ? null : state.huddle.channelId)
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
  if (title) {
    title.textContent = directCall
      ? (joined ? `Huddle with ${directCall.username}` : `Calling ${directCall.username}\u2026`)
      : (joined && channel ? `Huddle in #${channel.name}` : 'Channel huddle');
  }
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
  updateHuddleVideoControls();
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
    if (participant.id !== undefined && participant.id !== null) avatar.dataset.avatarUser = String(participant.id);
    const name = document.createElement('span');
    name.textContent = participant.peerId === state.socket?.id
      ? `${participant.username} (you)`
      : participant.username || 'Workspace member';
    item.append(avatar, name);
    container.appendChild(item);
  });
}

// Join the channel chosen in the list, or (with `direct`: { userId, username }) start or answer a one-to-one call.
async function joinHuddle(direct) {
  const select = document.getElementById('huddle-channel-select');
  const isDirect = Boolean(direct) && Number.isSafeInteger(Number(direct.userId));
  const channelId = Number(select?.value);
  if (!isDirect && (!Number.isSafeInteger(channelId) || !state.channels.some((channel) => Number(channel.id) === channelId))) {
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
  state.huddle.direct = isDirect ? { userId: Number(direct.userId), username: direct.username || 'them' } : null;
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
    setHuddleStatus(isDirect ? `Calling ${state.huddle.direct.username}\u2026` : 'Joining channel huddle…');
    state.socket.emit('huddle:join', isDirect ? { withUserId: state.huddle.direct.userId } : channelId);
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

  state.huddle.statusType = 'connected';
  updateHuddleConnectedStatus();
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
  attachHuddleVideo(peer, createOffer);

  connection.onicecandidate = ({ candidate }) => {
    if (candidate && state.socket?.connected) {
      state.socket.emit('huddle:signal', {
        to: participant.peerId,
        signal: { candidate: candidate.toJSON() },
      });
    }
  };
  connection.ontrack = (event) => {
    if (event.track.kind === 'video') {
      handleRemoteHuddleVideo(peer, event.track);
      return;
    }
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
      await prepareHuddleVideoAnswer(peer);
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
  removeHuddleVideo(peerId);
  renderHuddleParticipants();
  updateHuddleConnectedStatus();
}

// Keep the connected status in step with who is in the call (the map includes this client).
function updateHuddleConnectedStatus() {
  if (!state.huddle.channelId || state.huddle.statusType !== 'connected') return;
  const channel = state.channels.find((item) => Number(item.id) === Number(state.huddle.channelId));
  const alone = state.huddle.participants.size <= 1;
  const direct = state.huddle.direct;
  setHuddleStatus(
    direct
      ? `Connected to ${direct.username}${alone ? '. Waiting for them to answer.' : ''}`
      : `Connected to #${channel?.name || 'channel'}${alone ? '. Waiting for others to join.' : ''}`,
    'connected'
  );
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
  stopLocalHuddleVideo();
  state.huddle.peers.clear();
  state.huddle.participants.clear();
  state.huddle.channelId = null;
  state.huddle.direct = null;
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

  updateActivityBadge();
  if (state.section === 'activity') renderActivityFeed();
}

function handleDocumentClick(event) {
  // Clicking an image attachment opens the lightbox (wired on the element directly)
  // Clicking any avatar opens the profile context menu
  const avatar = event.target.closest('[data-user-id], [data-avatar-user]');
  if (avatar) {
    const userId = avatar.getAttribute('data-user-id') || avatar.getAttribute('data-avatar-user');
    if (userId) {
      handleAvatarContextClick(avatar, event);
      return;
    }
  }
  // Toggle a per-message "More actions" menu open/closed
  const more = event.target.closest('[data-message-more]');
  if (more) {
    const menu = more.parentElement?.querySelector('.msg-more-menu');
    if (menu) {
      const willOpen = !menu.classList.contains('open');
      closeAllMenus();
      if (willOpen) {
        menu.classList.add('open');
        more.setAttribute('aria-expanded', 'true');
        positionMoreMenu(more, menu);
      }
      return;
    }
  }
  // Clicking a menu action always closes menus; nothing else to do here
  closeAllMenus();
  if (!event.target.closest('.search-box')) hideSearchResults();
  if (!event.target.closest('.emoji-picker') && !event.target.closest('[data-open-reactions]')) {
    closeEmojiPicker();
  }
  // Clear long-pressed mobile action state when tapping elsewhere
  if (!event.target.closest('.message')) {
    document.querySelectorAll('.message.actions-visible').forEach((node) => node.classList.remove('actions-visible'));
  }
}

let activeUserContextMenuId = null;

function openUserContextMenu(anchor, userId, usernameHint) {
  const menu = els.userContextMenu;
  if (!menu) return;
  activeUserContextMenuId = String(userId);
  const isSelf = Number(userId) === Number(state.user.id);
  const user = (state.users || []).find((u) => Number(u.id) === Number(userId));
  const name = user?.username || usernameHint || 'Unknown';
  if (els.userContextName) els.userContextName.textContent = name;
  if (els.userContextStatus) {
    const email = user?.email || '';
    els.userContextStatus.textContent = isSelf
      ? (email ? `This is you · ${email}` : 'This is you')
      : (email || statusLabelFor(user?.status));
  }
  const toggle = (el, show) => { if (el) el.hidden = !show; };
  toggle(els.userContextMessage, !isSelf);
  toggle(els.userContextPersonalPage, isSelf || user?.accountType === 'member');
  toggle(els.userContextEdit, isSelf);
  toggle(els.userContextPreferences, isSelf);
  toggle(els.userContextSignout, isSelf);
  toggle(els.userContextSep, isSelf);
  if (els.userContextMessage) {
    els.userContextMessage.textContent = isSelf ? '' : `Message ${name}`;
  }
  if (els.userContextProfile) {
    els.userContextProfile.textContent = `View ${name}'s profile`;
  }

  closeAllMenus();
  menu.classList.add('open');
  positionUserContextMenu(menu, anchor);
}

function statusLabelFor(status) {
  if (status === 'online') return 'Online';
  if (status === 'away') return 'Away';
  return 'Offline';
}

function positionUserContextMenu(menu, anchor) {
  const margin = 12;
  const rect = anchor.getBoundingClientRect();
  const menuWidth = menu.offsetWidth || 200;
  const menuHeight = menu.offsetHeight || 200;
  const left = Math.min(Math.max(margin, rect.left), Math.max(margin, window.innerWidth - menuWidth - margin));
  let top = rect.bottom + 6;
  if (top + menuHeight > window.innerHeight - margin) {
    top = Math.max(margin, rect.top - menuHeight - 6);
  }
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}

function handleAvatarContextClick(avatar, event) {
  event.preventDefault();
  event.stopPropagation();
  const userId = avatar.getAttribute('data-user-id') || avatar.getAttribute('data-avatar-user');
  if (!userId) return false;
  const container = avatar.closest('.message, .reaction-row, .later-item, .read-receipt-avatar, .dm-item, .user-profile-avatar, .huddle-participant');
  const name = container?.querySelector?.('.name, .reaction-row-name, .later-item-title strong, .dm-name, .huddle-participant-name')?.textContent
    || avatar.getAttribute('title')
    || avatar.textContent?.trim?.()
    || '';
  toggleUserContextMenu(avatar, userId, name);
  return true;
}

function toggleUserContextMenu(anchor, userId, name) {
  const menu = els.userContextMenu;
  if (!menu) { openUserContextMenu(anchor, userId, name); return; }
  const isOpenForSameUser = menu.classList.contains('open') && activeUserContextMenuId === String(userId);
  if (isOpenForSameUser) {
    closeAllMenus();
    return;
  }
  openUserContextMenu(anchor, userId, name);
}

function formatMemberSince(iso) {
  if (!iso) return 'Unknown';
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
}

function formatLastSeen(iso, status) {
  if (status === 'online') return 'Active now';
  if (!iso) return 'Unknown';
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

async function showUserProfile(userId) {
  try {
    const res = await api(`/api/users/${userId}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not load profile');
    const u = data.user;
    const isSelf = Number(u.id) === Number(state.user.id);

    if (els.userProfileAvatar) {
      els.userProfileAvatar.textContent = (u.username || 'U').charAt(0).toUpperCase();
      els.userProfileAvatar.style.background = u.avatarColor || '#A855F7';
      els.userProfileAvatar.style.backgroundImage = '';
      els.userProfileAvatar.dataset.avatarUser = String(u.id);
      delete els.userProfileAvatar.dataset.photoPainted;
      paintAvatarElement(els.userProfileAvatar);
    }
    if (els.userProfileName) els.userProfileName.textContent = u.username || 'User';
    if (els.userProfileDot) els.userProfileDot.className = `user-profile-dot ${u.status || 'offline'}`;
    if (els.userProfileStatusText) els.userProfileStatusText.textContent = statusLabelFor(u.status);
    if (els.userProfileEmailRow) els.userProfileEmailRow.hidden = false;
    if (els.userProfileEmail) els.userProfileEmail.textContent = u.email || '';
    if (els.userProfileMemberSince) els.userProfileMemberSince.value = formatMemberSince(u.createdAt);
    if (els.userProfileLastSeen) els.userProfileLastSeen.value = formatLastSeen(u.lastSeen, u.status);
    if (els.userProfileMessageBtn) {
      els.userProfileMessageBtn.hidden = isSelf;
      els.userProfileMessageBtn.onclick = () => { closeSettingsModal(); openDM(userId); };
    }
    if (els.userProfileEditBtn) {
      els.userProfileEditBtn.hidden = !isSelf;
      els.userProfileEditBtn.onclick = () => { closeSettingsModal(); openProfileModal(); };
    }
    openSettingsModal(els.userProfileModal);
  } catch (err) {
    console.error('Show user profile error:', err);
    showToast(err.message || 'Could not load this profile.', 'error');
  }
}

function positionMoreMenu(anchor, menu) {
  const rect = anchor.getBoundingClientRect();
  const menuRect = menu.getBoundingClientRect();
  const margin = 12;
  let left = Math.min(Math.max(margin, rect.left), Math.max(margin, window.innerWidth - menuRect.width - margin));
  let top = rect.bottom + 6;
  if (top + menuRect.height > window.innerHeight - margin) {
    top = Math.max(margin, rect.top - menuRect.height - 6);
  }
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}

// Long-press on a message reveals the action row on touch devices
let longPressTimer = null;
function initLongPress() {
  document.addEventListener('touchstart', (event) => {
    const message = event.target.closest('.message');
    if (!message) return;
    clearTimeout(longPressTimer);
    longPressTimer = setTimeout(() => {
      message.classList.toggle('actions-visible');
    }, 550);
  }, { passive: true });
  ['touchend', 'touchcancel', 'touchmove'].forEach((type) => {
    document.addEventListener(type, () => clearTimeout(longPressTimer), { passive: true });
  });
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
  document.querySelectorAll('.msg-more-menu.open').forEach((m) => {
    m.classList.remove('open');
    closed = true;
  });
  if (els.userContextMenu?.classList.contains('open')) {
    els.userContextMenu.classList.remove('open');
    closed = true;
  }
  document.querySelectorAll('[data-message-more][aria-expanded="true"]').forEach((b) => {
    b.setAttribute('aria-expanded', 'false');
  });
  ['btn-create', 'btn-user-menu', 'btn-app-menu', 'btn-rail-more'].forEach((id) => {
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
  if (action === 'status') {
    openStatusModal();
  } else if (action === 'profile') {
    openProfileModal();
  } else if (action === 'manage-profile' && state.user?.isSuperadmin && typeof openAdminDetails === 'function') {
    openAdminDetails();
  } else if (action === 'personal-page' && state.user?.isSuperadmin && typeof openPersonPage === 'function') {
    openPersonPage(state.user.id);
  } else if (action === 'preferences') {
    openPreferencesModal();
  } else if (action === 'account') {
    openAccountModal();
  }
}

function handleAppCommand(cmd) {
  if (cmd === 'devtools' && !state.user?.isSuperadmin) return;
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
      <div class="preview file-preview-icon" data-thumb-file="${escapeHtml(String(f.id))}" data-thumb-mime="${escapeHtml(f.mimeType || '')}" role="img" aria-label="${escapeHtml(f.name)}">${fileIconSvg(fileIcon(f.mimeType))}</div>
      <div class="title" title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</div>
      <div class="meta">${escapeHtml(humanSize(f.size))} · ${escapeHtml(where)}</div>
      <div class="meta">Shared by ${escapeHtml(f.uploaderUsername)} · ${shortTime(f.uploadedAt)}</div>
      ${Number(f.uploadedBy) === Number(state.user.id) || (f.channelId && canModerateChannel(f.channelId)) ? `<button class="file-card-delete" type="button" data-delete-file="${escapeHtml(String(f.id))}" data-file-name="${escapeHtml(f.name)}" data-moderator-delete="${Number(f.uploadedBy) !== Number(state.user.id)}">${Number(f.uploadedBy) === Number(state.user.id) ? 'Delete attachment' : 'Remove attachment'}</button>` : ''}
    `;
    card.addEventListener('click', (event) => {
      if (event.target.closest('[data-delete-file]')) return;
      previewFile(f);
    });
    card.querySelector('[data-delete-file]')?.addEventListener('click', (event) => {
      event.stopPropagation();
      deleteFileAttachment(
        f.id,
        f.name,
        Number(f.uploadedBy) !== Number(state.user.id) && Boolean(f.channelId && canModerateChannel(f.channelId)),
      );
    });
    decorateFileCard(card, f);
    grid.appendChild(card);
  });
  hydrateThumbnails(grid); // pictures show a thumbnail instead of the icon, as they scroll into view
}

async function previewFile(file) {
  const mime = String(file.mimeType || '').toLowerCase();
  const supported = mime.startsWith('image/') || mime === 'application/pdf'
    || mime.startsWith('text/') || mime.startsWith('audio/') || mime.startsWith('video/');
  if (!supported) {
    await downloadFile(file.id, file.name);
    return;
  }
  try {
    const res = await fetch(`${API_BASE}/api/files/${file.id}/download`, { headers: { Authorization: `Bearer ${state.token}` } });
    if (!res.ok) throw new Error('Could not load the preview');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const modal = document.createElement('div');
    modal.className = 'modal-overlay file-preview-overlay open';
    const media = mime.startsWith('image/') ? `<img src="${url}" alt="${escapeHtml(file.name)}">`
      : mime.startsWith('video/') ? `<video src="${url}" controls autoplay></video>`
        : mime.startsWith('audio/') ? `<audio src="${url}" controls autoplay></audio>`
          : `<iframe src="${url}" title="Preview ${escapeHtml(file.name)}"></iframe>`;
    modal.innerHTML = `<div class="modal file-preview-modal open" role="dialog" aria-modal="true" aria-label="Preview ${escapeHtml(file.name)}">
      <div class="modal-header"><div><h3>${escapeHtml(file.name)}</h3><p>${escapeHtml(mime || 'File')} · ${escapeHtml(humanSize(file.size))}</p></div><button type="button" class="modal-close" data-close-file-preview aria-label="Close">&times;</button></div>
      <div class="file-preview-body">${media}</div>
      <div class="modal-footer"><button type="button" class="btn" data-download-preview>Download</button><button type="button" class="btn primary" data-close-file-preview>Close</button></div>
    </div>`;
    const close = () => { URL.revokeObjectURL(url); modal.remove(); };
    modal.addEventListener('click', (event) => {
      if (event.target === modal || event.target.closest('[data-close-file-preview]')) close();
      else if (event.target.closest('[data-download-preview]')) downloadFile(file.id, file.name);
    });
    document.body.appendChild(modal);
  } catch (err) {
    showToast(err.message || 'Could not preview this file.', 'error');
  }
}

function canModerateChannel(channelId) {
  return state.moderation.isSuperadmin
    || state.moderation.moderatorChannelIds.some((id) => Number(id) === Number(channelId));
}

function canEditChannelTopic(channelId) {
  const ch = (state.channels || []).find((c) => Number(c.id) === Number(channelId));
  if (state.moderation.isSuperadmin) return true;
  if (ch && Number(ch.createdBy) === Number(state.user?.id)) return true;
  return state.moderation.moderatorChannelIds.some((id) => Number(id) === Number(channelId));
}

function updateEditTopicVisibility(channelId) {
  if (!els.editTopicBtn) return;
  els.editTopicBtn.hidden = !canEditChannelTopic(channelId);
}

function startEditChannelTopic() {
  const ch = state.channels.find((c) => Number(c.id) === Number(state.currentChannelId));
  if (!ch || !els.channelTopicInput || !els.channelTopicForm || !els.editTopicBtn || !els.channelTopic) return;
  els.channelTopicInput.value = ch.topic || '';
  els.channelTopic.hidden = true;
  els.editTopicBtn.hidden = true;
  els.channelTopicForm.hidden = false;
  els.channelTopicInput.focus();
  els.channelTopicInput.select();
}

function cancelEditChannelTopic() {
  if (!els.channelTopicForm || !els.editTopicBtn || !els.channelTopic) return;
  els.channelTopicForm.hidden = true;
  els.channelTopic.hidden = false;
  updateEditTopicVisibility(state.currentChannelId);
}

async function saveEditChannelTopic(event) {
  event.preventDefault();
  const channelId = state.currentChannelId;
  if (!channelId) return;
  const input = els.channelTopicInput;
  if (!input) return;
  const topic = input.value.slice(0, 250);
  try {
    const res = await api(`/api/channels/${channelId}`, {
      method: 'PATCH',
      body: JSON.stringify({ topic }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not edit the description');
    const newTopic = data.channel?.topic || topic;
    const saved = state.channels.find((c) => Number(c.id) === Number(channelId));
    if (saved) saved.topic = newTopic;
    if (els.channelTopic) els.channelTopic.textContent = newTopic;
    cancelEditChannelTopic();
    showToast('Channel description updated.', 'success');
  } catch (err) {
    console.error('Update channel description error:', err);
    showToast(err.message || 'Could not update the description.', 'error');
    cancelEditChannelTopic();
  }
}

async function handleImageAction(event) {
  const downloadBtn = event.target.closest('[data-download-attachment]');
  if (downloadBtn) {
    event.preventDefault();
    event.stopPropagation();
    await downloadFile(downloadBtn.dataset.downloadAttachment, downloadBtn.dataset.fileName || 'file');
    return;
  }
  const removeBtn = event.target.closest('[data-remove-image]');
  if (removeBtn) {
    event.preventDefault();
    event.stopPropagation();
    const fileId = removeBtn.dataset.removeImage;
    await deleteFileAttachment(fileId, removeBtn.dataset.imageName || 'image', removeBtn.dataset.moderator === 'true');
    return;
  }
  const copyBtn = event.target.closest('[data-copy-image]');
  if (copyBtn) {
    event.preventDefault();
    event.stopPropagation();
    const fileId = copyBtn.dataset.copyImage;
    try {
      const res = await fetch(`${API_BASE}/api/files/${fileId}/download`, {
        headers: { 'Authorization': `Bearer ${state.token}` },
      });
      if (!res.ok) throw new Error('Could not load image');
      const blob = await res.blob();
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('Could not encode image'));
        reader.readAsDataURL(blob);
      });
      const result = await window.electronAPI?.copyImageToClipboard?.(dataUrl);
      if (!result?.ok) throw new Error(result?.error || 'Could not copy image');
      showToast('Image copied to clipboard.', 'success');
    } catch (err) {
      console.error('Copy image error:', err);
      showToast(err.message || 'Could not copy image.', 'error');
    }
  }
}

let imageViewerState = { fileId: null, name: null, size: null, uploaderId: null, canModerate: false, mimeType: null };

function canRemoveImageAttachment(uploaderId, moderated) {
  if (Number(uploaderId) === Number(state.user?.id)) return true;
  if (moderated || canModerateChannel(state.currentChannelId)) return true;
  return false;
}

function openImageViewer({ fileId, name, size, imgAlt, uploaderId, canModerate, mimeType }) {
  imageViewerState = { fileId, name, size, uploaderId, canModerate: Boolean(canModerate), mimeType: mimeType || null };
  const modal = document.getElementById('image-viewer-modal');
  if (!modal) return;
  const title = document.getElementById('image-viewer-title');
  const meta = document.getElementById('image-viewer-meta');
  const img = document.getElementById('image-viewer-img');
  const removeBtn = document.getElementById('btn-viewer-remove');
  if (title) title.textContent = name || 'Image';
  if (meta) {
    const parts = [];
    if (size) parts.push(humanSize(Number(size) || 0));
    if (mimeType) parts.push(mimeType);
    meta.textContent = parts.join(' · ');
  }
  if (img) {
    img.src = document.querySelector(`.attachment-image[data-file-id="${String(fileId).replace(/"/g, '\\"')}"] img`)?.src || '';
    img.alt = imgAlt || name || 'Image';
  }
  if (removeBtn) removeBtn.hidden = !canRemoveImageAttachment(uploaderId, canModerate);
  modal.classList.add('open');
}

function closeImageViewer() {
  document.getElementById('image-viewer-modal')?.classList.remove('open');
  imageViewerState = { fileId: null, name: null, size: null, uploaderId: null, canModerate: false, mimeType: null };
}

function copyImageViewerImage() {
  const { fileId } = imageViewerState;
  if (!fileId) return;
  handleImageAction({ target: Object.assign(document.createElement('button'), { dataset: { copyImage: String(fileId) } }) });
}

async function removeImageViewerImage() {
  const { fileId, name, uploaderId, canModerate } = imageViewerState;
  if (!fileId) return;
  const moderated = canRemoveImageAttachment(uploaderId, canModerate) && Number(uploaderId) !== Number(state.user?.id);
  await deleteFileAttachment(fileId, name || 'image', moderated);
  closeImageViewer();
}

async function deleteFileAttachment(fileId, name, requireReason = false) {
  const reason = requireReason
    ? await askText(`Why are you removing "${name}"? (Required, up to 500 characters)`, { required: true })
    : '';
  if (requireReason && !reason?.trim()) return;
  if (reason && reason.trim().length > 500) {
    showToast('The reason must be 500 characters or fewer.', 'error');
    return;
  }
  if (!(await confirmAction({
    title: 'Delete attachment',
    message: `Delete "${name}" for everyone? This cannot be undone.`,
    confirmLabel: 'Delete',
    danger: true,
  }))) return;

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
      if (!(await confirmAction({
        title: 'Delete note',
        message: `Delete note "${n.title}"?`,
        confirmLabel: 'Delete',
        danger: true,
      }))) return;
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
  const isTable = document.getElementById('new-list-type')?.value === 'table';
  try {
    const res = await api('/api/lists', {
      method: 'POST',
      body: JSON.stringify(isTable
        ? { channelId, title, todoMode: false, columns: LIST_STARTER_COLUMNS }
        : { channelId, title }),
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
    // Table lists are drawn by features/lists-table.js once their columns and rows arrive
    if (list.todoMode === false) {
      return `<article class="card shared-list-card list-table-card" data-table-list="${list.id}"><p class="shared-list-empty">Loading…</p></article>`;
    }
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
  state.lists.filter((list) => list.todoMode === false).forEach((list) => loadListTable(list.id));
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
    if (!list || !(await confirmAction({
      title: 'Delete list',
      message: `Delete "${list.title}" and all its items?`,
      confirmLabel: 'Delete',
      danger: true,
    }))) return;
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
  if (state.canvasDirty && !(await confirmAction({
    title: 'Discard changes?',
    message: 'Discard unsaved canvas changes?',
    confirmLabel: 'Discard',
    danger: true,
  }))) {
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
  if (confirmDiscard && state.canvasDirty && !(await confirmAction({
    title: 'Discard changes?',
    message: 'Discard unsaved canvas changes?',
    confirmLabel: 'Discard',
    danger: true,
  }))) return;
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

async function createNewCanvas() {
  if (els.canvasChannelSelect?.disabled) {
    showToast('Join a channel before creating a canvas.', 'error');
    return;
  }
  if (state.canvasDirty && !(await confirmAction({
    title: 'Discard changes?',
    message: 'Discard unsaved canvas changes?',
    confirmLabel: 'Discard',
    danger: true,
  }))) return;
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
  if (!state.currentCanvasId || !(await confirmAction({
    title: 'Delete canvas',
    message: `Delete "${els.canvasTitleInput.value}"?`,
    confirmLabel: 'Delete',
    danger: true,
  }))) return;
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
  if (!state.moderation.canCreateChannels) {
    showToast('You do not have permission to create channels.', 'error');
    return;
  }
  document.getElementById('new-channel-available-row').hidden = !state.moderation.canManageWorkspace;
  document.getElementById('new-channel-available-all').checked = false;
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
  const availableToAll = Boolean(state.moderation.canManageWorkspace && document.getElementById('new-channel-available-all').checked);

  if (!name) return;

  try {
    const res = await api('/api/channels', {
      method: 'POST',
      body: JSON.stringify({ name, topic, availableToAll }),
    });

    if (!res.ok) throw new Error('Failed to create channel');

    const data = await res.json();
    closeModalCreateChannel();
    document.getElementById('new-channel-name').value = '';
    document.getElementById('new-channel-topic').value = '';

    await loadChannels();
    if (state.channelCreationSectionTarget && state.sidebarDraft) {
      const target = state.channelCreationSectionTarget.kind === 'workspace'
        ? state.workspaceSidebarDraft.sections.find((section) => section.id === state.channelCreationSectionTarget.id)
        : state.sidebarDraft.sections.find((section) => section.id === state.channelCreationSectionTarget.id);
      if (target) target.channelIds.push(Number(data.channel.id));
      state.channelCreationSectionTarget = null;
      state.sidebarAvailabilityDraft[data.channel.id] = Boolean(data.channel.availableToAll);
      state.sidebarChannelNameDraft[data.channel.id] = data.channel.name;
      renderSidebarModal();
    } else {
      openChannel(data.channel.id);
    }
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

// ============================================================
// Canvas 2.0
// ============================================================
const canvas2State = {
  activeId: null,
  kind: null,
  otherUserId: null,
  channelId: null,
  saveTimer: null,
  saving: false,
  // Revision this editor is based on, and the text as last saved or loaded (to tell unsaved edits apart)
  revision: null,
  savedTitle: '',
  savedContent: '',
};

async function openCanvas2(kind, extra = {}) {
  const sheet = els.canvasSheet;
  if (!sheet || !els.canvasSheetEditor || !els.canvasSheetTitle || !els.canvasSheetKind) return;
  sheet.setAttribute('aria-hidden', 'true');
  try {
    let path;
    if (kind === 'channel') {
      canvas2State.channelId = Number(extra.channelId || state.currentChannelId);
      if (!canvas2State.channelId) return;
      path = `/api/canvas/channel/${canvas2State.channelId}`;
      els.canvasSheetKind.textContent = 'Channel canvas';
      canvas2State.otherUserId = null;
    } else if (kind === 'dm') {
      const userId = Number(extra.userId || state.currentDMId);
      if (!userId) return;
      canvas2State.channelId = null;
      canvas2State.otherUserId = userId;
      path = `/api/canvas/dm/${userId}`;
      els.canvasSheetKind.textContent = 'Direct message canvas';
    } else {
      return;
    }
    const res = await api(path);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not open the canvas');
    canvas2State.activeId = data.canvas.id;
    canvas2State.kind = data.canvas.kind;
    // guests can read a channel or direct message canvas but not change it: say so, and lock it
    const sheetCanEdit = data.canvas.myRole !== 'viewer';
    els.canvasSheetTitle.readOnly = !sheetCanEdit;
    els.canvasSheetEditor.readOnly = !sheetCanEdit;
    els.canvasSheetTitle.value = data.canvas.title || '';
    els.canvasSheetEditor.value = data.canvas.content || '';
    canvas2State.revision = data.canvas.revision ?? null;
    canvas2State.savedTitle = els.canvasSheetTitle.value;
    canvas2State.savedContent = els.canvasSheetEditor.value;
    if (els.canvasSheetStatus) {
      els.canvasSheetStatus.textContent = sheetCanEdit ? 'Saved' : 'View only';
      els.canvasSheetStatus.dataset.state = 'saved';
      els.canvasSheetStatus.title = sheetCanEdit ? '' : 'Guest accounts can read this canvas but not change it';
    }
    sheet.setAttribute('aria-hidden', 'false');
    if (state.socket) state.socket.emit('join_canvas', data.canvas.id);
    canvasViewOpened('sheet', { canEdit: sheetCanEdit, hasContent: Boolean(els.canvasSheetEditor.value.trim()) });
  } catch (err) {
    console.error('Open canvas error:', err);
    showToast(err.message || 'Could not open the canvas.', 'error');
  }
}

async function saveCanvas2() {
  const canvasId = canvas2State.activeId;
  if (!canvasId || canvas2State.saving) return;
  // Nothing typed since the last save or load: do not create a new revision (or history entry) for nothing.
  if (els.canvasSheetTitle.value === canvas2State.savedTitle && els.canvasSheetEditor.value === canvas2State.savedContent) return;
  canvas2State.saving = true;
  let retryAfterConflict = false;
  if (els.canvasSheetStatus) {
    els.canvasSheetStatus.textContent = 'Saving…';
    els.canvasSheetStatus.dataset.state = 'saving';
  }
  try {
    const sent = { title: els.canvasSheetTitle.value, content: els.canvasSheetEditor.value };
    const res = await api(`/api/canvas/${canvasId}`, {
      method: 'PATCH',
      body: JSON.stringify({ ...sent, baseRevision: canvas2State.revision ?? undefined }),
    });
    const data = await res.json();
    if (res.status === 409 && data.code === 'revision_conflict') {
      retryAfterConflict = await resolveCanvasConflict(canvas2State, data.canvas, sent, {
        title: els.canvasSheetTitle, content: els.canvasSheetEditor,
      });
    } else {
      if (!res.ok) throw new Error(data.error || 'Could not save the canvas');
      canvas2State.revision = data.canvas.revision ?? canvas2State.revision;
      canvas2State.savedTitle = sent.title;
      canvas2State.savedContent = sent.content;
    }
    if (els.canvasSheetStatus) {
      els.canvasSheetStatus.textContent = 'Saved';
      els.canvasSheetStatus.dataset.state = 'saved';
    }
  } catch (err) {
    console.error('Canvas save error:', err);
    showToast(err.message || 'Could not save the canvas.', 'error');
    if (els.canvasSheetStatus) {
      els.canvasSheetStatus.textContent = 'Error';
      els.canvasSheetStatus.dataset.state = 'error';
    }
  } finally {
    canvas2State.saving = false;
  }
  if (retryAfterConflict) await saveCanvas2();
}

// Shared by both canvas editors. The server refused a save because someone else saved first.
// Returns true when the caller should save again (the user kept their version, now based on the
// server's latest revision). Nothing is lost silently: choosing the other version copies yours to
// the clipboard first.
async function resolveCanvasConflict(editorState, serverCanvas, mine, fields) {
  const unsaved = mine.title !== editorState.savedTitle || mine.content !== editorState.savedContent;
  const theirs = { title: serverCanvas.title || '', content: serverCanvas.content || '' };
  const applyTheirs = () => {
    if (fields.title) fields.title.value = theirs.title;
    if (fields.content) fields.content.value = theirs.content;
    editorState.revision = serverCanvas.revision ?? null;
    editorState.savedTitle = theirs.title;
    editorState.savedContent = theirs.content;
  };
  if (!unsaved || (mine.title === theirs.title && mine.content === theirs.content)) {
    applyTheirs();
    return false;
  }
  const keepMine = await confirmAction({
    title: 'Someone else changed this canvas',
    message: 'Keep your version to replace theirs, or use theirs and drop your unsaved changes (your text is copied to the clipboard first).',
    confirmLabel: 'Keep my version',
    cancelLabel: 'Use theirs',
    danger: false,
  });
  if (keepMine) {
    editorState.revision = serverCanvas.revision ?? null;
    return true;
  }
  try { await navigator.clipboard.writeText(mine.content); } catch (_) { /* clipboard is best effort */ }
  applyTheirs();
  showToast('Their version is shown. Your text was copied to the clipboard.', 'info');
  return false;
}

// A live update from another person. Applied unless the user has unsaved edits in this editor;
// the revision is only adopted together with the text, so a later save from unsaved edits is
// checked against the version they were really based on.
function applyRemoteCanvasUpdate(editorState, event, fields) {
  const incomingRevision = event.revision === undefined ? null : Number(event.revision);
  if (incomingRevision !== null && editorState.revision !== null && incomingRevision <= editorState.revision) return;
  const editor = fields.content;
  if (!editor) return;
  const dirty = editor.value !== editorState.savedContent
    || (fields.title && event.title !== undefined && fields.title.value !== editorState.savedTitle);
  if (dirty) return;
  const start = editor.selectionStart;
  const end = editor.selectionEnd;
  editor.value = event.content ?? '';
  if (document.activeElement === editor) editor.setSelectionRange(Math.min(start, editor.value.length), Math.min(end, editor.value.length));
  if (fields.title && event.title !== undefined && document.activeElement !== fields.title) fields.title.value = event.title;
  editorState.savedContent = editor.value;
  if (fields.title) editorState.savedTitle = fields.title.value;
  if (incomingRevision !== null) editorState.revision = incomingRevision;
}

function debounceCanvas2Save() {
  clearTimeout(canvas2State.saveTimer);
  canvas2State.saveTimer = setTimeout(saveCanvas2, 800);
}

// The canvas panel belongs to one channel or direct message. When another conversation is opened, close it (saving first)
// instead of leaving the previous conversation's canvas on screen next to the new one.
function closeCanvasSheetForOtherConversation({ channelId = null, userId = null } = {}) {
  const sheet = els.canvasSheet;
  if (!sheet || sheet.getAttribute('aria-hidden') !== 'false') return;
  const sameChannel = channelId !== null && canvas2State.kind === 'channel' && Number(canvas2State.channelId) === Number(channelId);
  const sameDM = userId !== null && canvas2State.kind === 'dm' && Number(canvas2State.otherUserId) === Number(userId);
  if (!sameChannel && !sameDM) closeCanvas2();
}

function closeCanvas2() {
  clearTimeout(canvas2State.saveTimer);
  const sheet = els.canvasSheet;
  if (!sheet) return;
  if (canvas2State.activeId && state.socket) state.socket.emit('leave_canvas', canvas2State.activeId);
  sheet.setAttribute('aria-hidden', 'true');
  saveCanvas2();
  canvas2State.activeId = null;
}

// ============================================================
// Canvas 2.0 — Personal (standalone) canvas manager
// ============================================================
const canvas2StandaloneState = {
  activeId: null,
  list: [],
  saving: false,
  saveTimer: null,
  revision: null,
  savedTitle: '',
  savedContent: '',
};

async function loadCanvas2StandaloneList() {
  try {
    const res = await api('/api/canvas/standalone');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not load canvases');
    canvas2StandaloneState.list = data.canvases || [];
    renderCanvas2StandaloneList();
    const activeStillExists = canvas2StandaloneState.activeId
      && canvas2StandaloneState.list.some((c) => Number(c.id) === Number(canvas2StandaloneState.activeId));
    if (activeStillExists) return;
    if (canvas2StandaloneState.list.length > 0) {
      await openCanvas2Standalone(canvas2StandaloneState.list[0].id);
    } else {
      showCanvas2Empty();
    }
  } catch (err) {
    console.error('Load standalone canvases error:', err);
    showToast(err.message || 'Could not load standalone canvases.', 'error');
  }
}

function renderCanvas2StandaloneList() {
  const listEl = document.getElementById('canvas2-list');
  if (!listEl) return;
  listEl.innerHTML = '';
  if (canvas2StandaloneState.list.length === 0) {
    listEl.innerHTML = emptyRecordMarkup('No canvases yet', 'Create one with the + button.', 'compact');
    return;
  }
  for (const canvas of canvas2StandaloneState.list) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'canvas2-list-item';
    if (Number(canvas2StandaloneState.activeId) === Number(canvas.id)) btn.classList.add('active');
    btn.dataset.canvas2Id = String(canvas.id);
    btn.innerHTML = `<div class="canvas2-list-item-title">${escapeHtml(canvas.title || 'Untitled canvas')}</div>
      <div class="canvas2-list-item-meta">${escapeHtml(canvas.myRole === 'owner' ? 'Private' : canvas.myRole === 'editor' ? 'Editor' : canvas.myRole === 'commenter' ? 'Commenter' : 'Viewer')} · ${shortTime(canvas.updatedAt)}</div>`;
    listEl.appendChild(btn);
  }
}

function showCanvas2Empty() {
  const empty = document.getElementById('canvas2-empty-pane');
  const pane = document.getElementById('canvas2-editor-pane');
  if (empty) empty.hidden = false;
  if (pane) pane.hidden = true;
}
function showCanvas2EditorPane() {
  const empty = document.getElementById('canvas2-empty-pane');
  const pane = document.getElementById('canvas2-editor-pane');
  if (empty) empty.hidden = true;
  if (pane) pane.hidden = false;
}

async function openCanvas2Standalone(id) {
  try {
    const res = await api(`/api/canvas/${id}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not load canvas');
    const { canvas } = data;
    canvas2StandaloneState.activeId = canvas.id;
    const title = document.getElementById('canvas2-editor-title');
    const editor = document.getElementById('canvas2-editor');
    if (title) title.value = canvas.title || '';
    if (editor) editor.value = canvas.content || '';
    canvas2StandaloneState.revision = canvas.revision ?? null;
    canvas2StandaloneState.savedTitle = title ? title.value : '';
    canvas2StandaloneState.savedContent = editor ? editor.value : '';
    // Viewers (personal or via a channel) read but cannot change it
    const canEdit = canvas.myRole === 'owner' || canvas.myRole === 'editor';
    if (title) title.readOnly = !canEdit;
    if (editor) editor.readOnly = !canEdit;
    showCanvas2EditorPane();
    renderCanvas2StandaloneList();
    setCanvas2StandaloneStatus(canEdit ? 'Saved' : canvas.myRole === 'commenter' ? 'Comment only' : 'Read-only');
    if (state.socket) state.socket.emit('join_canvas', canvas.id);
    canvasViewOpened('standalone', { canEdit, canComment: canEdit || canvas.myRole === 'commenter', canRequest: !canEdit, hasContent: Boolean((editor ? editor.value : '').trim()) });
  } catch (err) {
    console.error('Open standalone canvas error:', err);
    showToast(err.message || 'Could not open the canvas.', 'error');
  }
}

async function createCanvas2Standalone() {
  try {
    const res = await api('/api/canvas', {
      method: 'POST',
      body: JSON.stringify({ title: 'Untitled canvas', content: '' }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not create canvas');
    canvas2StandaloneState.list = [data.canvas, ...canvas2StandaloneState.list];
    renderCanvas2StandaloneList();
    await openCanvas2Standalone(data.canvas.id);
  } catch (err) {
    console.error('Create standalone canvas error:', err);
    showToast(err.message || 'Could not create canvas.', 'error');
  }
}

function setCanvas2StandaloneStatus(text) {
  const el = document.getElementById('canvas2-status');
  if (el) el.textContent = text;
}

async function saveCanvas2Standalone() {
  const id = canvas2StandaloneState.activeId;
  if (!id || canvas2StandaloneState.saving) return;
  const titleEl = document.getElementById('canvas2-editor-title');
  const editor = document.getElementById('canvas2-editor');
  if (!titleEl || !editor) return;
  if (titleEl.value === canvas2StandaloneState.savedTitle && editor.value === canvas2StandaloneState.savedContent) return;
  canvas2StandaloneState.saving = true;
  let retryAfterConflict = false;
  setCanvas2StandaloneStatus('Saving…');
  try {
    const sent = { title: titleEl.value, content: editor.value };
    const res = await api(`/api/canvas/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ ...sent, baseRevision: canvas2StandaloneState.revision ?? undefined }),
    });
    const data = await res.json();
    if (res.status === 409 && data.code === 'revision_conflict') {
      retryAfterConflict = await resolveCanvasConflict(canvas2StandaloneState, data.canvas, sent, { title: titleEl, content: editor });
    } else {
      if (!res.ok) throw new Error(data.error || 'Could not save canvas');
      const updated = data.canvas;
      canvas2StandaloneState.revision = updated.revision ?? canvas2StandaloneState.revision;
      canvas2StandaloneState.savedTitle = sent.title;
      canvas2StandaloneState.savedContent = sent.content;
      const idx = canvas2StandaloneState.list.findIndex((c) => Number(c.id) === Number(id));
      if (idx !== -1) {
        canvas2StandaloneState.list[idx] = { ...canvas2StandaloneState.list[idx], title: updated.title, updatedAt: updated.updatedAt };
        renderCanvas2StandaloneList();
      }
    }
    setCanvas2StandaloneStatus('Saved');
  } catch (err) {
    console.error('Save standalone canvas error:', err);
    setCanvas2StandaloneStatus('Error');
    showToast(err.message || 'Could not save the canvas.', 'error');
  } finally {
    canvas2StandaloneState.saving = false;
  }
  if (retryAfterConflict) await saveCanvas2Standalone();
}

function debounceCanvas2StandaloneSave() {
  clearTimeout(canvas2StandaloneState.saveTimer);
  canvas2StandaloneState.saveTimer = setTimeout(saveCanvas2Standalone, 800);
}

async function deleteCanvas2Standalone() {
  const id = canvas2StandaloneState.activeId;
  if (!id) return;
  const current = canvas2StandaloneState.list.find((c) => Number(c.id) === Number(id));
  const ok = await confirmAction({
    title: 'Delete this canvas?',
    message: `"${current?.title || 'Untitled canvas'}" will move to Recently deleted. You can restore it for a few days; after that it is removed for good.`,
    confirmLabel: 'Delete',
    danger: true,
  });
  if (!ok) return;
  try {
    const res = await api(`/api/canvas/${id}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not delete the canvas');
    canvas2StandaloneState.list = canvas2StandaloneState.list.filter((c) => Number(c.id) !== Number(id));
    canvas2StandaloneState.activeId = null;
    renderCanvas2StandaloneList();
    if (canvas2StandaloneState.list.length > 0) {
      await openCanvas2Standalone(canvas2StandaloneState.list[0].id);
    } else {
      showCanvas2Empty();
    }
    showToast('Canvas deleted. You can restore it from Recently deleted.', 'success');
  } catch (err) {
    console.error('Delete standalone canvas error:', err);
    showToast(err.message || 'Could not delete the canvas.', 'error');
  }
}

// ============================================================
// Canvas 2.0 — Share / collaborators
// ============================================================
const canvas2ShareState = {
  lastShare: null,
};

async function openCanvas2ShareModal() {
  const id = canvas2StandaloneState.activeId;
  if (!id) return;
  const modal = document.getElementById('canvas2-share-modal');
  if (!modal) return;
  // Reset link row
  const linkRow = document.getElementById('canvas2-share-link-row');
  if (linkRow) linkRow.hidden = true;
  canvas2ShareState.lastShare = null;
  // Load collaborators
  try {
    const res = await api(`/api/canvas/${id}/collaborators`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not load collaborators');
    renderCanvas2ShareCollaborators(data.collaborators || []);
  } catch (err) {
    console.error('Load collaborators error:', err);
    showToast(err.message || 'Could not load collaborators.', 'error');
  }
  // Channel sharing and ownership are the owner's decisions; everyone else just sees who has access.
  const current = canvas2StandaloneState.list.find((c) => Number(c.id) === Number(id));
  const isOwner = !current || current.myRole === 'owner' || Number(current.ownerId) === Number(state.user.id);
  const ownerSection = document.getElementById('canvas2-owner-section');
  const channelForms = document.getElementById('canvas2-channel-add-form');
  if (ownerSection) ownerSection.hidden = !isOwner;
  if (channelForms) channelForms.hidden = !isOwner;
  await loadCanvas2ChannelGrants(isOwner);
  openSettingsModal(modal);
}

async function loadCanvas2ChannelGrants(isOwner) {
  const id = canvas2StandaloneState.activeId;
  const list = document.getElementById('canvas2-channel-list');
  const select = document.getElementById('canvas2-channel-select');
  if (!id || !list) return;
  try {
    const res = await api(`/api/canvas/${id}/channels`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not load channel sharing');
    const granted = data.channels || [];
    list.innerHTML = '';
    if (granted.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'canvas2-share-row canvas2-share-row-empty';
      empty.textContent = 'Not shared with any channel.';
      list.appendChild(empty);
    }
    for (const g of granted) {
      const row = document.createElement('li');
      row.className = 'canvas2-share-row';
      row.innerHTML = `<span class="canvas2-share-row-name">#${escapeHtml(g.name)}</span><span class="canvas2-share-row-role">${g.role === 'editor' ? 'can edit' : g.role === 'commenter' ? 'can comment' : 'can view'}</span>${isOwner ? `<button class="canvas2-share-row-remove" type="button" data-canvas2-remove-channel="${g.channelId}">Remove</button>` : ''}`;
      list.appendChild(row);
    }
    if (select) {
      const taken = new Set(granted.map((g) => Number(g.channelId)));
      const options = (state.channels || []).filter((ch) => !taken.has(Number(ch.id)));
      select.innerHTML = options.length
        ? options.map((ch) => `<option value="${escapeHtml(String(ch.id))}">#${escapeHtml(ch.name)}</option>`).join('')
        : '<option value="">No channels left</option>';
    }
  } catch (err) {
    console.error('Load canvas channel grants error:', err);
    showToast(err.message || 'Could not load channel sharing.', 'error');
  }
}

async function shareCanvas2WithChannel(channelId, role) {
  const id = canvas2StandaloneState.activeId;
  if (!id || !channelId) return;
  try {
    const res = await api(`/api/canvas/${id}/channels/${channelId}`, { method: 'PUT', body: JSON.stringify({ role }) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not share with the channel');
    await loadCanvas2ChannelGrants(true);
    showToast('Shared with the channel.', 'success');
  } catch (err) {
    console.error('Share canvas with channel error:', err);
    showToast(err.message || 'Could not share with the channel.', 'error');
  }
}

async function unshareCanvas2FromChannel(channelId) {
  const id = canvas2StandaloneState.activeId;
  if (!id) return;
  try {
    const res = await api(`/api/canvas/${id}/channels/${channelId}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not stop sharing');
    await loadCanvas2ChannelGrants(true);
  } catch (err) {
    console.error('Unshare canvas from channel error:', err);
    showToast(err.message || 'Could not stop sharing.', 'error');
  }
}

async function transferCanvas2Owner(username) {
  const id = canvas2StandaloneState.activeId;
  if (!id) return;
  const ok = await confirmAction({
    title: 'Transfer ownership?',
    message: `${username} will control sharing and deleting this canvas. You will stay on as an editor.`,
    confirmLabel: 'Transfer',
    danger: true,
  });
  if (!ok) return;
  try {
    const res = await api(`/api/canvas/${id}/owner`, { method: 'POST', body: JSON.stringify({ username: username.trim().toLowerCase() }) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not transfer ownership');
    closeSettingsModal();
    showToast(`${data.ownerUsername} is now the owner.`, 'success');
    await loadCanvas2StandaloneList();
  } catch (err) {
    console.error('Transfer canvas ownership error:', err);
    showToast(err.message || 'Could not transfer ownership.', 'error');
  }
}

function renderCanvas2ShareCollaborators(collaborators) {
  const list = document.getElementById('canvas2-share-list');
  if (!list) return;
  list.innerHTML = '';
  if (!collaborators || collaborators.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'canvas2-share-row canvas2-share-row-empty';
    empty.textContent = 'No collaborators yet.';
    list.appendChild(empty);
    return;
  }
  for (const collab of collaborators) {
    const row = document.createElement('li');
    row.className = 'canvas2-share-row';
    row.innerHTML = `<span class="canvas2-share-row-name">${escapeHtml(collab.username)}</span><span class="canvas2-share-row-role">${collab.role}</span><button class="canvas2-share-row-remove" type="button" data-canvas2-remove-collab="${collab.id}">Remove</button>`;
    list.appendChild(row);
  }
}

async function addCanvas2ShareCollaborator(username, role) {
  const id = canvas2StandaloneState.activeId;
  if (!id) return;
  try {
    const res = await api(`/api/canvas/${id}/collaborators`, {
      method: 'POST',
      body: JSON.stringify({ username: username.trim().toLowerCase(), role }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not add collaborator');
    const listRes = await api(`/api/canvas/${id}/collaborators`);
    const listData = await listRes.json();
    renderCanvas2ShareCollaborators(listData.collaborators || []);
    showToast('Collaborator added.', 'success');
  } catch (err) {
    console.error('Add collaborator error:', err);
    showToast(err.message || 'Could not add collaborator.', 'error');
  }
}

async function removeCanvas2ShareCollaborator(userId) {
  const id = canvas2StandaloneState.activeId;
  if (!id) return;
  try {
    const res = await api(`/api/canvas/${id}/collaborators/${userId}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not remove collaborator');
    const listRes = await api(`/api/canvas/${id}/collaborators`);
    const listData = await listRes.json();
    renderCanvas2ShareCollaborators(listData.collaborators || []);
    showToast('Collaborator removed.', 'success');
  } catch (err) {
    console.error('Remove collaborator error:', err);
    showToast(err.message || 'Could not remove collaborator.', 'error');
  }
}

async function createCanvas2ShareLink(role) {
  const id = canvas2StandaloneState.activeId;
  if (!id) return;
  try {
    const res = await api(`/api/canvas/${id}/shares`, {
      method: 'POST',
      body: JSON.stringify({ role }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not create share link');
    canvas2ShareState.lastShare = data.share;
    const linkInput = document.getElementById('canvas2-share-link');
    const copyBtn = document.getElementById('btn-canvas2-copy-link');
    const revokeBtn = document.getElementById('btn-canvas2-revoke-link');
    const linkRow = document.getElementById('canvas2-share-link-row');
    const shareUrl = `${window.location.origin}${window.location.pathname}#canvas-share=${data.share.token}`;
    if (linkInput) linkInput.value = shareUrl;
    if (linkRow) linkRow.hidden = false;
    if (copyBtn) copyBtn.hidden = false;
    if (revokeBtn) revokeBtn.hidden = false;
    showToast('Share link created.', 'success');
  } catch (err) {
    console.error('Create share link error:', err);
    showToast(err.message || 'Could not create share link.', 'error');
  }
}

async function revokeCanvas2ShareLink() {
  const id = canvas2StandaloneState.activeId;
  const shareId = canvas2ShareState.lastShare?.id;
  if (!id || !shareId) return;
  try {
    const res = await api(`/api/canvas/${id}/shares/${shareId}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not revoke share link');
    canvas2ShareState.lastShare = null;
    const linkRow = document.getElementById('canvas2-share-link-row');
    if (linkRow) linkRow.hidden = true;
    showToast('Share link revoked.', 'success');
  } catch (err) {
    console.error('Revoke share link error:', err);
    showToast(err.message || 'Could not revoke share link.', 'error');
  }
}

async function copyCanvas2ShareLink() {
  const input = document.getElementById('canvas2-share-link');
  if (!input) return;
  try {
    await window.electronAPI?.appCommand?.('copy') || navigator.clipboard.writeText(input.value);
    input.select();
    showToast('Share link copied to clipboard.', 'success');
  } catch {
    try { await navigator.clipboard.writeText(input.value); showToast('Share link copied.', 'success'); }
    catch { showToast('Could not copy link.', 'error'); }
  }
}

async function openCanvas2SharedToken(token) {
  showPane(null);
  showView('canvas2');
  updateRail('canvas2');
  try {
    const res = await api(`/api/canvas/share/${token}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Share link did not open.');
    // Navigate into the standalone canvas UI, restricted to the share role
    const { canvas } = data;
    canvas2StandaloneState.activeId = canvas.id;
    showCanvas2EditorPane();
    const title = document.getElementById('canvas2-editor-title');
    const editor = document.getElementById('canvas2-editor');
    if (title) title.value = canvas.title || '';
    if (editor) editor.value = canvas.content || '';
    setCanvas2StandaloneStatus(data.canvas.myRole === 'viewer' ? 'Read-only' : 'Saved');
    if (data.canvas.myRole === 'viewer') {
      if (editor) editor.readOnly = true;
      if (title) title.readOnly = true;
    } else {
      if (editor) editor.readOnly = false;
      if (title) title.readOnly = false;
      if (state.socket) state.socket.emit('join_canvas', canvas.id);
    }
    renderCanvas2StandaloneList();
  } catch (err) {
    console.error('Open share token error:', err);
    showToast(err.message || 'Share link did not open.', 'error');
  }
}

// If the URL has a share token, jump straight into it on load
window.addEventListener('load', () => {
  const match = window.location.hash.match(/^#canvas-share=(.+)$/);
  if (match && match[1]) openCanvas2SharedToken(match[1]);
});

document.addEventListener('click', (event) => {
  const channelBtn = event.target.closest('#btn-channel-canvas');
  if (channelBtn) {
    event.preventDefault();
    event.stopPropagation();
    openCanvas2('channel');
    return;
  }
  const dmBtn = event.target.closest('#btn-dm-canvas');
  if (dmBtn) {
    event.preventDefault();
    event.stopPropagation();
    openCanvas2('dm');
    return;
  }
  const closeBtn = event.target.closest('#btn-close-canvas');
  if (closeBtn) {
    event.preventDefault();
    event.stopPropagation();
    closeCanvas2();
    return;
  }
  const newStandalone = event.target.closest('#btn-canvas2-new, #btn-canvas2-new-empty');
  if (newStandalone) {
    event.preventDefault();
    event.stopPropagation();
    createCanvas2Standalone();
    return;
  }
  const listItem = event.target.closest('.canvas2-list-item');
  if (listItem) {
    event.preventDefault();
    event.stopPropagation();
    openCanvas2Standalone(listItem.dataset.canvas2Id);
    return;
  }
  const deleteStandalone = event.target.closest('#btn-canvas2-delete');
  if (deleteStandalone) {
    event.preventDefault();
    event.stopPropagation();
    deleteCanvas2Standalone();
    return;
  }
  const shareStandalone = event.target.closest('#btn-canvas2-share');
  if (shareStandalone) {
    event.preventDefault();
    event.stopPropagation();
    openCanvas2ShareModal();
    return;
  }
  const closeShareModal = event.target.closest('#btn-close-canvas2-share');
  if (closeShareModal) {
    event.preventDefault();
    event.stopPropagation();
    closeSettingsModal();
    return;
  }
  const removeChannel = event.target.closest('[data-canvas2-remove-channel]');
  if (removeChannel) {
    event.preventDefault();
    event.stopPropagation();
    unshareCanvas2FromChannel(removeChannel.dataset.canvas2RemoveChannel);
    return;
  }
  const removeCollab = event.target.closest('[data-canvas2-remove-collab]');
  if (removeCollab) {
    event.preventDefault();
    event.stopPropagation();
    removeCanvas2ShareCollaborator(removeCollab.dataset.canvas2RemoveCollab);
    return;
  }
  const createShareLink = event.target.closest('#btn-canvas2-create-link');
  if (createShareLink) {
    event.preventDefault();
    event.stopPropagation();
    const roleSel = document.getElementById('canvas2-share-link-role');
    createCanvas2ShareLink(roleSel?.value || 'editor');
    return;
  }
  const revokeShareLink = event.target.closest('#btn-canvas2-revoke-link');
  if (revokeShareLink) {
    event.preventDefault();
    event.stopPropagation();
    revokeCanvas2ShareLink();
    return;
  }
  const copyShareLink = event.target.closest('#btn-canvas2-copy-link');
  if (copyShareLink) {
    event.preventDefault();
    event.stopPropagation();
    copyCanvas2ShareLink();
    return;
  }
});

document.getElementById('btn-canvas2-request-access')?.addEventListener('click', async () => {
  const id = canvas2StandaloneState.activeId;
  if (!id) return;
  try {
    const res = await api(`/api/canvas/${id}/access-request`, { method: 'POST', body: JSON.stringify({}) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Could not send the request');
    showToast('Asked the owner for edit access.', 'success');
  } catch (err) {
    showToast(err.message || 'Could not send the request.', 'error');
  }
});

document.getElementById('canvas2-share-add-form')?.addEventListener('submit', (event) => {
  event.preventDefault();
  const input = document.getElementById('canvas2-share-username');
  const roleSel = document.getElementById('canvas2-share-role');
  const username = input?.value.trim();
  const role = roleSel?.value || 'editor';
  if (!username) return;
  addCanvas2ShareCollaborator(username, role);
  if (input) input.value = '';
});

document.getElementById('canvas2-channel-add-form')?.addEventListener('submit', (event) => {
  event.preventDefault();
  const channelId = document.getElementById('canvas2-channel-select')?.value;
  const role = document.getElementById('canvas2-channel-role')?.value || 'viewer';
  if (channelId) shareCanvas2WithChannel(channelId, role);
});

document.getElementById('canvas2-owner-form')?.addEventListener('submit', (event) => {
  event.preventDefault();
  const input = document.getElementById('canvas2-owner-username');
  const username = input?.value.trim();
  if (!username) return;
  transferCanvas2Owner(username);
  if (input) input.value = '';
});

document.getElementById('canvas2-editor-title')?.addEventListener('input', debounceCanvas2StandaloneSave);
document.getElementById('canvas2-editor')?.addEventListener('input', debounceCanvas2StandaloneSave);

document.addEventListener('input', (event) => {
  if (event.target === els.canvasSheetEditor || event.target === els.canvasSheetTitle) {
    debounceCanvas2Save();
  }
});

// Esc is handled by the shared handler above; do not double-bind.

// Start
init();
