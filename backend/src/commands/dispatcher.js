const crypto = require('crypto');
const { query } = require('../db');
const { ensureChannelMembership } = require('../security');
const { can, isPermission } = require('../permissions');
const { parseCommand, MAX_COMMAND_LENGTH } = require('./parser');
const { byName, definitions, publicDefinition } = require('./registry');

const HARD_MAX_LENGTH = 2000;
const CONFIRM_MINUTES = 5;
const inFlight = new Set(); // shared-command requests that are running right now
const fail = (status, message, code) => Object.assign(new Error(message), { status, code });
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

async function commandContext(userId, channelId, io) {
  const id = Number(channelId);
  if (!Number.isSafeInteger(id) || id <= 0) throw fail(400, 'A valid channel is required');
  await ensureChannelMembership(query, userId, id);
  const result = await query(
    `SELECT c.id, c.command_scope, c.is_personal, u.account_type
     FROM channels c CROSS JOIN users u
     WHERE c.id = $1 AND u.id = $2 AND u.deactivated_at IS NULL`,
    [id, userId]
  );
  const row = result.rows[0];
  if (!row) throw fail(404, 'Account or channel not found');
  const context = {
    userId, channelId: id, channelScope: row.command_scope, isPersonal: Boolean(row.is_personal),
    accountType: row.account_type, io, query,
  };
  context.available = () => availableDefinitions(context); // what /help may list: in scope and permitted right now
  return context;
}

function inScope(definition, context) {
  if (definition.excludeTags && definition.excludeTags.includes(context.channelScope)) return false; // e.g. /poll is not offered in #hr-inquiry
  return definition.enabled && definition.scopes.some((scope) => scope.type === 'global'
    || (scope.type === 'any-channel' && !context.isPersonal)
    || (scope.type === 'channel-scope' && scope.value === context.channelScope));
}

const lacksPermission = async (definition, context) => Boolean(definition.permission && isPermission(definition.permission)
  && !(await can(query, context.userId, definition.permission, { channelId: context.channelId })));

// Throws unless this person may run this command in this channel right now. Server-side and authoritative.
async function authorize(definition, context) {
  if (!definition || !inScope(definition, context)) {
    throw fail(404, 'That command is not available here. Try /help.', 'COMMAND_NOT_AVAILABLE');
  }
  if (context.accountType !== 'member' && !definition.allowGuests) throw fail(403, 'Commands are for workspace members');
  if (await lacksPermission(definition, context)) throw fail(403, 'You do not have permission to use that command', 'COMMAND_FORBIDDEN');
}

function nameOf(input) {
  if (typeof input === 'string') {
    const match = input.trim().match(/^\/(\S+)/);
    if (match) return match[1].toLowerCase();
  }
  parseCommand(input); // throws the right 400 for non-text, a missing slash, or an empty name
  throw fail(400, 'Choose a command');
}

function parseFor(definition, input) {
  const limit = definition.maxLength || MAX_COMMAND_LENGTH;
  return parseCommand(input, { maxLength: Math.min(limit, HARD_MAX_LENGTH), flagsFor: () => definition.options, rawText: Boolean(definition.rawText) });
}

async function availableDefinitions(context) {
  const visible = [];
  for (const definition of definitions) {
    if (!inScope(definition, context)) continue;
    if (context.accountType !== 'member' && !definition.allowGuests) continue;
    if (await lacksPermission(definition, context)) continue;
    visible.push(definition);
  }
  return visible;
}

async function listCommands({ userId, channelId }) {
  const context = await commandContext(userId, channelId);
  if (context.accountType !== 'member') throw fail(403, 'Commands are for workspace members');
  return (await availableDefinitions(context)).map(publicDefinition);
}

const safeId = (requestId) => (typeof requestId === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(requestId) ? requestId : crypto.randomUUID());

