// Polls: created by /poll, voted on over HTTP (routes/polls.js), shown as a card on a message with kind 'poll'.
//
// Privacy rules enforced here: an anonymous poll never returns who voted (no `voters`, no user ids) from any function;
// named polls list voter usernames to channel members. Votes are replaced inside one transaction holding a row lock on
// the poll, so simultaneous requests from one person can never leave two votes in a single-choice poll.
const { pool } = require('./db');
const { ensureCanPostToChannel, ensureChannelMembership, ensureChannelNotArchived } = require('./security');
const { ensureNotGuest } = require('./guests');
const { broadcastChannelMessage, loadSender } = require('./messageDelivery');

const MAX_QUESTION = 200;
const MAX_OPTION = 100;
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 10;
const MAX_CLOSE_MS = 30 * 24 * 60 * 60 * 1000;
const fail = (status, message) => Object.assign(new Error(message), { status });

// "30m", "2h", "3d" -> milliseconds (at least 1 minute, at most 30 days)
function parseDuration(text) {
  const match = /^(\d{1,4})([mhd])$/.exec(String(text || ''));
  const unit = { m: 60 * 1000, h: 60 * 60 * 1000, d: 24 * 60 * 60 * 1000 };
  const ms = match ? Number(match[1]) * unit[match[2]] : 0;
  if (!ms || ms > MAX_CLOSE_MS) throw fail(400, '--closes needs a time like 30m, 2h or 3d (at most 30d)');
  return ms;
}

function validateNewPoll({ question, options }) {
  const text = typeof question === 'string' ? question.trim() : '';
  if (!text) throw fail(400, 'Write the question in quotes, then the options: /poll "Lunch?" "Pizza" "Sushi"');
  if (text.length > MAX_QUESTION) throw fail(400, `The question can be at most ${MAX_QUESTION} characters`);
  if (!Array.isArray(options) || options.length < MIN_OPTIONS || options.length > MAX_OPTIONS) {
    throw fail(400, `A poll needs ${MIN_OPTIONS} to ${MAX_OPTIONS} options, each in quotes`);
  }
  const labels = options.map((option) => String(option).trim());
  if (labels.some((label) => !label || label.length > MAX_OPTION)) throw fail(400, `Each option must be 1 to ${MAX_OPTION} characters`);
  return { question: text, options: labels };
}

// A poll whose closing time has passed is marked closed the next time anyone reads or votes on it (no scheduler).
async function closeIfExpired(query, pollId) {
  await query('UPDATE polls SET closed_at = closes_at WHERE id = $1 AND closed_at IS NULL AND closes_at IS NOT NULL AND closes_at <= NOW()', [pollId]);
}

async function loadPoll(query, pollId) {
  const row = (await query('SELECT id, channel_id, message_id, created_by, question, multiple, anonymous, closes_at, closed_at FROM polls WHERE id = $1', [pollId])).rows[0];
  if (!row) throw fail(404, 'Poll not found');
  return row;
}

// Serializes many polls for one viewer with a fixed number of queries (not a handful per poll).
// -> Map(pollId -> { id, messageId, channelId, question, multiple, anonymous, closesAt, closed,
//                    options: [{ id, label, count, voters? }], myOptionIds, totalVoters }). `voters` only for named polls.
async function serializePolls(query, pollIds, viewerId) {
  const found = new Map();
  if (!pollIds.length) return found;
  await query(
    'UPDATE polls SET closed_at = closes_at WHERE id = ANY($1::bigint[]) AND closed_at IS NULL AND closes_at IS NOT NULL AND closes_at <= NOW()', [pollIds]);
  const rows = (await query(
    'SELECT id, channel_id, message_id, question, multiple, anonymous, closes_at, closed_at FROM polls WHERE id = ANY($1::bigint[])', [pollIds])).rows;
  const options = (await query(
    `SELECT o.poll_id, o.id, o.label, COUNT(v.user_id)::int AS count
     FROM poll_options o LEFT JOIN poll_votes v ON v.option_id = o.id
     WHERE o.poll_id = ANY($1::bigint[]) GROUP BY o.id ORDER BY o.poll_id, o.position`, [pollIds])).rows;
  const mine = (await query('SELECT poll_id, option_id FROM poll_votes WHERE poll_id = ANY($1::bigint[]) AND user_id = $2', [pollIds, viewerId])).rows;
  const totals = (await query('SELECT poll_id, COUNT(DISTINCT user_id)::int AS n FROM poll_votes WHERE poll_id = ANY($1::bigint[]) GROUP BY poll_id', [pollIds])).rows;
  const namedIds = rows.filter((row) => !row.anonymous).map((row) => row.id);
  const voters = namedIds.length ? (await query(
    `SELECT v.poll_id, v.option_id, u.username FROM poll_votes v JOIN users u ON u.id = v.user_id
     WHERE v.poll_id = ANY($1::bigint[]) ORDER BY u.username`, [namedIds])).rows : [];
  const votersOf = new Map();
  for (const row of voters) {
    const key = `${row.poll_id}:${row.option_id}`;
    if (!votersOf.has(key)) votersOf.set(key, []);
    votersOf.get(key).push(row.username);
  }
  for (const poll of rows) {
    found.set(Number(poll.id), {
      id: Number(poll.id), messageId: poll.message_id, channelId: poll.channel_id, question: poll.question,
      multiple: poll.multiple, anonymous: poll.anonymous, closesAt: poll.closes_at, closed: Boolean(poll.closed_at),
      options: options.filter((option) => String(option.poll_id) === String(poll.id)).map((option) => ({
        id: Number(option.id), label: option.label, count: option.count,
        ...(poll.anonymous ? {} : { voters: votersOf.get(`${poll.id}:${option.id}`) || [] }),
      })),
      myOptionIds: mine.filter((vote) => String(vote.poll_id) === String(poll.id)).map((vote) => Number(vote.option_id)).sort((a, b) => a - b),
      totalVoters: (totals.find((row) => String(row.poll_id) === String(poll.id)) || { n: 0 }).n,
    });
  }
  return found;
}

