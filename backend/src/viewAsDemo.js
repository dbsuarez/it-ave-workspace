// IT Avenue Workspace - View as with SAMPLE content, used once the workspace is Live.
//
// An Owner looking through someone's eyes sees their real structure (their channels, tabs, people, what is allowed) but never
// real content: every message, thread, pin, reaction, canvas and list that would come back from the database is replaced by a
// fixed, obviously made-up sample. A channel the person cannot open is still refused, so what they cannot see stays unseen.
// Fixed content (no randomness) so the same screen always looks the same. Pure builders are covered by test/view-as-demo.test.js.
const { ensureChannelMembership } = require('./security');
const { eachDay, weekdayOf, evaluateDay, totalsFor } = require('./attendance');

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

// ---- the person's private screens, as samples ----
const iso = (now, minutesAgo) => new Date(now.getTime() - minutesAgo * 60000).toISOString();

function sampleDirectMessages(viewedUserId, otherUserId, now = new Date()) {
  const lines = ['Hi! This is a sample direct message.', 'Direct messages are made up in View as, so nobody\'s private chat is shown.',
    'Sample reply: thanks, that makes sense.', 'Another sample message to show how a conversation looks.'];
  return lines.map((content, index) => ({
    id: -(index + 1), senderId: index % 2 ? viewedUserId : otherUserId, receiverId: index % 2 ? otherUserId : viewedUserId,
    content, createdAt: iso(now, (lines.length - index) * 25), senderUsername: index % 2 ? 'You (sample)' : 'Sample Person A',
    senderAvatarColor: index % 2 ? '#6B21A8' : '#0F766E', attachments: [],
  }));
}

function sampleConversation(now = new Date()) {
  return { id: -1, name: 'Sample group', createdBy: -1, createdAt: iso(now, 600), unreadCount: 0,
    members: SAMPLE_PEOPLE.map((p) => ({ id: p.id, username: p.username, avatarColor: p.avatarColor, status: 'online' })) };
}

function sampleConversationMessages(now = new Date()) {
  return sampleMessages(0, 'sample group', now).slice(0, 5).map((m, index) => ({
    id: m.id, conversationId: -1, senderId: m.userId, senderUsername: m.username, senderAvatarColor: m.avatarColor,
    content: m.content, createdAt: iso(now, (5 - index) * 30), attachments: [],
  }));
}

const sampleNotes = (now = new Date()) => [
  { id: -1, title: 'Sample note', content: 'This note is a sample. Real notes are not shown in View as.', createdAt: iso(now, 4000), updatedAt: iso(now, 3000) },
  { id: -2, title: 'Another sample note', content: '- a sample point\n- another sample point', createdAt: iso(now, 2000), updatedAt: iso(now, 1500) },
];

function sampleSaved(channel, now = new Date()) {
  return [
    { id: -1, type: 'message', savedAt: iso(now, 120), messageId: -1, channelId: channel.id, channelName: channel.name, username: 'Sample Person A',
      avatarColor: '#6B21A8', userId: -1, content: 'A sample saved message.', createdAt: iso(now, 300) },
    { id: -2, type: 'file', savedAt: iso(now, 200), fileId: -1, name: 'Sample file.pdf', size: 123456, mimeType: 'application/pdf', messageId: -2,
      channelId: channel.id, channelName: channel.name, username: 'Sample Person B', userId: -2 },
  ];
}

