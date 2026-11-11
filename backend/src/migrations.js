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

  // User groups and incoming webhooks
  `CREATE TABLE IF NOT EXISTS user_groups (
     id SERIAL PRIMARY KEY,
     handle VARCHAR(31) NOT NULL UNIQUE,
     name VARCHAR(80) NOT NULL,
     created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
     created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
   )`,
  `CREATE TABLE IF NOT EXISTS user_group_members (
     group_id INTEGER NOT NULL REFERENCES user_groups(id) ON DELETE CASCADE,
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     PRIMARY KEY (group_id, user_id)
   )`,
  `CREATE TABLE IF NOT EXISTS webhooks (
     id SERIAL PRIMARY KEY,
     channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
     name VARCHAR(40) NOT NULL,
     token_hash VARCHAR(64) NOT NULL UNIQUE,
     bot_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
     created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
     created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
     last_used_at TIMESTAMP WITH TIME ZONE
   )`,

  // Guests are not part of group messages (see routes/conversations.js)
  "DELETE FROM conversation_members WHERE user_id IN (SELECT id FROM users WHERE account_type = 'guest')",

  // Comment threads on a canvas (a top-level comment may quote the passage it is about; replies have parent_id)
  `CREATE TABLE IF NOT EXISTS canvas_comments (
     id SERIAL PRIMARY KEY,
     canvas_id INTEGER NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
     parent_id INTEGER REFERENCES canvas_comments(id) ON DELETE CASCADE,
     user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
     body TEXT NOT NULL,
     anchor TEXT,
     resolved_at TIMESTAMP WITH TIME ZONE,
     resolved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
     created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
   )`,
  'CREATE INDEX IF NOT EXISTS idx_canvas_comments_canvas ON canvas_comments(canvas_id, created_at)',

  // Images inside a canvas are files that belong to the canvas (deleted with it)
  'ALTER TABLE files ADD COLUMN IF NOT EXISTS canvas_id INTEGER REFERENCES canvases(id) ON DELETE CASCADE',
  'CREATE INDEX IF NOT EXISTS idx_files_canvas_id ON files(canvas_id)',

  // Canvas revisions: every save bumps the number; clients send it back so a stale save is refused
  'ALTER TABLE canvases ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 1',

  // Canvas owner as an explicit, transferable level, and sharing a standalone canvas with a channel
  'ALTER TABLE canvases ADD COLUMN IF NOT EXISTS owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL',
  "UPDATE canvases SET owner_id = created_by WHERE kind = 'standalone' AND owner_id IS NULL AND created_by IS NOT NULL",
  `CREATE TABLE IF NOT EXISTS canvas_channel_grants (
     canvas_id INTEGER NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
     channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
     role VARCHAR(16) NOT NULL DEFAULT 'viewer' CHECK (role IN ('viewer', 'editor')),
     granted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
     created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
     PRIMARY KEY (canvas_id, channel_id)
   )`,
  'CREATE INDEX IF NOT EXISTS idx_canvas_channel_grants_channel ON canvas_channel_grants(channel_id)',

  // Lists as typed tables: columns, rows and cells (see REAGHIDRA/05). Existing to-do items move over once.
  "ALTER TABLE channel_lists ADD COLUMN IF NOT EXISTS todo_mode BOOLEAN NOT NULL DEFAULT TRUE",
  "ALTER TABLE channel_lists ADD COLUMN IF NOT EXISTS description VARCHAR(500) NOT NULL DEFAULT ''",
  "ALTER TABLE channel_lists ADD COLUMN IF NOT EXISTS archived_at TIMESTAMP WITH TIME ZONE",
  `CREATE TABLE IF NOT EXISTS list_columns (
     id SERIAL PRIMARY KEY,
     list_id INTEGER NOT NULL REFERENCES channel_lists(id) ON DELETE CASCADE,
     key VARCHAR(40) NOT NULL,
     name VARCHAR(80) NOT NULL,
     type VARCHAR(16) NOT NULL CHECK (type IN ('text', 'checkbox', 'date', 'user', 'select', 'number', 'link')),
     options JSONB NOT NULL DEFAULT '{}'::jsonb,
     is_primary BOOLEAN NOT NULL DEFAULT FALSE,
     position INTEGER NOT NULL DEFAULT 0,
     created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
     UNIQUE (list_id, key),
     CHECK (NOT is_primary OR type = 'text')
   )`,
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_list_columns_one_primary ON list_columns(list_id) WHERE is_primary",
  `CREATE TABLE IF NOT EXISTS list_rows (
     id SERIAL PRIMARY KEY,
     list_id INTEGER NOT NULL REFERENCES channel_lists(id) ON DELETE CASCADE,
     parent_row_id INTEGER REFERENCES list_rows(id) ON DELETE CASCADE,
     position INTEGER NOT NULL DEFAULT 0,
     archived_at TIMESTAMP WITH TIME ZONE,
     created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
     updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
     created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
     updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
   )`,
  "CREATE INDEX IF NOT EXISTS idx_list_rows_list ON list_rows(list_id, position, id)",
  `CREATE TABLE IF NOT EXISTS list_cells (
     row_id INTEGER NOT NULL REFERENCES list_rows(id) ON DELETE CASCADE,
     column_id INTEGER NOT NULL REFERENCES list_columns(id) ON DELETE CASCADE,
     value JSONB NOT NULL,
     PRIMARY KEY (row_id, column_id)
   )`,
  "CREATE INDEX IF NOT EXISTS idx_list_cells_column ON list_cells(column_id)",
  `CREATE TABLE IF NOT EXISTS schema_markers (
     name VARCHAR(80) PRIMARY KEY,
     applied_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
   )`,
  `DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_markers WHERE name = 'lists_typed_v1') THEN
    INSERT INTO list_columns (list_id, key, name, type, is_primary, position)
      SELECT l.id, c.key, c.name, c.type, c.is_primary, c.position
      FROM channel_lists l
      CROSS JOIN (VALUES
        ('title', 'Title', 'text', TRUE, 0),
        ('completed', 'Completed', 'checkbox', FALSE, 1),
        ('assignee', 'Assignee', 'user', FALSE, 2),
        ('due_date', 'Due date', 'date', FALSE, 3)
      ) AS c(key, name, type, is_primary, position)
      ON CONFLICT (list_id, key) DO NOTHING;

    INSERT INTO list_rows (id, list_id, position, created_by, updated_by, created_at, updated_at)
      SELECT i.id, i.list_id, i.id, i.created_by, i.created_by, i.created_at, i.updated_at
      FROM channel_list_items i
      ON CONFLICT (id) DO NOTHING;

    PERFORM setval(pg_get_serial_sequence('list_rows', 'id'),
                   GREATEST((SELECT COALESCE(MAX(id), 0) FROM list_rows), 1),
                   (SELECT COUNT(*) FROM list_rows) > 0);

    INSERT INTO list_cells (row_id, column_id, value)
      SELECT i.id, c.id, to_jsonb(i.title)
      FROM channel_list_items i JOIN list_columns c ON c.list_id = i.list_id AND c.key = 'title'
      ON CONFLICT DO NOTHING;
    INSERT INTO list_cells (row_id, column_id, value)
      SELECT i.id, c.id, to_jsonb(TRUE)
      FROM channel_list_items i JOIN list_columns c ON c.list_id = i.list_id AND c.key = 'completed'
      WHERE i.is_completed
      ON CONFLICT DO NOTHING;
    INSERT INTO list_cells (row_id, column_id, value)
      SELECT i.id, c.id, jsonb_build_array(i.assignee_id)
      FROM channel_list_items i JOIN list_columns c ON c.list_id = i.list_id AND c.key = 'assignee'
      WHERE i.assignee_id IS NOT NULL
      ON CONFLICT DO NOTHING;
    INSERT INTO list_cells (row_id, column_id, value)
      SELECT i.id, c.id, to_jsonb(to_char(i.due_date, 'YYYY-MM-DD'))
      FROM channel_list_items i JOIN list_columns c ON c.list_id = i.list_id AND c.key = 'due_date'
      WHERE i.due_date IS NOT NULL
      ON CONFLICT DO NOTHING;

    INSERT INTO schema_markers (name) VALUES ('lists_typed_v1');
  END IF;
END
$$`,

  // Canvas history: snapshots of saved versions (kept short, see routes/canvas.js)
  `CREATE TABLE IF NOT EXISTS canvas_revisions (
     id SERIAL PRIMARY KEY,
     canvas_id INTEGER NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
     revision INTEGER NOT NULL,
     title VARCHAR(160) NOT NULL,
     content TEXT NOT NULL,
     edited_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
     edited_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
     UNIQUE (canvas_id, revision)
   )`,
];
