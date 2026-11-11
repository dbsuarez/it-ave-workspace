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

  // Message edit history, saved items, and reminders
  `CREATE TABLE IF NOT EXISTS message_edits (
     id SERIAL PRIMARY KEY,
     message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
     previous_content TEXT NOT NULL,
     edited_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
     edited_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
   )`,
  'CREATE INDEX IF NOT EXISTS idx_message_edits_message ON message_edits(message_id, edited_at DESC)',
  `CREATE TABLE IF NOT EXISTS saved_items (
     id SERIAL PRIMARY KEY,
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     message_id INTEGER REFERENCES messages(id) ON DELETE CASCADE,
     file_id INTEGER REFERENCES files(id) ON DELETE CASCADE,
     created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
     CHECK ((message_id IS NULL) <> (file_id IS NULL))
   )`,
  'CREATE INDEX IF NOT EXISTS idx_saved_items_user ON saved_items(user_id, created_at DESC)',
  `CREATE TABLE IF NOT EXISTS reminders (
     id SERIAL PRIMARY KEY,
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     text VARCHAR(500) NOT NULL DEFAULT '',
     message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
     remind_at TIMESTAMP WITH TIME ZONE NOT NULL,
     delivered_at TIMESTAMP WITH TIME ZONE,
     created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
   )`,
  'CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders(remind_at) WHERE delivered_at IS NULL',

  // Guest accounts and invitations
  "ALTER TABLE users ADD COLUMN IF NOT EXISTS account_type VARCHAR(20) NOT NULL DEFAULT 'member'",
  "ALTER TABLE moderation_settings ADD COLUMN IF NOT EXISTS registration_mode VARCHAR(20) NOT NULL DEFAULT 'open'",
  `CREATE TABLE IF NOT EXISTS invitations (
     id SERIAL PRIMARY KEY,
     code_hash VARCHAR(64) NOT NULL UNIQUE,
     account_type VARCHAR(20) NOT NULL DEFAULT 'member',
     channel_ids INTEGER[] NOT NULL DEFAULT '{}',
     note VARCHAR(120) NOT NULL DEFAULT '',
     created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
     expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
     revoked_at TIMESTAMP WITH TIME ZONE,
     used_at TIMESTAMP WITH TIME ZONE,
     used_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
     created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
   )`,

  // Scheduled messages, personal sidebar sections, and channel links
  `CREATE TABLE IF NOT EXISTS scheduled_messages (
     id SERIAL PRIMARY KEY,
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     channel_id INTEGER REFERENCES channels(id) ON DELETE CASCADE,
     receiver_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
     content TEXT NOT NULL,
     send_at TIMESTAMP WITH TIME ZONE NOT NULL,
     sent_at TIMESTAMP WITH TIME ZONE,
     failed_at TIMESTAMP WITH TIME ZONE,
     error VARCHAR(300),
     created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
     CHECK ((channel_id IS NULL) <> (receiver_id IS NULL))
   )`,
  "CREATE INDEX IF NOT EXISTS idx_scheduled_messages_due ON scheduled_messages(send_at) WHERE sent_at IS NULL AND failed_at IS NULL",
  "ALTER TABLE users ADD COLUMN IF NOT EXISTS sidebar_layout JSONB NOT NULL DEFAULT '{}'::jsonb",
  `CREATE TABLE IF NOT EXISTS channel_links (
     id SERIAL PRIMARY KEY,
     channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
     title VARCHAR(120) NOT NULL,
     url VARCHAR(2000) NOT NULL,
     created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
     created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
   )`,
  "CREATE INDEX IF NOT EXISTS idx_channel_links_channel ON channel_links(channel_id, created_at)",
];
