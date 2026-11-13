const express = require('express');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const { query } = require('../db');
const { passwordProblem } = require('../authLimits');
const { hrActor, canManageEmployees, temporaryPassword, applyChecklist } = require('../hr');
const prelaunch = require('../prelaunch');
const { cleanEmployeeFields } = require('../accountFields');
const authenticateToken = require('../middleware/auth');
const {
  newInviteCode, hashInviteCode, invitationProblem, normalizeInviteCode,
} = require('../guests');
const { invitationLookups, clientAddress, rejectIfLimited } = require('../authLimits');
const { refreshConversation } = require('./conversations');

// Workspace administration for Superadmins: members and guests, invitations,
// and whether sign-up is open or invitation-only.
const router = express.Router();

const ACCOUNT_TYPES = ['member', 'guest'];
const REGISTRATION_MODES = ['open', 'invite'];
const MAX_EXPIRY_HOURS = 24 * 30;

function parseId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function fail(status, message) {
  return Object.assign(new Error(message), { status });
}

function sendError(res, err, label) {
  if (err.status) return res.status(err.status).json({ error: err.message });
  console.error(`${label}:`, err);
  return res.status(500).json({ error: 'Server error' });
}

async function requireSuperadmin(req) {
  const result = await query('SELECT is_superadmin FROM users WHERE id = $1', [req.user.userId]);
  if (!result.rows[0]?.is_superadmin) throw fail(403, 'Superadmin access required');
}

async function audit(actorId, action, targetUserId, details) {
  await query(
    `INSERT INTO moderation_audit_log (channel_id, actor_id, target_user_id, action, details)
     VALUES (NULL, $1, $2, $3, $4)`,
    [actorId, targetUserId, action, JSON.stringify(details || {})]
  );
}

// Public: lets the sign-up form show what an invitation code grants.
router.get('/invitations/lookup', async (req, res) => {
  try {
    const address = clientAddress(req);
    if (rejectIfLimited(res, invitationLookups.check(address))) return;
    invitationLookups.record(address);
    const code = normalizeInviteCode(req.query.code);
    if (!code) return res.status(400).json({ error: 'An invitation code is required' });
    const result = await query(
      'SELECT account_type, expires_at, revoked_at, used_at FROM invitations WHERE code_hash = $1',
      [hashInviteCode(code)]
    );
    const problem = invitationProblem(result.rows[0]);
    if (problem) return res.status(404).json({ error: problem });
    res.json({ accountType: result.rows[0].account_type, expiresAt: result.rows[0].expires_at });
  } catch (err) {
    sendError(res, err, 'Invitation lookup error');
  }
});

// Public: whether the sign-up form must ask for an invitation code.
router.get('/registration', async (req, res) => {
  try {
    const result = await query('SELECT registration_mode FROM moderation_settings WHERE id = 1');
    res.json({ mode: result.rows[0]?.registration_mode || 'open' });
  } catch (err) {
    sendError(res, err, 'Get registration mode error');
  }
});

router.use(authenticateToken);

router.put('/registration', async (req, res) => {
  try {
    await requireSuperadmin(req);
    const mode = req.body?.mode;
    if (!REGISTRATION_MODES.includes(mode)) throw fail(400, 'Mode must be open or invite');
    await query('UPDATE moderation_settings SET registration_mode = $1 WHERE id = 1', [mode]);
    await audit(req.user.userId, 'registration_mode_changed', null, { mode });
    res.json({ mode });
  } catch (err) {
    sendError(res, err, 'Set registration mode error');
  }
});

// ---- Members and guests ----
router.get('/users', async (req, res) => {
  try {
    await requireSuperadmin(req);
    const result = await query(
      `SELECT u.id, u.username, u.email, u.account_type, u.is_superadmin, u.is_hr, u.status, u.created_at,
              (SELECT COUNT(*)::int FROM channel_members cm WHERE cm.user_id = u.id) AS channel_count,
              (SELECT COUNT(*)::int FROM channel_members cm WHERE cm.user_id = u.id AND cm.role = 'moderator') AS moderator_count
       FROM users u
       WHERE u.account_type <> 'bot'
       ORDER BY LOWER(u.username)`
    );
    res.json({
      users: result.rows.map((row) => ({
        id: row.id,
        username: row.username,
        email: row.email,
        accountType: row.account_type,
        isSuperadmin: row.is_superadmin,
        isHr: row.is_hr,
        status: row.status,
        channelCount: row.channel_count,
        moderatorChannelCount: row.moderator_count,
        createdAt: row.created_at,
      })),
    });
  } catch (err) {
    sendError(res, err, 'List workspace users error');
  }
});

