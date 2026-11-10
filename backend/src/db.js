const { Pool } = require('pg');
const config = require('./config');

if (!config.DATABASE_URL) {
  throw new Error('DATABASE_URL is required');
}

const pool = new Pool({
  connectionString: config.DATABASE_URL,
});

pool.on('connect', () => {
  console.log('Connected to PostgreSQL');
});

pool.on('error', (err) => {
  console.error('Unexpected PostgreSQL client error', err);
  process.exit(-1);
});

(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS message_read_receipts (
        message_id INTEGER REFERENCES messages(id) ON DELETE CASCADE,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        read_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        PRIMARY KEY (message_id, user_id)
      );
    `);
    await pool.query('CREATE INDEX IF NOT EXISTS idx_message_read_receipts_message_id ON message_read_receipts(message_id);');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_message_read_receipts_user_id ON message_read_receipts(user_id);');
  } catch (err) {
    console.error('Failed to initialize read receipt table:', err);
  }
})();

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool,
};
