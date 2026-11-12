// IT Avenue Workspace - "View as": an Owner opens the app as another person to see what their roles show them.
//
// The Owner gets a one-hour token for that person with a `viewAs` claim (the Owner's own id). Such a token is READ-ONLY and
// limited to what the roles decide (channels, channel messages, people, lists, channel canvases): anything that writes is
// refused, and so is everything private to the person (direct messages, notes, saved items, reminders, search, files
// they sent, their leave and attendance). The live socket accepts these tokens only as listen-only
// (sockets/chat.js): the person's channels update live, but nothing comes from their personal room and they are never
// shown online or acted as.
// as them. Rules here are pure (test/view-as.test.js); middleware/auth.js applies them.

const VIEW_AS_MINUTES = 60;

// Paths (without the query string) a View-as token may read.
const VIEW_AS_ALLOWED = [
  /^\/api\/auth\/me$/,
  /^\/api\/channels(\/\d+)?(\/(members|links))?$/,
  /^\/api\/channels\/my$/,
  /^\/api\/messages\/\d+$/,
  /^\/api\/messages\/\d+\/(pins|replies|reactions)$/,
  /^\/api\/messages\/\d+\/(context|threads)\/\d+$/,
  /^\/api\/users$/,
  /^\/api\/people(\/\d+)?$/,
  /^\/api\/user-groups$/,
  /^\/api\/roles\/mentionable$/,
  /^\/api\/moderation\/access$/,
  /^\/api\/canvas\/channel\/\d+$/,
  /^\/api\/lists(\/\d+)?$/,
];

// null when the request may go ahead, otherwise the message to refuse it with.
// `full` is the testing mode (while the workspace is still Pre-launch): everything the person can READ is shown, including
// their direct messages, notes and saved items, still strictly read-only. Once the workspace is Live it is off, and only
// the whitelist above applies, so employees' private messages are not open to anyone looking through their eyes.
function viewAsRefusal(method, path, { full = false } = {}) {
  if (!['GET', 'HEAD'].includes(String(method || '').toUpperCase())) return 'View as is read-only: nothing can be changed.';
  const clean = String(path || '').split('?')[0].replace(/\/+$/, '');
  if (full) return /^\/api\/(auth\/(?!me$)|roles\/view-as)/.test(clean) ? 'That is not available in View as.' : null;
  if (!VIEW_AS_ALLOWED.some((pattern) => pattern.test(clean))) return 'That is private to the person and is not shown in View as.';
  return null;
}

module.exports = { VIEW_AS_MINUTES, VIEW_AS_ALLOWED, viewAsRefusal };
