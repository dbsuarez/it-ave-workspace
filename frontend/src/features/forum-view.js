// IT Avenue Workspace - department forum screens: the topic list and the topic header.
//
// Pure functions: topic data in, HTML out, every value escaped. Opening, pinning, locking, archiving and deleting are
// handled by delegated click handlers in renderer.js, which read the data attributes written here. Loaded before renderer.js.
//
// A topic is what GET /api/forums/:channelId/topics returns, plus `lastActivityText` (the relative time, worked out by
// the caller so these functions stay free of clocks and locales).

const FORUM_BADGES = { pinned: 'Pinned', locked: 'Locked', archived: 'Archived' };

function forumEscape(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// The forum's icon (speech bubbles), used where a channel shows its #.
function forumIconHtml() {
  return '<svg class="forum-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 11.5a7.5 7.5 0 0 1-7.5 7.5H8l-5 3 1.3-4.6A7.5 7.5 0 1 1 21 11.5z"/><path d="M8 10h8M8 13.5h5"/></svg>';
}

// A person's name in their role colour (only a plain #rrggbb colour is ever written into the page).
function forumAuthorHtml(name, color) {
  const style = /^#[0-9a-fA-F]{6}$/.test(color || '') ? ` style="color:${color}"` : '';
  return `<span class="forum-author"${style}>${forumEscape(name || 'Someone')}</span>`;
}

function forumBadgesHtml(topic) {
  const badges = [];
  if (topic.pinnedAt) badges.push(['pinned', FORUM_BADGES.pinned]);
  if (topic.lockedAt) badges.push(['locked', FORUM_BADGES.locked]);
  if (topic.archivedAt) badges.push(['archived', FORUM_BADGES.archived]);
  return badges.map(([kind, label]) => `<span class="forum-badge forum-badge-${kind}">${label}</span>`).join('');
}

// Rename (when allowed), then pin, lock, archive (each sets the opposite of what the topic is now) and delete.
function forumModerationHtml(topic, { moderate = true, rename = true } = {}) {
  const id = Number(topic.id);
  const button = (name, set, label) => `<button type="button" class="btn forum-action" data-topic-${name}="${id}" data-set="${set}">${label}</button>`;
  const parts = [];
  if (rename) parts.push(`<button type="button" class="btn forum-action" data-topic-rename="${id}">Rename</button>`);
  if (moderate) {
    parts.push(
      button('pin', !topic.pinnedAt, topic.pinnedAt ? 'Unpin' : 'Pin'),
      button('lock', !topic.lockedAt, topic.lockedAt ? 'Unlock' : 'Lock'),
      button('archive', !topic.archivedAt, topic.archivedAt ? 'Unarchive' : 'Archive'),
      `<button type="button" class="btn danger forum-action" data-topic-delete="${id}">Delete</button>`
    );
  }
  return `<div class="forum-actions">${parts.join('')}</div>`;
}

// The Active / Archived toggle above the list.
function forumTabsHtml({ archived = false } = {}) {
  const tab = (name, label, pressed) => `<button type="button" class="forum-tab${pressed ? ' active' : ''}" data-forum-tab="${name}" aria-pressed="${pressed}">${label}</button>`;
  return `${tab('active', 'Active', !archived)}${tab('archived', 'Archived', archived)}`;
}

function forumReplyText(count) {
  const n = Number(count) || 0;
  if (!n) return 'No replies yet';
  return `${n} ${n === 1 ? 'reply' : 'replies'}`;
}

// The topics of one forum, pinned ones first (the server already orders them; this keeps the guarantee local).
function forumTopicListHtml(topics, { canModerate = false, archived = false } = {}) {
  const list = Array.isArray(topics) ? topics : [];
  if (!list.length) {
    return `<div class="forum-empty">${archived ? 'No archived topics.' : 'No topics yet. Start the first one with “New topic”.'}</div>`;
  }
  const pinned = list.filter((t) => t.pinnedAt);
  const others = list.filter((t) => !t.pinnedAt);
  const row = (topic) => `<div class="forum-topic${topic.pinnedAt ? ' pinned' : ''}" data-topic-id="${Number(topic.id)}">
    <button type="button" class="forum-topic-main" data-topic-open="${Number(topic.id)}">
      <span class="forum-topic-title">${forumEscape(topic.title)}</span>${forumBadgesHtml(topic)}
      <span class="forum-topic-meta">${forumAuthorHtml(topic.authorUsername, topic.authorColor)} · ${forumReplyText(topic.replyCount)}${topic.lastActivityText ? ` · ${forumEscape(topic.lastActivityText)}` : ''}</span>
    </button>${canModerate ? forumModerationHtml(topic) : ''}
  </div>`;
  // pinned topics stay on top in their own labelled group (a pinned topic works as that forum's announcement)
  if (!pinned.length) return others.map(row).join('');
  const label = (text) => `<div class="forum-group-label">${text}</div>`;
  return label('Pinned') + pinned.map(row).join('') + (others.length ? label('Topics') + others.map(row).join('') : '');
}

// The bar above an open topic: the way back, the title, moderator controls, and a notice when replies are off.
function forumTopicHeaderHtml(topic, { canModerate = false, canRename = false } = {}) {
  const notice = topic.archivedAt
    ? '<div class="forum-notice" role="status">This topic is archived. It is read-only.</div>'
    : (topic.lockedAt ? '<div class="forum-notice" role="status">This topic is locked. Replies are turned off.</div>' : '');
  return `<div class="forum-topic-header" data-topic-id="${Number(topic.id)}">
    <button type="button" class="btn" data-topic-back>&larr; All topics</button>
    <div class="forum-topic-heading"><h2>${forumEscape(topic.title)}</h2>${forumBadgesHtml(topic)}<span class="forum-topic-by">by ${forumAuthorHtml(topic.authorUsername, topic.authorColor)}</span></div>
    ${canModerate || canRename ? forumModerationHtml(topic, { moderate: canModerate, rename: true }) : ''}
  </div>${notice}`;
}

// "5 min ago" style text for a timestamp; `now` is a parameter so tests need no clock.
function forumRelativeTime(iso, now = Date.now()) {
  const then = Date.parse(iso);
  if (!iso || Number.isNaN(then)) return '';
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
  if (seconds < 30 * 86400) return `${Math.floor(seconds / 86400)} d ago`;
  return new Date(then).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { forumIconHtml, forumTopicListHtml, forumTopicHeaderHtml, forumTabsHtml, forumRelativeTime, FORUM_BADGES };
}
