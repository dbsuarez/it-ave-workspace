const { positiveId, normalizeExpiration } = require('./channelAccessPhase2');

function idList(values) {
  if (!Array.isArray(values) || values.length > 200) throw Object.assign(new Error('Expected up to 200 department IDs'), { status: 400 });
  const normalized = values.map(positiveId);
  if (normalized.some(id => !id) || new Set(normalized).size !== normalized.length) {
    throw Object.assign(new Error('Department IDs must be positive and unique'), { status: 400 });
  }
  return normalized;
}
function membershipInput(body) {
  const departmentIds = idList(body?.departmentIds);
  const primary = body?.primaryDepartmentId == null ? null : positiveId(body.primaryDepartmentId);
  if (primary !== null && !departmentIds.includes(primary)) throw Object.assign(new Error('Primary department must be in department list'), { status: 400 });
  if (departmentIds.length && primary === null) throw Object.assign(new Error('Primary department required'), { status: 400 });
  if (!departmentIds.length && primary !== null) throw Object.assign(new Error('Primary department must be empty when no departments assigned'), { status: 400 });
  return { departmentIds, primary };
}
function inviteInput(body) {
  const userId = positiveId(body?.userId);
  if (!userId) throw Object.assign(new Error('Valid user ID required'), { status: 400 });
  let expiresAt;
  try { expiresAt = normalizeExpiration(body?.expiresAt); }
  catch (err) { throw Object.assign(new Error(err.message), { status: 400 }); }
  return { userId, expiresAt };
}
function banInput(body) {
  const userId = positiveId(body?.userId);
  const reason = typeof body?.reason === 'string' ? body.reason.trim() : '';
  if (!userId || !reason || reason.length > 500) throw Object.assign(new Error('Valid user and ban reason (1–500 characters) required'), { status: 400 });
  return { userId, reason };
}
module.exports = { idList, membershipInput, inviteInput, banInput };
