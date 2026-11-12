// People: the directory, each employee's own page, and the org chart (who reports to whom).
//
// An employee customizes their own page: department, location, phone, an "about" text, their own titled
// sections and links, and which of email / phone / location other people may see. Reporting lines are
// kept by the Superadmin. Guests see none of this (they only reach people through their channels).
const express = require('express');
const { query } = require('../db');
const authenticateToken = require('../middleware/auth');
const { canManageEmployees } = require('../hr');

const router = express.Router();
router.use(authenticateToken);

const LIMITS = {
  department: 100, location: 100, phone: 40, jobTitle: 100, about: 1500, name: 100,
  sections: 8, sectionTitle: 60, sectionBody: 1500, links: 8, linkLabel: 40, linkUrl: 300,
};

function fail(status, message) {
  return Object.assign(new Error(message), { status });
}

const parseId = (value) => {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
};

async function viewer(userId) {
  const result = await query('SELECT id, account_type, is_superadmin, is_hr FROM users WHERE id = $1', [userId]);
  return result.rows[0] || null;
}

async function requireMember(userId) {
  const me = await viewer(userId);
  if (!me) throw fail(401, 'Account not found');
  if (me.account_type === 'guest') throw fail(403, 'Guest accounts cannot browse the directory');
  return me;
}

function text(value, max, label) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw fail(400, `${label} must be text`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw fail(400, `${label} can be at most ${max} characters`);
  return trimmed;
}

// Turns what the person typed into what is stored, or throws a 400 with the reason.
function cleanProfile(body) {
  const out = {};
  if (body.lastName !== undefined) out.lastName = text(body.lastName, LIMITS.name, 'Last name');
  if (body.firstName !== undefined) out.firstName = text(body.firstName, LIMITS.name, 'First name');
  if (body.middleName !== undefined) out.middleName = text(body.middleName, LIMITS.name, 'Middle name');
  if (body.location !== undefined) out.location = text(body.location, LIMITS.location, 'Location');
  if (body.jobTitle !== undefined) out.jobTitle = text(body.jobTitle, LIMITS.jobTitle, 'Job title');
  const extra = {};
  if (body.phone !== undefined) extra.phone = text(body.phone, LIMITS.phone, 'Phone');
  if (body.about !== undefined) extra.about = text(body.about, LIMITS.about, 'About');
  if (body.sections !== undefined) {
    if (!Array.isArray(body.sections) || body.sections.length > LIMITS.sections) throw fail(400, `A page can have at most ${LIMITS.sections} sections`);
    extra.sections = body.sections.map((section) => {
      if (!section || typeof section !== 'object') throw fail(400, 'Invalid section');
      const title = text(section.title, LIMITS.sectionTitle, 'Section title');
      const content = text(section.body, LIMITS.sectionBody, 'Section text');
      if (!title) throw fail(400, 'Each section needs a title');
      return { title, body: content };
    });
  }
  if (body.links !== undefined) {
    if (!Array.isArray(body.links) || body.links.length > LIMITS.links) throw fail(400, `A page can have at most ${LIMITS.links} links`);
    extra.links = body.links.map((link) => {
      if (!link || typeof link !== 'object') throw fail(400, 'Invalid link');
      const label = text(link.label, LIMITS.linkLabel, 'Link label');
      const url = text(link.url, LIMITS.linkUrl, 'Link address');
      if (!label) throw fail(400, 'Each link needs a label');
      if (!/^https?:\/\/[^\s]+$/i.test(url)) throw fail(400, 'Link addresses must start with http:// or https://');
      return { label, url };
    });
  }
  if (body.hide !== undefined) {
    if (!body.hide || typeof body.hide !== 'object' || Array.isArray(body.hide)) throw fail(400, 'hide must be an object of on/off settings');
    extra.hide = {};
    for (const [key, value] of Object.entries(body.hide)) {
      if (!['email', 'phone', 'location'].includes(key)) throw fail(400, `Unknown privacy setting: ${key}`);
      if (typeof value !== 'boolean') throw fail(400, `Privacy setting ${key} must be true or false`);
      extra.hide[key] = value;
    }
  }
  return { columns: out, extra };
}

