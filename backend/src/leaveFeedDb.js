// Sheets that feed Leave: the database side (docs/superpowers/specs/2026-11-19-sheets-feed-leave-design.md). The preview reads Leave,
// applying changes it inside the caller's transaction, and managedYears tells Leave which years a sheet has taken over.
const leaveFeeds = require('./leaveFeeds');

// Active leave types as Map(lowercase name -> name).
async function leaveTypeNames(db) {
  const rows = (await db.query('SELECT name FROM leave_types WHERE active')).rows;
  return new Map(rows.map((row) => [row.name.toLowerCase(), row.name]));
}

async function existingHolidays(db) {
  return (await db.query("SELECT to_char(day, 'YYYY-MM-DD') AS day, name FROM company_holidays")).rows;
}

async function existingCredits(db) {
  const rows = (await db.query(
    `SELECT LOWER(u.username) AS username, t.name AS type_name, e.year, e.adjustment::float AS adjustment
     FROM leave_entitlements e JOIN users u ON u.id = e.user_id JOIN leave_types t ON t.id = e.leave_type_id`)).rows;
  return rows.map((row) => ({ username: row.username, typeName: row.type_name, year: Number(row.year), adjustment: row.adjustment }));
}

// What applying these typed rows would change in Leave.
async function buildPreview(db, feeds, rows) {
  if (feeds === 'holidays') return leaveFeeds.planHolidays(rows, await existingHolidays(db));
  return leaveFeeds.planCredits(rows, await existingCredits(db), { canonicalType: await leaveTypeNames(db) });
}

// Applies the preview's changes (call inside a transaction with the same rows that were checked).
async function applyFeed(db, feeds, rows) {
  const plan = await buildPreview(db, feeds, rows);
  if (feeds === 'holidays') {
    for (const item of [...plan.add, ...plan.rename.map((r) => ({ day: r.day, name: r.to }))]) {
      await db.query('INSERT INTO company_holidays (day, name) VALUES ($1, $2) ON CONFLICT (day) DO UPDATE SET name = EXCLUDED.name', [item.day, item.name]);
    }
    for (const item of plan.remove) await db.query('DELETE FROM company_holidays WHERE day = $1', [item.day]);
    return plan;
  }
  const where = `u.id = (SELECT id FROM users WHERE LOWER(username) = $1 AND account_type = 'member' LIMIT 1)`;
  for (const item of plan.set) {
    await db.query(
      `INSERT INTO leave_entitlements (user_id, leave_type_id, year, adjustment)
       SELECT u.id, t.id, $3, $4 FROM users u, leave_types t WHERE ${where} AND t.name = $2
       ON CONFLICT (user_id, leave_type_id, year) DO UPDATE SET adjustment = EXCLUDED.adjustment`,
      [item.username, item.typeName, item.year, item.adjustment]);
  }
  for (const item of plan.reset) {
    await db.query(
      `DELETE FROM leave_entitlements e USING users u, leave_types t
       WHERE e.user_id = u.id AND e.leave_type_id = t.id AND ${where} AND t.name = $2 AND e.year = $3`,
      [item.username, item.typeName, item.year]);
  }
  return plan;
}

// The sheet that has taken over holidays or credits: { years: [..], sheet: { id, title }, table } or null (nothing published yet counts as null).
async function managedYears(db, feeds) {
  const row = (await db.query(
    `SELECT t.name, t.published, s.id AS sheet_id, s.title FROM sheet_tables t JOIN sheets s ON s.id = t.sheet_id
     WHERE t.feeds = $1 AND t.published IS NOT NULL`, [feeds])).rows[0];
  if (!row) return null;
  return { years: leaveFeeds.feedYears(feeds, row.published.rows || []), sheet: { id: row.sheet_id, title: row.title }, table: row.name };
}

// Throws a 409 when `year` is one a sheet manages.
async function refuseIfManaged(db, feeds, year, fail) {
  const managed = await managedYears(db, feeds);
  if (managed && managed.years.includes(year)) {
    throw fail(409, `${year} is managed by the sheet "${managed.sheet.title}". Change it there and Publish again.`);
  }
}

module.exports = { leaveTypeNames, buildPreview, applyFeed, managedYears, refuseIfManaged };
