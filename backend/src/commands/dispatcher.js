const crypto = require('crypto');
const { query } = require('../db');
const { ensureChannelMembership } = require('../security');
const { parseCommand } = require('./parser');
const { byName, definitions, publicDefinition } = require('./registry');

async function commandContext(userId, channelId) {
  const id = Number(channelId);
  if (!Number.isSafeInteger(id) || id <= 0) throw Object.assign(new Error('A valid channel is required'), { status: 400 });
  await ensureChannelMembership(query, userId, id);
  const result = await query(
    `SELECT c.id, c.command_scope, u.account_type
     FROM channels c CROSS JOIN users u
     WHERE c.id = $1 AND u.id = $2 AND u.deactivated_at IS NULL`,
    [id, userId]
  );
  const row = result.rows[0];
  if (!row) throw Object.assign(new Error('Account or channel not found'), { status: 404 });
  if (row.account_type !== 'member') throw Object.assign(new Error('HR self-service commands are for workspace members'), { status: 403 });
  return { userId, channelId: id, channelScope: row.command_scope };
}

function allowed(definition, context) {
  return definition.enabled && definition.scopes.some((entry) => entry.type === 'channel-scope' && entry.value === context.channelScope);
}

async function listCommands({ userId, channelId }) {
  const context = await commandContext(userId, channelId);
  return definitions.filter((definition) => allowed(definition, context)).map(publicDefinition);
}

async function dispatch({ userId, channelId, input, requestId }) {
  const context = await commandContext(userId, channelId);
  const parsed = parseCommand(input);
  const definition = byName.get(parsed.name);
  if (!definition || !allowed(definition, context)) {
    throw Object.assign(new Error('That command is not available here. Try /hr-help.'), { status: 404, code: 'COMMAND_NOT_AVAILABLE' });
  }
  const safeRequestId = typeof requestId === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(requestId)
    ? requestId : crypto.randomUUID();
  try {
    const response = await definition.handler(context, parsed.args);
    await query(
      `INSERT INTO command_audit_log (actor_id, channel_id, command_name, request_id, outcome)
       VALUES ($1, $2, $3, $4, 'success')`,
      [userId, channelId, definition.name, safeRequestId]
    );
    return { requestId: safeRequestId, ...response };
  } catch (error) {
    await query(
      `INSERT INTO command_audit_log (actor_id, channel_id, command_name, request_id, outcome)
       VALUES ($1, $2, $3, $4, 'error')`,
      [userId, channelId, definition.name, safeRequestId]
    ).catch(() => {});
    throw error;
  }
}

module.exports = { dispatch, listCommands };
