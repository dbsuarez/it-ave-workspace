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

function forumBadgesHtml(topic) {
  const badges = [];
  if (topic.pinnedAt) badges.push(['pinned', FORUM_BADGES.pinned]);
  if (topic.lockedAt) badges.push(['locked', FORUM_BADGES.locked]);
  if (topic.archivedAt) badges.push(['archived', FORUM_BADGES.archived]);
  return badges.map(([kind, label]) => `<span class="forum-badge forum-badge-${kind}">${label}</span>`).join('');
}

// Pin, lock, archive (each sets the opposite of what the topic is now) and delete.
function forumModerationHtml(topic) {
  const id = Number(topic.id);
  const button = (name, set, label) => `<button type="button" class="btn forum-action" data-topic-${name}="${id}" data-set="${set}">${label}</button>`;
  return `<div class="forum-actions">${[
    button('pin', !topic.pinnedAt, topic.pinnedAt ? 'Unpin' : 'Pin'),
    button('lock', !topic.lockedAt, topic.lockedAt ? 'Unlock' : 'Lock'),
    button('archive', !topic.archivedAt, topic.archivedAt ? 'Restore' : 'Archive'),
  ].join('')}<button type="button" class="btn danger forum-action" data-topic-delete="${id}">Delete</button></div>`;
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
  const ordered = [...list.filter((t) => t.pinnedAt), ...list.filter((t) => !t.pinnedAt)];
  return ordered.map((topic) => `<div class="forum-topic${topic.pinnedAt ? ' pinned' : ''}" data-topic-id="${Number(topic.id)}">
    <button type="button" class="forum-topic-main" data-topic-open="${Number(topic.id)}">
      <span class="forum-topic-title">${forumEscape(topic.title)}</span>${forumBadgesHtml(topic)}
      <span class="forum-topic-meta">${forumEscape(topic.authorUsername || 'Someone')} · ${forumReplyText(topic.replyCount)}${topic.lastActivityText ? ` · ${forumEscape(topic.lastActivityText)}` : ''}</span>
    </button>${canModerate ? forumModerationHtml(topic) : ''}
  </div>`).join('');
}

// The bar above an open topic: the way back, the title, moderator controls, and a notice when replies are off.
function forumTopicHeaderHtml(topic, { canModerate = false } = {}) {
  const notice = topic.archivedAt
    ? '<div class="forum-notice" role="status">This topic is archived. It is read-only.</div>'
    : (topic.lockedAt ? '<div class="forum-notice" role="status">This topic is locked. Replies are turned off.</div>' : '');
  return `<div class="forum-topic-header" data-topic-id="${Number(topic.id)}">
    <button type="button" class="btn" data-topic-back>&larr; All topics</button>
    <div class="forum-topic-heading"><h2>${forumEscape(topic.title)}</h2>${forumBadgesHtml(topic)}</div>
    ${canModerate ? forumModerationHtml(topic) : ''}
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
  module.exports = { forumTopicListHtml, forumTopicHeaderHtml, forumRelativeTime, FORUM_BADGES };
}