const PERSON_COLUMNS = `u.id, u.username, u.last_name, u.first_name, u.middle_name, u.email, u.avatar_color, u.status, u.status_text, u.status_emoji, u.job_title,
  u.department, u.location, u.manager_id, u.photo_file, u.photo_updated_at, u.profile, u.created_at, u.account_type,
  COALESCE((SELECT array_agg(sm.manager_id ORDER BY sm.position, sm.manager_id) FROM user_secondary_managers sm WHERE sm.user_id = u.id), '{}') AS secondary_manager_ids,
  COALESCE((SELECT json_agg(json_build_object('name', r.name, 'color', r.color) ORDER BY r.position, r.id) FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = u.id), '[]'::json) AS role_chips`;

const photoVersion = (row) => (row.photo_file && row.photo_updated_at ? new Date(row.photo_updated_at).getTime() : null);

// What the viewer may see of a person: email, phone and location can be hidden by their owner.
function mapPerson(row, viewerId, { full = false } = {}) {
  const profile = row.profile && typeof row.profile === 'object' ? row.profile : {};
  const hide = profile.hide || {};
  const own = Number(row.id) === Number(viewerId);
  const shows = (key) => own || !hide[key];
  const person = {
    id: row.id,
    username: row.username,
    lastName: row.last_name || '',
    firstName: row.first_name || '',
    middleName: row.middle_name || '',
    avatarColor: row.avatar_color,
    photoVersion: photoVersion(row),
    status: row.status,
    statusText: row.status_text || '',
    statusEmoji: row.status_emoji || '',
    jobTitle: row.job_title || '',
    department: row.department || '',
    location: shows('location') ? row.location || '' : '',
    managerId: row.manager_id || null,
    // extra, dotted-line managers (the main one is managerId)
    secondaryManagerIds: (row.secondary_manager_ids || []).map(Number),
    // the custom roles they hold, highest rank first (name and color), shown as chips on their page
    roles: Array.isArray(row.role_chips) ? row.role_chips : [],
    email: shows('email') ? row.email : '',
  };
  if (full) {
    person.phone = shows('phone') ? profile.phone || '' : '';
    person.about = profile.about || '';
    person.sections = Array.isArray(profile.sections) ? profile.sections : [];
    person.links = Array.isArray(profile.links) ? profile.links : [];
    person.memberSince = row.created_at;
    if (own) person.hide = { email: Boolean(hide.email), phone: Boolean(hide.phone), location: Boolean(hide.location) };
  }
  return person;
}

// The built-in 'admin' account is a service login, not a person: it never shows in the directory or the org chart.
const MEMBERS_ONLY = "u.account_type = 'member' AND u.deactivated_at IS NULL AND NOT (u.is_superadmin AND LOWER(u.username) = 'admin')";