router.patch('/users/:userId', async (req, res) => {
  try {
    await requireSuperadmin(req);
    const userId = parseId(req.params.userId);
    if (!userId) throw fail(400, 'A valid user ID is required');
    const { accountType, isSuperadmin } = req.body || {};
    if (accountType === undefined && isSuperadmin === undefined) {
      throw fail(400, 'Nothing to change');
    }
    if (accountType !== undefined && !ACCOUNT_TYPES.includes(accountType)) {
      throw fail(400, 'Account type must be member or guest');
    }
    if (isSuperadmin !== undefined && typeof isSuperadmin !== 'boolean') {
      throw fail(400, 'isSuperadmin must be true or false');
    }
    if (userId === Number(req.user.userId)) {
      throw fail(400, 'You cannot change your own role; ask another Superadmin');
    }

    const current = await query(
      'SELECT account_type, is_superadmin FROM users WHERE id = $1',
      [userId]
    );
    if (!current.rows.length) throw fail(404, 'User not found');
    const nextType = accountType ?? current.rows[0].account_type;
    const nextSuperadmin = isSuperadmin ?? current.rows[0].is_superadmin;
    if (nextType === 'guest' && nextSuperadmin) {
      throw fail(400, 'A guest cannot be a Superadmin');
    }

    let leftConversations = [];
    if (nextType === 'guest' && current.rows[0].account_type !== 'guest') {
      // A guest holds no moderator roles and is not part of group messages.
      await query("UPDATE channel_members SET role = 'member' WHERE user_id = $1", [userId]);
      const left = await query(
        'DELETE FROM conversation_members WHERE user_id = $1 RETURNING conversation_id',
        [userId]
      );
      leftConversations = left.rows.map((row) => row.conversation_id);
    }
    const updated = await query(
      `UPDATE users SET account_type = $1, is_superadmin = $2 WHERE id = $3
       RETURNING id, username, account_type, is_superadmin`,
      [nextType, nextSuperadmin, userId]
    );
    await audit(req.user.userId, 'account_role_changed', userId, {
      accountType: nextType, isSuperadmin: nextSuperadmin,
    });
    req.io?.to(`user_${userId}`).emit('account_updated', {
      accountType: nextType, isSuperadmin: nextSuperadmin,
    });
    for (const conversationId of leftConversations) {
      req.io?.to(`user_${userId}`).emit('conversation_removed', { conversationId });
      await refreshConversation(req.io, conversationId);
    }
    const row = updated.rows[0];
    res.json({
      user: { id: row.id, username: row.username, accountType: row.account_type, isSuperadmin: row.is_superadmin },
    });
  } catch (err) {
    sendError(res, err, 'Update workspace user error');
  }
});

// ---- Invitations ----
function serializeInvitation(row) {
  const problem = invitationProblem(row);
  return {
    id: row.id,
    accountType: row.account_type,
    note: row.note,
    channelIds: row.channel_ids || [],
    createdBy: row.created_by_username || null,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    usedAt: row.used_at,
    usedBy: row.used_by_username || null,
    revokedAt: row.revoked_at,
    status: row.used_at ? 'used' : (row.revoked_at ? 'revoked' : (problem ? 'expired' : 'pending')),
  };
}

router.get('/invitations', async (req, res) => {
  try {
    await requireSuperadmin(req);
    const result = await query(
      `SELECT i.*, creator.username AS created_by_username, used.username AS used_by_username
       FROM invitations i
       LEFT JOIN users creator ON creator.id = i.created_by
       LEFT JOIN users used ON used.id = i.used_by
       ORDER BY i.created_at DESC
       LIMIT 200`
    );
    res.json({ invitations: result.rows.map(serializeInvitation) });
  } catch (err) {
    sendError(res, err, 'List invitations error');
  }
});