function sampleFiles(channel, now = new Date()) {
  return [['Sample report.pdf', 'application/pdf', 245760], ['Sample notes.txt', 'text/plain', 2048], ['Sample spreadsheet.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 18432]]
    .map(([name, mimeType, size], index) => ({ id: -(index + 1), uploadedBy: -1, name, size, mimeType, uploadedAt: iso(now, 90 * (index + 1)),
      uploaderUsername: 'Sample Person A', channelName: channel.name, channelId: channel.id, messageContent: 'A sample file message.' }));
}

function sampleActivity(channel, now = new Date()) {
  return { seenAt: null, unseenCount: 0, items: [
    { type: 'mention', messageId: -1, channelId: channel.id, channelName: channel.name, actorId: -1, actorUsername: 'Sample Person A', actorAvatarColor: '#6B21A8',
      preview: 'A sample mention.', emoji: null, createdAt: iso(now, 40), unseen: false },
    { type: 'reply', messageId: -2, channelId: channel.id, channelName: channel.name, actorId: -2, actorUsername: 'Sample Person B', actorAvatarColor: '#0F766E',
      preview: 'A sample reply.', emoji: null, createdAt: iso(now, 90), unseen: false },
  ] };
}

// ---- leave and attendance samples ----
const SAMPLE_TYPES = [
  { id: -1, name: 'Vacation leave (sample)', daysPerYear: 15, paid: true, active: true },
  { id: -2, name: 'Sick leave (sample)', daysPerYear: 10, paid: true, active: true },
  { id: -3, name: 'Unpaid leave (sample)', daysPerYear: 0, paid: false, active: true },
];

function sampleLeave(year, now = new Date()) {
  const balances = [
    { typeId: -1, name: SAMPLE_TYPES[0].name, paid: true, capped: true, entitled: 15, adjustment: 0, used: 3, pending: 1, remaining: 11 },
    { typeId: -2, name: SAMPLE_TYPES[1].name, paid: true, capped: true, entitled: 10, adjustment: 0, used: 1, pending: 0, remaining: 9 },
    { typeId: -3, name: SAMPLE_TYPES[2].name, paid: false, capped: false, entitled: 0, adjustment: 0, used: 0, pending: 0, remaining: null },
  ];
  const request = (id, type, start, end, days, status, reason) => ({
    id, userId: -1, username: 'Sample Person A', employeeNo: '', department: 'Sample department', firstName: 'Sample', middleName: '', lastName: 'Person',
    typeId: type.id, typeName: type.name, startDate: start, endDate: end, days, halfDay: false, reason, status,
    decidedBy: status === 'approved' ? 'Sample Manager' : null, decidedAt: status === 'approved' ? iso(now, 5000) : null, decisionNote: '', createdAt: iso(now, 9000),
  });
  return {
    year, balances,
    requests: [
      request(-1, SAMPLE_TYPES[0], `${year}-03-10`, `${year}-03-12`, 3, 'approved', 'Sample reason'),
      request(-2, SAMPLE_TYPES[0], `${year}-12-22`, `${year}-12-22`, 1, 'pending', 'Another sample reason'),
    ],
    holidays: [{ day: `${year}-12-25`, name: 'Sample holiday' }, { day: `${year}-01-01`, name: 'Sample new year' }],
    approvalsWaiting: 0, canManage: false, hasManager: true,
  };
}

// A month of sample attendance for one person, worked out by the real rules (evaluateDay) from made-up punches: 08:00-17:00,
// one late morning, one leave day, nothing on weekends or in the future.
function sampleTimesheet(viewedUserId, from, to, today) {
  const dates = eachDay(from, to);
  const monday = dates.find((d) => new Date(`${d}T00:00:00Z`).getUTCDay() === 1);
  const workDays = [...new Set(dates.filter((d) => { const w = new Date(`${d}T00:00:00Z`).getUTCDay(); return w >= 1 && w <= 5; }).map((d) => weekdayOf(d)))];
  const days = dates.map((date, index) => {
    const workday = workDays.includes(weekdayOf(date));
    const lateDay = monday && index === dates.indexOf(monday) + 8;
    const leaveDay = monday && index === dates.indexOf(monday) + 17;
    const past = date < today;
    const punch = workday && past && !leaveDay
      ? { clockIn: new Date(`${date}T${lateDay ? '08:25' : '08:00'}:00Z`), clockOut: new Date(`${date}T17:00:00Z`) } : null;
    const evaluated = evaluateDay({
      date, today, isHoliday: false, leave: leaveDay ? 1 : 0, overtimeEligible: true, punches: punch ? [punch] : [],
      schedule: { workDays, breakMinutes: 60, graceMinutes: 5, overtimeMinMinutes: 30, start: new Date(`${date}T08:00:00Z`), end: new Date(`${date}T17:00:00Z`) },
    });
    const text = punch ? [{ in: lateDay ? '08:25' : '08:00', out: '17:00', flagged: false }] : [];
    return { ...evaluated, punches: text, deviceFlag: false, clockIn: text.length ? text[0].in : null, clockOut: text.length ? text[0].out : null, note: '', source: text.length ? 'self' : null };
  });
  return {
    from, to, timezone: 'Asia/Manila',
    person: { id: viewedUserId, username: 'Sample Person', firstName: 'Sample', middleName: '', lastName: 'Person', employeeNo: '', department: 'Sample department', jobLevel: 'rank_and_file' },
    schedule: { id: -1, name: 'Sample schedule', start: '08:00', end: '17:00', breakMinutes: 60, graceMinutes: 5, workDays },
    days, totals: totalsFor(days),
  };
}

function sampleToday(viewedUserId, today) {
  const sheet = sampleTimesheet(viewedUserId, today, today, '9999-12-31');
  return {
    today, timezone: 'Asia/Manila', schedule: sheet.schedule, day: sheet.days[0], clockedIn: false, openSince: null,
    network: { enforced: false, exempt: true, allowed: true, ip: 'sample' }, isManager: false, correctionsWaiting: 0,
  };
}

// The first channel the person is really in (so a sample item can point somewhere that opens); a stand-in when they have none.
async function firstChannel(query, userId) {
  const row = (await query(
    'SELECT c.id, c.name FROM channel_members cm JOIN channels c ON c.id = cm.channel_id WHERE cm.user_id = $1 ORDER BY c.name LIMIT 1', [userId]
  )).rows[0];
  return row || { id: 0, name: 'general' };
}

const PRIVATE_SAMPLES = [
  [/^\/api\/conversations$/, async () => ({ conversations: [sampleConversation()] })],
  [/^\/api\/conversations\/-?\d+\/messages$/, async () => ({ messages: sampleConversationMessages() })],
  [/^\/api\/users\/(\d+)\/direct-messages$/, async (ctx, match) => ({ messages: sampleDirectMessages(ctx.userId, Number(match[1])) })],
  [/^\/api\/notes$/, async () => ({ notes: sampleNotes() })],
  [/^\/api\/saved$/, async (ctx) => ({ items: sampleSaved(await firstChannel(ctx.query, ctx.userId)) })],
  [/^\/api\/reminders$/, async () => ({ reminders: [] })],
  [/^\/api\/activity$/, async (ctx) => sampleActivity(await firstChannel(ctx.query, ctx.userId))],
  [/^\/api\/files$/, async (ctx) => ({ files: sampleFiles(await firstChannel(ctx.query, ctx.userId)) })],
  [/^\/api\/leave\/types$/, async () => ({ types: SAMPLE_TYPES })],
  [/^\/api\/leave\/me$/, async (ctx) => sampleLeave(ctx.params.get('year') ? Number(ctx.params.get('year')) : new Date().getUTCFullYear())],
  [/^\/api\/leave\/holidays$/, async () => ({ year: new Date().getUTCFullYear(), holidays: sampleLeave(new Date().getUTCFullYear()).holidays })],
  [/^\/api\/leave\/(approvals)$/, async () => ({ requests: [] })],
  [/^\/api\/leave\/calendar$/, async (ctx) => ({ month: ctx.params.get('month') || new Date().toISOString().slice(0, 7), scope: 'team', requests: [], holidays: [] })],
  [/^\/api\/attendance\/today$/, async (ctx) => sampleToday(ctx.userId, new Date().toISOString().slice(0, 10))],
  [/^\/api\/attendance\/timesheet$/, async (ctx) => {
    const today = new Date().toISOString().slice(0, 10);
    const month = /^\d{4}-\d{2}$/.test(ctx.params.get('month') || '') ? ctx.params.get('month') : today.slice(0, 7);
    const last = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
    return sampleTimesheet(ctx.userId, `${month}-01`, `${month}-${String(last).padStart(2, '0')}`, today);
  }],
  [/^\/api\/attendance\/corrections\/mine$/, async () => ({ corrections: [] })],
];

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
  for (const [pattern, build] of PRIVATE_SAMPLES) {
    const match = pattern.exec(clean);
    if (match) return { status: 200, body: await build({ userId, query, params: new URL(String(path), 'http://x').searchParams }, match) };
  }
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

module.exports = {
  SAMPLE_PEOPLE, sampleMessages, sampleCanvas, sampleDirectMessages, sampleConversation, sampleNotes, sampleSaved, sampleFiles, sampleActivity, sampleLeave, sampleTimesheet, sampleToday, demoResponse,
};