async function serializePoll(query, pollId, viewerId) {
  const poll = (await serializePolls(query, [pollId], viewerId)).get(Number(pollId));
  if (!poll) throw fail(404, 'Poll not found');
  return poll;
}

// Map of messageId -> serialized poll for the poll messages among `messageIds`.
async function pollsForMessages(query, messageIds, viewerId) {
  const byMessage = new Map();
  if (!messageIds.length) return byMessage;
  const rows = (await query('SELECT id, message_id FROM polls WHERE message_id = ANY($1::int[])', [messageIds])).rows;
  const serialized = await serializePolls(query, rows.map((row) => row.id), viewerId);
  for (const row of rows) if (serialized.has(Number(row.id))) byMessage.set(row.message_id, serialized.get(Number(row.id)));
  return byMessage;
}

// Posts the poll message and creates the poll in one transaction, then broadcasts it like any other message.
async function createPoll(io, query, { userId, channelId, question, options, multiple = false, anonymous = false, closesAt = null }) {
  const valid = validateNewPoll({ question, options });
  await ensureCanPostToChannel(query, userId, channelId);
  await require('./forums').ensureNotForum(query, channelId);
  const sender = await loadSender(query, userId);
  const client = await pool.connect();
  let message;
  let pollId;
  try {
    await client.query('BEGIN');
    message = (await client.query(
      `INSERT INTO messages (channel_id, user_id, content, kind) VALUES ($1, $2, $3, 'poll')
       RETURNING id, channel_id, user_id, content, reply_to, created_at, kind`,
      [channelId, userId, valid.question])).rows[0];
    pollId = (await client.query(
      `INSERT INTO polls (channel_id, message_id, created_by, question, multiple, anonymous, closes_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [channelId, message.id, userId, valid.question, Boolean(multiple), Boolean(anonymous), closesAt])).rows[0].id;
    for (let index = 0; index < valid.options.length; index += 1) {
      await client.query('INSERT INTO poll_options (poll_id, position, label) VALUES ($1, $2, $3)', [pollId, index + 1, valid.options[index]]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  const poll = await serializePoll(query, pollId, userId);
  return broadcastChannelMessage(io, query, message, sender, { poll });
}

// Everything that must hold for someone to vote or withdraw, checked fresh each time.
async function authorizeVoter(query, userId, poll) {
  await ensureChannelMembership(query, userId, poll.channel_id);
  await ensureNotGuest(query, userId, 'Guests cannot vote in polls');
  await ensureChannelNotArchived(query, poll.channel_id);
}

function validateOptionIds(value, multiple) {
  const list = Array.isArray(value) ? value : null;
  if (!list || !list.every((id) => Number.isSafeInteger(id) && id > 0) || new Set(list).size !== list.length || list.length > MAX_OPTIONS) {
    throw fail(400, 'Choose from the options of this poll');
  }
  if (!list.length) throw fail(400, 'Choose at least one option');
  if (!multiple && list.length !== 1) throw fail(400, 'This poll takes exactly one option');
  return list;
}

// Replaces userId's votes with optionIds (or removes them when optionIds is null), under a row lock on the poll.
async function replaceVotes(userId, pollId, optionIds) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const poll = (await client.query(
      `SELECT id, multiple, (closed_at IS NOT NULL OR (closes_at IS NOT NULL AND closes_at <= NOW())) AS closed
       FROM polls WHERE id = $1 FOR UPDATE`, [pollId])).rows[0];
    if (!poll) throw fail(404, 'Poll not found');
    if (poll.closed) throw fail(409, 'This poll is closed');
    let chosen = [];
    if (optionIds !== null) {
      chosen = validateOptionIds(optionIds, poll.multiple);
      const known = (await client.query('SELECT id FROM poll_options WHERE poll_id = $1 AND id = ANY($2::bigint[])', [pollId, chosen])).rows;
      if (known.length !== chosen.length) throw fail(400, 'Choose from the options of this poll');
    }
    await client.query('DELETE FROM poll_votes WHERE poll_id = $1 AND user_id = $2', [pollId, userId]);
    for (const optionId of chosen) {
      await client.query('INSERT INTO poll_votes (poll_id, option_id, user_id) VALUES ($1, $2, $3)', [pollId, optionId, userId]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function closePoll(query, pollId) {
  await query('UPDATE polls SET closed_at = COALESCE(closed_at, NOW()) WHERE id = $1', [pollId]);
}

module.exports = {
  parseDuration, validateNewPoll, loadPoll, serializePoll, serializePolls, pollsForMessages, createPoll,
  authorizeVoter, replaceVotes, closePoll, closeIfExpired,
};
