// Roles given by department. A role can be marked "given to members of these departments" (table department_roles). Everyone in
// such a department holds the role as an automatic assignment (user_roles.auto = true); when they leave every department that
// gives it, the assignment goes. A role someone was given by hand is never claimed or removed by a rule. Only custom roles can be
// given this way: the built-in Owner and Everyone roles are skipped even if a rule row for them were to exist.
//
// Every function takes `query(text, params)` (a pool, a client, or a test database) and returns who changed.

// The roles a person should hold because of the departments they belong to.
const DESIRED = `SELECT DISTINCT dr.role_id
                 FROM department_roles dr
                 JOIN user_departments ud ON ud.department_id = dr.department_id
                 JOIN roles r ON r.id = dr.role_id AND r.builtin_key IS NULL
                 WHERE ud.user_id = $1`;

const ids = (result) => result.rows.map((row) => Number(row.role_id)).sort((a, b) => a - b);

// Brings one person's automatic roles in line with their departments. Returns { added, removed } (role ids).
async function reconcileUser(query, userId) {
  const added = ids(await query(
    `INSERT INTO user_roles (user_id, role_id, assigned_by, auto)
     SELECT $1, d.role_id, NULL, true FROM (${DESIRED}) d
     ON CONFLICT DO NOTHING RETURNING role_id`, [userId]));
  const removed = ids(await query(
    `DELETE FROM user_roles WHERE user_id = $1 AND auto AND role_id NOT IN (${DESIRED}) RETURNING role_id`, [userId]));
  if (added.length || removed.length) {
    // the former HR role also keeps a presentation flag on the person
    await query(
      `UPDATE users SET is_hr = EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = users.id AND r.legacy_hr = true)
       WHERE id = $1 AND EXISTS (SELECT 1 FROM roles WHERE legacy_hr = true AND id = ANY($2::int[]))`, [userId, [...added, ...removed]]);
  }
  return { added, removed };
}

async function reconcileMany(query, userIds) {
  const changes = [];
  for (const userId of userIds) {
    const { added, removed } = await reconcileUser(query, userId);
    if (added.length || removed.length) changes.push({ userId, added, removed });
  }
  return changes;
}

// After a rule changes or a department goes: the department's members, and anyone still holding an automatic role.
async function reconcileDepartment(query, departmentId) {
  const rows = (await query(
    `SELECT user_id FROM user_departments WHERE department_id = $1
     UNION SELECT user_id FROM user_roles WHERE auto`, [departmentId])).rows;
  return reconcileMany(query, rows.map((row) => Number(row.user_id)));
}

// Everyone who belongs to a department or holds an automatic role (used at start-up, so a missed change heals itself).
async function reconcileEveryone(query) {
  const rows = (await query('SELECT user_id FROM user_departments UNION SELECT user_id FROM user_roles WHERE auto')).rows;
  return reconcileMany(query, rows.map((row) => Number(row.user_id)));
}

module.exports = { reconcileUser, reconcileDepartment, reconcileEveryone };
