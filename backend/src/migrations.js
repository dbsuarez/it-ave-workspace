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

  // Notification preferences, Do Not Disturb, and custom status
  "ALTER TABLE users ADD COLUMN IF NOT EXISTS notification_prefs JSONB NOT NULL DEFAULT '{}'::jsonb",
  'ALTER TABLE users ADD COLUMN IF NOT EXISTS dnd_until TIMESTAMP WITH TIME ZONE',
  "ALTER TABLE users ADD COLUMN IF NOT EXISTS status_text VARCHAR(100) NOT NULL DEFAULT ''",
  "ALTER TABLE users ADD COLUMN IF NOT EXISTS status_emoji VARCHAR(16) NOT NULL DEFAULT ''",

  // Group direct messages
  `CREATE TABLE IF NOT EXISTS conversations (
     id SERIAL PRIMARY KEY,
     name VARCHAR(80) NOT NULL DEFAULT '',
     created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
     created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
   )`,
  `CREATE TABLE IF NOT EXISTS conversation_members (
     conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     joined_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
     last_read_at TIMESTAMP WITH TIME ZONE,
     PRIMARY KEY (conversation_id, user_id)
   )`,
  'CREATE INDEX IF NOT EXISTS idx_conversation_members_user ON conversation_members(user_id)',
  `CREATE TABLE IF NOT EXISTS conversation_messages (
     id SERIAL PRIMARY KEY,
     conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
     user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
     content TEXT NOT NULL,
     created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
   )`,
  'CREATE INDEX IF NOT EXISTS idx_conversation_messages_conversation ON conversation_messages(conversation_id, created_at)',
];
