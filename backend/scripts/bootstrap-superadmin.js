const config = require('../src/config');
const { Pool } = require('pg');
const pool = new Pool({ connectionString: config.DATABASE_URL });

async function main() {
  if (!config.SUPERADMIN_USERNAME) {
    throw new Error('SUPERADMIN_USERNAME must be configured before running this command');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `UPDATE users SET is_superadmin = TRUE
       WHERE username = $1
       RETURNING id, username`,
      [config.SUPERADMIN_USERNAME]
    );
    if (!result.rows.length) {
      throw new Error(`No existing account named "${config.SUPERADMIN_USERNAME}" was found; register it first, then run this command`);
    }
    await client.query(
      `INSERT INTO moderation_audit_log (target_user_id, action, details)
       VALUES ($1, 'superadmin_bootstrapped', $2)`,
      [result.rows[0].id, JSON.stringify({ username: result.rows[0].username })]
    );
    await client.query('COMMIT');
    console.log(`Granted Superadmin to ${result.rows[0].username} (user ${result.rows[0].id}).`);
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      console.error('Superadmin bootstrap rollback failed:', rollbackErr);
    }
    throw err;
  } finally {
    client.release();
  }
}

main()
  .catch((err) => {
    console.error('Superadmin bootstrap failed:', err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
