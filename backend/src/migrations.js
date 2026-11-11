// Idempotent schema statements applied at startup, after the legacy inline
// migrations in server.js. database/init.sql carries the same definitions for
// fresh databases.
module.exports = [
  // Mentions and the activity feed
  `CREATE TABLE IF NOT EXISTS message_mentions (
     message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
     PRIMARY KEY (message_id, user_id)
   )`,
  'CREATE INDEX IF NOT EXISTS idx_message_mentions_user ON message_mentions(user_id, created_at DESC)',
  'ALTER TABLE users ADD COLUMN IF NOT EXISTS activity_seen_at TIMESTAMP WITH TIME ZONE',
  'CREATE INDEX IF NOT EXISTS idx_messages_reply_to ON messages(reply_to) WHERE reply_to IS NOT NULL',
];