// GET /api/people - everyone in the directory (and so the whole org chart)
router.get('/', async (req, res) => {
  try {
    await requireMember(req.user.userId);
    const result = await query(`SELECT ${PERSON_COLUMNS} FROM users u WHERE ${MEMBERS_ONLY} ORDER BY LOWER(u.username)`);
    res.json({ people: result.rows.map((row) => mapPerson(row, req.user.userId)) });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('People list error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /api/people/me - customize my own page
router.put('/me', async (req, res) => {
  try {
    const me = await viewer(req.user.userId);
    if (!me) throw fail(401, 'Account not found');
    const { columns, extra } = cleanProfile(req.body || {});
    const current = (await query('SELECT profile FROM users WHERE id = $1', [me.id])).rows[0];
    const merged = { ...(current && current.profile ? current.profile : {}), ...extra };
    if (extra.hide) merged.hide = { ...((current && current.profile && current.profile.hide) || {}), ...extra.hide };
    await query(
      `UPDATE users SET department = COALESCE($1, department), location = COALESCE($2, location),
              job_title = COALESCE($3, job_title), profile = $4::jsonb,
              last_name = COALESCE($6, last_name), first_name = COALESCE($7, first_name), middle_name = COALESCE($8, middle_name)
       WHERE id = $5`,
      [columns.department ?? null, columns.location ?? null, columns.jobTitle ?? null, JSON.stringify(merged), me.id,
        columns.lastName ?? null, columns.firstName ?? null, columns.middleName ?? null]
    );
    const row = (await query(`SELECT ${PERSON_COLUMNS} FROM users u WHERE u.id = $1`, [me.id])).rows[0];
    res.json({ person: mapPerson(row, me.id, { full: true }) });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('Update my page error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/people/:id - one employee's page, with who they report to and who reports to them
router.get('/:id', async (req, res) => {
  try {
    const me = await requireMember(req.user.userId);
    const id = parseId(req.params.id);
    if (id === null) throw fail(400, 'A valid person ID is required');
    const result = await query(`SELECT ${PERSON_COLUMNS} FROM users u WHERE u.id = $1 AND ${MEMBERS_ONLY}`, [id]);
    const row = result.rows[0];
    if (!row) throw fail(404, 'Person not found');
    const person = mapPerson(row, me.id, { full: true });
    const manager = row.manager_id
      ? (await query(`SELECT ${PERSON_COLUMNS} FROM users u WHERE u.id = $1 AND ${MEMBERS_ONLY}`, [row.manager_id])).rows[0]
      : null;
    const reports = (await query(
      `SELECT ${PERSON_COLUMNS} FROM users u WHERE u.manager_id = $1 AND ${MEMBERS_ONLY} ORDER BY LOWER(u.username)`, [id]
    )).rows;
    const secondaryManagers = person.secondaryManagerIds.length ? (await query(
      `SELECT ${PERSON_COLUMNS} FROM users u JOIN user_secondary_managers sm ON sm.manager_id = u.id
       WHERE sm.user_id = $1 AND ${MEMBERS_ONLY} ORDER BY sm.position, sm.manager_id`, [id]
    )).rows : [];
    const secondaryReports = (await query(
      `SELECT ${PERSON_COLUMNS} FROM users u JOIN user_secondary_managers sm ON sm.user_id = u.id
       WHERE sm.manager_id = $1 AND ${MEMBERS_ONLY} ORDER BY LOWER(u.username)`, [id]
    )).rows;
    res.json({
      person,
      manager: manager ? mapPerson(manager, me.id) : null,
      secondaryManagers: secondaryManagers.map((row) => mapPerson(row, me.id)),
      secondaryReports: secondaryReports.map((row) => mapPerson(row, me.id)),
      reports: reports.map((report) => mapPerson(report, me.id)),
      canSetManager: canManageEmployees(me),
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('Get person error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /api/people/:id/names - the Superadmin fills in or corrects someone's name (people can also edit their own)
router.put('/:id/names', async (req, res) => {
  try {
    const me = await requireMember(req.user.userId);
    if (!canManageEmployees(me)) throw fail(403, 'Only the Superadmin or HR can change someone else\'s name');
    const id = parseId(req.params.id);
    if (id === null) throw fail(400, 'A valid person ID is required');
    const { columns } = cleanProfile({ lastName: req.body && req.body.lastName, firstName: req.body && req.body.firstName, middleName: req.body && req.body.middleName });
    const result = await query(
      `UPDATE users SET last_name = COALESCE($1, last_name), first_name = COALESCE($2, first_name), middle_name = COALESCE($3, middle_name)
       WHERE id = $4 AND ${MEMBERS_ONLY.replace(/u\./g, '')} RETURNING id`,
      [columns.lastName ?? null, columns.firstName ?? null, columns.middleName ?? null, id]
    );
    if (!result.rows.length) throw fail(404, 'Person not found');
    const row = (await query(`SELECT ${PERSON_COLUMNS} FROM users u WHERE u.id = $1`, [id])).rows[0];
    res.json({ person: mapPerson(row, me.id, { full: true }) });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('Set names error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /api/people/:id/manager - set who someone reports to (Superadmin); { managerId: null } clears it
router.put('/:id/manager', async (req, res) => {
  try {
    const me = await requireMember(req.user.userId);
    if (!canManageEmployees(me)) throw fail(403, 'Only the Superadmin or HR can change reporting lines');
    const id = parseId(req.params.id);
    if (id === null) throw fail(400, 'A valid person ID is required');
    const managerId = req.body && req.body.managerId === null ? null : parseId(req.body && req.body.managerId);
    if (req.body && req.body.managerId !== null && managerId === null) throw fail(400, 'managerId must be a person ID or null');
    const person = (await query(`SELECT u.id FROM users u WHERE u.id = $1 AND ${MEMBERS_ONLY}`, [id])).rows[0];
    if (!person) throw fail(404, 'Person not found');
    if (managerId !== null) {
      if (managerId === id) throw fail(400, 'Nobody can report to themselves');
      const boss = (await query(`SELECT u.id FROM users u WHERE u.id = $1 AND ${MEMBERS_ONLY}`, [managerId])).rows[0];
      if (!boss) throw fail(404, 'That manager was not found');
      // walking up from the new manager must never reach this person: that would make a loop
      let cursor = managerId;
      for (let step = 0; cursor && step < 200; step += 1) {
        if (cursor === id) throw fail(400, 'That would make a reporting loop');
        const next = (await query('SELECT manager_id FROM users WHERE id = $1', [cursor])).rows[0];
        cursor = next ? next.manager_id : null;
      }
    }
    await query('UPDATE users SET manager_id = $1 WHERE id = $2', [managerId, id]);
    // the main manager is not also an extra one
    if (managerId !== null) await query('DELETE FROM user_secondary_managers WHERE user_id = $1 AND manager_id = $2', [id, managerId]);
    res.json({ id, managerId });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('Set manager error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /api/people/:id/secondary-managers - the extra (dotted-line) managers, in order; { managerIds: [] } clears them
const MAX_SECONDARY_MANAGERS = 5;
router.put('/:id/secondary-managers', async (req, res) => {
  try {
    const me = await requireMember(req.user.userId);
    if (!canManageEmployees(me)) throw fail(403, 'Only the Superadmin or HR can change reporting lines');
    const id = parseId(req.params.id);
    if (id === null) throw fail(400, 'A valid person ID is required');
    const given = req.body && req.body.managerIds;
    if (!Array.isArray(given) || given.length > MAX_SECONDARY_MANAGERS) throw fail(400, `managerIds must be a list of at most ${MAX_SECONDARY_MANAGERS} people`);
    const managerIds = given.map(parseId);
    if (managerIds.some((value) => value === null)) throw fail(400, 'managerIds must be person IDs');
    if (new Set(managerIds).size !== managerIds.length) throw fail(400, 'Each manager can be listed once');
    const person = (await query(`SELECT u.id, u.manager_id FROM users u WHERE u.id = $1 AND ${MEMBERS_ONLY}`, [id])).rows[0];
    if (!person) throw fail(404, 'Person not found');
    if (managerIds.includes(id)) throw fail(400, 'Nobody can report to themselves');
    if (person.manager_id && managerIds.includes(Number(person.manager_id))) throw fail(400, 'That person is already the main manager');
    if (managerIds.length) {
      const found = await query(`SELECT u.id FROM users u WHERE u.id = ANY($1::int[]) AND ${MEMBERS_ONLY}`, [managerIds]);
      if (found.rows.length !== managerIds.length) throw fail(404, 'One of those managers was not found');
    }
    await query('DELETE FROM user_secondary_managers WHERE user_id = $1', [id]);
    if (managerIds.length) {
      await query(
        'INSERT INTO user_secondary_managers (user_id, manager_id, position) SELECT $1, m, ord FROM unnest($2::int[]) WITH ORDINALITY AS t(m, ord)',
        [id, managerIds]
      );
    }
    res.json({ id, secondaryManagerIds: managerIds });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('Set secondary managers error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
module.exports.cleanProfile = cleanProfile;