async function audit(userId, channelId, definition, requestId, outcome) {
  await query(
    `INSERT INTO command_audit_log (actor_id, channel_id, command_name, request_id, outcome) VALUES ($1, $2, $3, $4, $5)`,
    [userId, channelId, definition.name, requestId, outcome]
  );
}

async function runHandler(definition, context, parsed, requestId) {
  try {
    const response = await definition.handler(context, parsed.args, parsed.options, parsed.text);
    await audit(context.userId, context.channelId, definition, requestId, 'success');
    return { requestId, category: definition.category, ...response };
  } catch (error) {
    await audit(context.userId, context.channelId, definition, requestId, 'error').catch(() => {});
    throw error;
  }
}

async function dispatch({ userId, channelId, input, requestId, io }) {
  const context = await commandContext(userId, channelId, io);
  const definition = byName.get(nameOf(input));
  await authorize(definition, context);
  const parsed = parseFor(definition, input);
  const safeRequestId = safeId(requestId);
  if (definition.visibility === 'shared' && definition.confirm) {
    const preview = await definition.confirm.preview(context, parsed.args, parsed.options, parsed.text);
    const token = crypto.randomBytes(24).toString('base64url');
    await query('DELETE FROM command_pending WHERE expires_at < NOW()');
    await query(
      `INSERT INTO command_pending (token_hash, user_id, channel_id, input, expires_at)
       VALUES ($1, $2, $3, $4, NOW() + ($5 || ' minutes')::interval)`,
      [sha256(token), userId, context.channelId, input.trim(), String(CONFIRM_MINUTES)]
    );
    return {
      requestId: safeRequestId, category: definition.category, visibility: 'private', kind: 'confirm', title: preview.title,
      confirmLabel: preview.confirmLabel || 'Confirm', data: { message: preview.message }, token, actions: [],
    };
  }
  if (definition.visibility === 'shared' && typeof requestId === 'string' && requestId === safeRequestId) {
    // A retry of the same request (reconnect, double click) must not post twice. The in-flight set covers copies that
    // arrive while the first is still running (the audit row only exists once it has finished); this backend is one process.
    const key = `${userId}:${safeRequestId}:${definition.name}`;
    const alreadyDone = () => ({
      requestId: safeRequestId, category: definition.category, visibility: 'private', kind: 'card', title: 'Already done',
      data: { message: 'This command is already running or already ran, so it was not repeated.' }, actions: [],
    });
    if (inFlight.has(key)) return alreadyDone();
    inFlight.add(key);
    try {
      const done = await query(
        `SELECT 1 FROM command_audit_log WHERE actor_id = $1 AND request_id = $2 AND command_name = $3 AND outcome = 'success'`,
        [userId, safeRequestId, definition.name]
      );
      if (done.rows.length) return alreadyDone();
      return await runHandler(definition, context, parsed, safeRequestId);
    } finally {
      inFlight.delete(key);
    }
  }
  return runHandler(definition, context, parsed, safeRequestId);
}

// Runs a previewed shared command. The token is single use and bound to the person and channel; every check
// (membership, scope, permission, plus whatever the handler enforces such as archive, bans and timeouts) runs again now.
async function confirmPending({ userId, channelId, token, requestId, io }) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 200) {
    throw fail(400, 'This confirmation is not valid. Run the command again.', 'CONFIRM_INVALID');
  }
  const context = await commandContext(userId, channelId, io);
  const pending = await query(
    `DELETE FROM command_pending WHERE token_hash = $1 AND user_id = $2 AND channel_id = $3 AND expires_at > NOW() RETURNING input`,
    [sha256(token), userId, context.channelId]
  );
  if (!pending.rows.length) throw fail(400, 'This confirmation expired or was already used. Run the command again.', 'CONFIRM_INVALID');
  const input = pending.rows[0].input;
  const definition = byName.get(nameOf(input));
  await authorize(definition, context);
  return runHandler(definition, context, parseFor(definition, input), safeId(requestId));
}

module.exports = { dispatch, listCommands, confirmPending };
