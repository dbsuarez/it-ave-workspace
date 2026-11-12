// IT Avenue Workspace - View as with SAMPLE content, used once the workspace is Live.
//
// An Owner looking through someone's eyes sees their real structure (their channels, tabs, people, what is allowed) but never
// real content: every message, thread, pin, reaction, canvas and list that would come back from the database is replaced by a
// fixed, obviously made-up sample. A channel the person cannot open is still refused, so what they cannot see stays unseen.
// Fixed content (no randomness) so the same screen always looks the same. Pure builders are covered by test/view-as-demo.test.js.
const { ensureChannelMembership } = require('./security');

const SAMPLE_PEOPLE = [
  { id: -1, username: 'Sample Person A', avatarColor: '#6B21A8' },
  { id: -2, username: 'Sample Person B', avatarColor: '#0F766E' },
  { id: -3, username: 'Sample Person C', avatarColor: '#B45309' },
];

const SAMPLE_LINES = [
  'This is a sample message. Real messages are not shown in View as.',
  'Everything in this conversation is made up, so nobody\'s private content is shown.',
  'You can still see which channels, tabs and buttons this person gets from their roles.',
  'Sample reply with a list:\n- first sample item\n- second sample item',
  'Sample message with **bold** and `code`, to see how text looks.',
  'Another sample message from a different person.',
];

// Eight sample messages for a channel, oldest first, dated just before `now`.
function sampleMessages(channelId, channelName, now = new Date()) {
  const base = now.getTime() - 8 * 3600 * 1000;
  return SAMPLE_LINES.concat([`Welcome to #${channelName} (sample).`, 'End of the sample conversation.']).map((content, index) => {
    const person = SAMPLE_PEOPLE[index % SAMPLE_PEOPLE.length];
    return {
      id: -(index + 1), channelId, userId: person.id, username: person.username, avatarColor: person.avatarColor, content,
      replyTo: null, replyToMessage: null, editedAt: null, createdAt: new Date(base + index * 20 * 60000).toISOString(),
      pinned: false, pinnedAt: null, pinnedBy: null, reactions: [], attachments: [],
    };
  });
}

function sampleCanvas(channelId, channelName, now = new Date()) {
  return {
    id: -channelId, kind: 'channel', channelId, dmUserLow: null, dmUserHigh: null, title: `#${channelName} canvas (sample)`,
    content: `# Sample canvas\n\nThis page is a sample. Real canvases are not shown in View as.\n\n- A sample point\n- Another sample point\n`,
    createdBy: null, createdAt: now.toISOString(), updatedAt: now.toISOString(), revision: 1, myRole: 'viewer',
  };
}

const ID = '(\\d+)';
const ROUTES = [
  [new RegExp(`^/api/messages/${ID}$`), 'messages'],
  [new RegExp(`^/api/messages/${ID}/pins$`), 'empty-messages'],
  [new RegExp(`^/api/messages/${ID}/(replies)$`), 'empty-replies'],
  [new RegExp(`^/api/messages/${ID}/reactions$`), 'empty-reactions'],
  [new RegExp(`^/api/messages/${ID}/(context|threads)/${ID}$`), 'empty-messages'],
  [new RegExp(`^/api/canvas/channel/${ID}$`), 'canvas'],
  [/^\/api\/lists$/, 'empty-lists'],
  [new RegExp(`^/api/lists/${ID}$`), 'refuse'],
];

// null when this path has no sample (the caller then applies the ordinary rules); otherwise { status, body }.
async function demoResponse(path, { userId, query }) {
  const clean = String(path || '').split('?')[0].replace(/\/+$/, '');
  for (const [pattern, kind] of ROUTES) {
    const match = pattern.exec(clean);
    if (!match) continue;
    if (kind === 'refuse') return { status: 403, body: { error: 'Not available in View as.' } };
    if (kind === 'empty-lists') return { status: 200, body: { lists: [], members: [] } };
    const channelId = Number(match[1]);
    if (kind === 'empty-replies') return { status: 200, body: { replies: [] } };
    if (kind === 'empty-reactions') return { status: 200, body: { messageId: channelId, channelId: null, reactions: [] } };
    if (kind === 'empty-messages') return { status: 200, body: { messages: [], message: null, replies: [], hasMore: false } };
    // messages and canvas are per channel: the person must really be able to open it
    try {
      await ensureChannelMembership(query, userId, channelId);
    } catch (err) {
      return { status: err.status || 403, body: { error: err.message || 'Access denied' } };
    }
    const channel = (await query('SELECT name FROM channels WHERE id = $1', [channelId])).rows[0];
    const name = channel ? channel.name : 'channel';
    if (kind === 'messages') return { status: 200, body: { messages: sampleMessages(channelId, name), hasMore: false } };
    return { status: 200, body: { canvas: sampleCanvas(channelId, name) } };
  }
  return null;
}

module.exports = { SAMPLE_PEOPLE, sampleMessages, sampleCanvas, demoResponse };