// ---- Creating accounts directly ----
const MAX_NEW_ACCOUNTS = 100;
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// POST /api/admin/users - create one or many accounts at once.
// { accounts: [{ username, email, password?, lastName?, firstName?, middleName? }], accountType, channelIds }
// A missing password is generated. Each person must replace it at their first sign-in.
// The passwords are returned once; only hashes are stored.
router.post('/users', async (req, res) => {
  try {
    const actor = await hrActor(req.user.userId);
    if (!canManageEmployees(actor)) throw fail(403, 'Only the Superadmin or HR can create accounts');
    const { accounts, accountType = 'member', channelIds = [] } = req.body || {};
    const sharedPassword = accountType === 'member' && await prelaunch.isEnabled(); // pre-launch: one known password, no forced change
    if (accountType === 'guest' && !actor.is_superadmin) throw fail(403, 'Only the Superadmin can create guest accounts');
    if (!ACCOUNT_TYPES.includes(accountType)) throw fail(400, 'Account type must be member or guest');
    if (!Array.isArray(accounts) || accounts.length === 0) throw fail(400, 'Give at least one account');
    if (accounts.length > MAX_NEW_ACCOUNTS) throw fail(400, `At most ${MAX_NEW_ACCOUNTS} accounts at a time`);
    if (!Array.isArray(channelIds) || channelIds.some((id) => !parseId(id))) throw fail(400, 'channelIds must be a list of channel IDs');
    const extraChannels = [...new Set(channelIds.map(Number))];
    if (accountType === 'guest' && extraChannels.length === 0) throw fail(400, 'Choose at least one channel for a guest');
    if (extraChannels.length) {
      const found = await query('SELECT id FROM channels WHERE id = ANY($1::int[])', [extraChannels]);
      if (found.rows.length !== extraChannels.length) throw fail(404, 'One or more channels were not found');
    }
    const publicChannels = accountType === 'member'
      ? (await query('SELECT id FROM channels WHERE is_private = false')).rows.map((row) => Number(row.id)) : [];
    const joinIds = [...new Set([...publicChannels, ...extraChannels])];

    const created = [];
    const skipped = [];
    const warnings = [];
    const createdDepartments = new Set();
    const managerLinks = []; // [{ userId, username, reportsTo }] resolved once everyone in the batch exists
    const seen = new Set();
    const seenNumbers = new Set();
    for (const entry of accounts) {
      const username = typeof entry?.username === 'string' ? entry.username.trim() : '';
      const email = typeof entry?.email === 'string' ? entry.email.trim() : '';
      const label = username || email || '(blank)';
      if (!username || username.length > 50 || /\s/.test(username)) { skipped.push({ username: label, reason: 'The username must be 1 to 50 characters with no spaces' }); continue; }
      if (!EMAIL_SHAPE.test(email) || email.length > 255) { skipped.push({ username, reason: 'The email address is not valid' }); continue; }
      const key = `${username.toLowerCase()}|${email.toLowerCase()}`;
      if (seen.has(username.toLowerCase()) || seen.has(email.toLowerCase())) { skipped.push({ username, reason: 'Listed twice' }); continue; }
      seen.add(username.toLowerCase()); seen.add(email.toLowerCase());
      let password = entry.password;
      if (password === undefined || password === null || password === '') password = sharedPassword ? prelaunch.PASSWORD : temporaryPassword();
      const problem = passwordProblem(password, username);
      if (problem) { skipped.push({ username, reason: problem }); continue; }
      const names = {};
      let nameProblem = null;
      for (const [field, label] of [['lastName', 'Last name'], ['firstName', 'First name'], ['middleName', 'Middle name']]) {
        const value = entry[field] === undefined || entry[field] === null ? '' : entry[field];
        if (typeof value !== 'string' || value.trim().length > 100) nameProblem = `${label} can be at most 100 characters`;
        names[field] = typeof value === 'string' ? value.trim() : '';
      }
      if (nameProblem) { skipped.push({ username, reason: nameProblem }); continue; }
      const extra = cleanEmployeeFields(entry);
      if (extra.problem) { skipped.push({ username, reason: extra.problem }); continue; }
      const fields = extra.fields;
      if (fields.employeeNo) {
        const numberKey = fields.employeeNo.toLowerCase();
        const numberTaken = seenNumbers.has(numberKey) || (await query('SELECT 1 FROM users WHERE LOWER(employee_no) = $1', [numberKey])).rows.length > 0;
        if (numberTaken) { skipped.push({ username, reason: `Employee number ${fields.employeeNo} is already used` }); continue; }
      }
      const exists = await query('SELECT 1 FROM users WHERE LOWER(username) = $1 OR LOWER(email) = $2', [username.toLowerCase(), email.toLowerCase()]);
      if (exists.rows.length) { skipped.push({ username, reason: 'That username or email already exists' }); continue; }
      const hash = await bcrypt.hash(password, 10);
      const inserted = await query(
        `INSERT INTO users (username, email, password_hash, account_type, must_change_password, last_name, first_name, middle_name)
         VALUES ($1, $2, $3, $4, $8, $5, $6, $7) RETURNING id`,
        [username, email, hash, accountType, names.lastName, names.firstName, names.middleName, !(sharedPassword && password === prelaunch.PASSWORD)]
      );
      const userId = inserted.rows[0].id;
      if (fields.employeeNo) seenNumbers.add(fields.employeeNo.toLowerCase());
      // the rest of the HR record: department (created when new), schedule, title, level, dates, phone
      let departmentId = null;
      if (fields.department) {
        let dept = (await query('SELECT id, name FROM departments WHERE LOWER(name) = LOWER($1)', [fields.department])).rows[0];
        if (!dept) {
          dept = (await query('INSERT INTO departments (name) VALUES ($1) RETURNING id, name', [fields.department])).rows[0];
          createdDepartments.add(dept.name); // a department the list introduced
        }
        departmentId = dept.id;
        fields.department = dept.name;
      }
      let scheduleId = null;
      if (fields.schedule) {
        const schedule = (await query('SELECT id FROM work_schedules WHERE LOWER(name) = LOWER($1)', [fields.schedule])).rows[0];
        if (schedule) scheduleId = schedule.id; else warnings.push({ username, warning: `Work schedule "${fields.schedule}" was not found, so the default schedule applies` });
      }
      await query(
        `UPDATE users SET employee_no = $2, job_title = $3, location = $4, hire_date = $5, employment_type = $6, job_level = $7, remote_clock = $8,
                department_id = $9, department = $10, schedule_id = $11,
                profile = CASE WHEN $12 <> '' THEN jsonb_set(profile, '{phone}', to_jsonb($12::text)) ELSE profile END
         WHERE id = $1`,
        [userId, fields.employeeNo || null, fields.jobTitle, fields.location, fields.hireDate, fields.employmentType, fields.jobLevel, fields.remoteClock,
          departmentId, fields.department || '', scheduleId, fields.phone]
      );
      if (fields.reportsTo) managerLinks.push({ userId, username, reportsTo: fields.reportsTo });
      for (const channelId of joinIds) {
        await query('INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [channelId, userId]);
      }
      if (accountType === 'member') await applyChecklist(userId, 'onboarding');
      await audit(req.user.userId, 'user_created', userId, { accountType, key });
      created.push({ id: userId, username, email, password });
    }
    // who reports to whom, now that everyone in the batch exists (a manager may be in the same file)
    for (const link of managerLinks) {
      const key = link.reportsTo.toLowerCase();
      const boss = (await query(
        "SELECT id FROM users WHERE (LOWER(username) = $1 OR LOWER(email) = $1) AND account_type = 'member' AND deactivated_at IS NULL", [key]
      )).rows[0];
      if (!boss) { warnings.push({ username: link.username, warning: `Reports to "${link.reportsTo}" was not found; set it in the employee record` }); continue; }
      if (boss.id === link.userId) { warnings.push({ username: link.username, warning: 'Nobody can report to themselves' }); continue; }
      let cursor = boss.id;
      let loop = false;
      for (let step = 0; cursor && step < 200; step += 1) {
        if (cursor === link.userId) { loop = true; break; }
        cursor = ((await query('SELECT manager_id FROM users WHERE id = $1', [cursor])).rows[0] || {}).manager_id;
      }
      if (loop) { warnings.push({ username: link.username, warning: `Reports to "${link.reportsTo}" would make a reporting loop, so it was left empty` }); continue; }
      await query('UPDATE users SET manager_id = $1 WHERE id = $2', [boss.id, link.userId]);
    }
    res.status(created.length ? 201 : 200).json({ created, skipped, warnings, createdDepartments: Array.from(createdDepartments) });
  } catch (err) {
    sendError(res, err, 'Create accounts error');
  }
});

// ---- pre-launch shared test password (Superadmin) ----

// GET /api/admin/prelaunch - is it on, and what is the password
router.get('/prelaunch', async (req, res) => {
  try {
    await requireSuperadmin(req);
    res.json({ enabled: await prelaunch.isEnabled(), password: prelaunch.PASSWORD });
  } catch (err) {
    sendError(res, err, 'Get pre-launch mode error');
  }
});

// PUT /api/admin/prelaunch - { enabled } switch it on or off (off does not change anyone's password)
router.put('/prelaunch', async (req, res) => {
  try {
    await requireSuperadmin(req);
    if (typeof (req.body && req.body.enabled) !== 'boolean') throw fail(400, 'enabled must be true or false');
    await prelaunch.setEnabled(req.body.enabled);
    await audit(req.user.userId, req.body.enabled ? 'prelaunch_password_on' : 'prelaunch_password_off', null, {});
    res.json({ enabled: req.body.enabled });
  } catch (err) {
    sendError(res, err, 'Set pre-launch mode error');
  }
});

// POST /api/admin/prelaunch/apply - give every employee the shared password now (Superadmins keep theirs)
router.post('/prelaunch/apply', async (req, res) => {
  try {
    await requireSuperadmin(req);
    if (!(await prelaunch.isEnabled())) throw fail(409, 'Switch the shared test password on first');
    const changed = await prelaunch.applyToAll();
    changed.forEach((id) => req.io?.in(`user_${id}`).disconnectSockets(true));
    await audit(req.user.userId, 'prelaunch_password_applied', null, { employees: changed.length });
    res.json({ changed: changed.length });
  } catch (err) {
    sendError(res, err, 'Apply pre-launch password error');
  }
});

// POST /api/admin/prelaunch/go-live - switch off, and everyone must choose a new password at their next sign-in
router.post('/prelaunch/go-live', async (req, res) => {
  try {
    await requireSuperadmin(req);
    const required = await prelaunch.goLive();
    await audit(req.user.userId, 'prelaunch_went_live', null, { employees: required.length });
    res.json({ enabled: false, mustChange: required.length });
  } catch (err) {
    sendError(res, err, 'Go live error');
  }
});

// ---- the go-live switch (src/launch.js) ----
const launch = require('../launch');
const launchContext = (req) => ({
  query, prelaunch,
  secure: Boolean(req.secure || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https'),
  proxied: Boolean(req.headers['x-forwarded-for']),
});

// GET /api/admin/launch - Pre-launch or Live, and what is not ready
router.get('/launch', async (req, res) => {
  try {
    await requireSuperadmin(req);
    res.json(await launch.readiness(launchContext(req)));
  } catch (err) {
    sendError(res, err, 'Launch status error');
  }
});

// POST /api/admin/launch/go-live - turn the rules on together (refused while a blocker remains)
router.post('/launch/go-live', async (req, res) => {
  try {
    await requireSuperadmin(req);
    const state = await launch.readiness(launchContext(req));
    if (state.blockers.length) throw fail(409, state.checks.filter((c) => state.blockers.includes(c.id)).map((c) => c.detail).join(' '));
    const required = await prelaunch.goLive();
    await query('UPDATE attendance_settings SET network_only = TRUE WHERE id = 1');
    await query('UPDATE moderation_settings SET go_live = TRUE WHERE id = 1');
    await audit(req.user.userId, 'went_live', null, { employees: required.length });
    res.json({ ...(await launch.readiness(launchContext(req))), mustChange: required.length });
  } catch (err) {
    sendError(res, err, 'Go live error');
  }
});

// POST /api/admin/launch/pre-launch - relax clocking again; passwords are NOT touched
router.post('/launch/pre-launch', async (req, res) => {
  try {
    await requireSuperadmin(req);
    await query('UPDATE attendance_settings SET network_only = FALSE WHERE id = 1');
    await query('UPDATE moderation_settings SET go_live = FALSE WHERE id = 1');
    await audit(req.user.userId, 'back_to_prelaunch', null, {});
    res.json(await launch.readiness(launchContext(req)));
  } catch (err) {
    sendError(res, err, 'Return to pre-launch error');
  }
});

// Creates an invitation. The code is returned once and only its hash is stored.
router.post('/invitations', async (req, res) => {
  try {
    await requireSuperadmin(req);
    const { accountType = 'member', channelIds = [], expiresInHours = 72, note = '' } = req.body || {};
    if (!ACCOUNT_TYPES.includes(accountType)) throw fail(400, 'Account type must be member or guest');
    if (!Array.isArray(channelIds) || channelIds.some((id) => !parseId(id))) {
      throw fail(400, 'channelIds must be a list of channel IDs');
    }
    if (!Number.isInteger(expiresInHours) || expiresInHours < 1 || expiresInHours > MAX_EXPIRY_HOURS) {
      throw fail(400, `Expiry must be a whole number of hours from 1 to ${MAX_EXPIRY_HOURS}`);
    }
    if (typeof note !== 'string' || note.trim().length > 120) {
      throw fail(400, 'Note must be 120 characters or fewer');
    }
    const ids = [...new Set(channelIds.map(Number))];
    if (accountType === 'guest' && ids.length === 0) {
      throw fail(400, 'Choose at least one channel for a guest');
    }
    if (ids.length) {
      const channels = await query('SELECT id FROM channels WHERE id = ANY($1::int[])', [ids]);
      if (channels.rows.length !== ids.length) throw fail(404, 'One or more channels were not found');
    }

    const code = newInviteCode();
    const created = await query(
      `INSERT INTO invitations (code_hash, account_type, channel_ids, note, created_by, expires_at)
       VALUES ($1, $2, $3::int[], $4, $5, NOW() + ($6 || ' hours')::interval)
       RETURNING *`,
      [hashInviteCode(code), accountType, ids, note.trim(), req.user.userId, String(expiresInHours)]
    );
    await audit(req.user.userId, 'invitation_created', null, {
      invitationId: created.rows[0].id, accountType, channelIds: ids,
    });
    res.status(201).json({ code, invitation: serializeInvitation(created.rows[0]) });
  } catch (err) {
    sendError(res, err, 'Create invitation error');
  }
});

router.delete('/invitations/:id', async (req, res) => {
  try {
    await requireSuperadmin(req);
    const id = parseId(req.params.id);
    if (!id) throw fail(400, 'A valid invitation ID is required');
    const revoked = await query(
      `UPDATE invitations SET revoked_at = NOW()
       WHERE id = $1 AND used_at IS NULL AND revoked_at IS NULL
       RETURNING id`,
      [id]
    );
    if (!revoked.rows.length) throw fail(404, 'No pending invitation with that ID');
    await audit(req.user.userId, 'invitation_revoked', null, { invitationId: id });
    res.json({ revoked: true });
  } catch (err) {
    sendError(res, err, 'Revoke invitation error');
  }
});

// Superadmin recovery controls. Backup files live outside the database so they remain available during a restore.
router.get('/backups', async (req, res) => {
  try {
    await requireSuperadmin(req);
    const recovery = require('../backupRecovery');
    res.json({ backups: await recovery.listBackups(), status: await recovery.readStatus() });
  } catch (err) { sendError(res, err, 'List backups error'); }
});

router.post('/backups', async (req, res) => {
  try {
    await requireSuperadmin(req);
    const recovery = require('../backupRecovery');
    const result = await recovery.createBackup();
    await audit(req.user.userId, 'backup_created', null, { stamp: result.stamp });
    res.status(201).json(result);
  } catch (err) { sendError(res, err, 'Create backup error'); }
});

router.post('/backups/:stamp/validate', async (req, res) => {
  try {
    await requireSuperadmin(req);
    res.json(await require('../backupRecovery').validateBackup(req.params.stamp));
  } catch (err) { sendError(res, err, 'Validate backup error'); }
});

router.get('/backups/:stamp/:kind', async (req, res) => {
  try {
    await requireSuperadmin(req);
    if (!['database', 'uploads'].includes(req.params.kind)) throw fail(400, 'Choose database or uploads');
    const files = require('../backupRecovery').backupPaths(req.params.stamp);
    const file = files[req.params.kind];
    await fs.promises.access(file, fs.constants.R_OK);
    res.download(file, path.basename(file));
  } catch (err) {
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'Backup file not found' });
    return sendError(res, err, 'Download backup error');
  }
});

router.post('/backups/:stamp/restore', async (req, res) => {
  try {
    await requireSuperadmin(req);
    const expected = `RESTORE ${req.params.stamp}`;
    if (req.body?.confirmation !== expected) throw fail(400, `Type ${expected} to confirm`);
    const result = await require('../backupRecovery').restoreBackup(req.params.stamp, query);
    await audit(req.user.userId, 'backup_restored', null, { stamp: result.stamp, safetyBackup: result.safetyBackup });
    res.json(result);
  } catch (err) { sendError(res, err, 'Restore backup error'); }
});

router.get('/workspace-reset/preview', async (req, res) => {
  try {
    await requireSuperadmin(req);
    res.json({ counts: await require('../workspaceReset').preview() });
  } catch (err) { sendError(res, err, 'Preview workspace reset error'); }
});

router.post('/workspace-reset', async (req, res) => {
  try {
    await requireSuperadmin(req);
    if (req.body?.confirmation !== 'RESET WORKSPACE') throw fail(400, 'Type RESET WORKSPACE to confirm');
    const result = await require('../workspaceReset').resetWorkspace(req.user.userId);
    req.io?.disconnectSockets?.(true);
    res.json(result);
  } catch (err) { sendError(res, err, 'Workspace reset error'); }
});

module.exports = router;
