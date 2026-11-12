// The schema, as idempotent statements applied at startup (server.js runs this list and nothing else).
// database/init.sql carries the base tables for a fresh database; everything else is here, so there are
// two places, not three. backend/test/schema.test.js keeps them honest.
module.exports = [
  // ---- Base schema (moved here from server.js, which used to run it inline at startup). Together with
  // database/init.sql this is the whole schema; server.js runs only this list.
  'ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE users ADD COLUMN IF NOT EXISTS is_superadmin BOOLEAN NOT NULL DEFAULT FALSE',
  "ALTER TABLE channel_members ADD COLUMN IF NOT EXISTS role VARCHAR(20) NOT NULL DEFAULT 'member'",
  'ALTER TABLE channel_members ADD COLUMN IF NOT EXISTS last_message_at TIMESTAMP WITH TIME ZONE',
  'ALTER TABLE channels ADD COLUMN IF NOT EXISTS slowmode_seconds INTEGER NOT NULL DEFAULT 0',
  `
    DO $$ BEGIN
      ALTER TABLE channel_members ADD CONSTRAINT channel_members_role_check
        CHECK (role IN ('member', 'moderator'));
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$
  `,
  `
    CREATE TABLE IF NOT EXISTS moderation_settings (
      id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      default_timeout_minutes INTEGER NOT NULL DEFAULT 5 CHECK (default_timeout_minutes BETWEEN 1 AND 10080),
      max_timeout_minutes INTEGER NOT NULL DEFAULT 10080 CHECK (max_timeout_minutes BETWEEN 1 AND 10080),
      updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
      CHECK (default_timeout_minutes <= max_timeout_minutes)
    )
  `,
  'INSERT INTO moderation_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING',
  `
    CREATE TABLE IF NOT EXISTS channel_timeouts (
      id SERIAL PRIMARY KEY,
      channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      moderator_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      reason VARCHAR(500) NOT NULL DEFAULT '',
      expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    )
  `,
  'CREATE INDEX IF NOT EXISTS idx_channel_timeouts_active ON channel_timeouts(channel_id, user_id, expires_at DESC)',
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_timeouts_channel_user ON channel_timeouts(channel_id, user_id)',
  `
    CREATE TABLE IF NOT EXISTS message_reports (
      id SERIAL PRIMARY KEY,
      channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      reporter_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      reason VARCHAR(500) NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'dismissed')),
      resolved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      resolved_at TIMESTAMP WITH TIME ZONE,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    )
  `,
  'CREATE INDEX IF NOT EXISTS idx_message_reports_queue ON message_reports(channel_id, status, created_at DESC)',
  `
    CREATE UNIQUE INDEX IF NOT EXISTS idx_message_reports_open_reporter
        ON message_reports(message_id, reporter_id) WHERE status = 'open' AND reporter_id IS NOT NULL
  `,
  `
    CREATE TABLE IF NOT EXISTS moderation_audit_log (
      id BIGSERIAL PRIMARY KEY,
      channel_id INTEGER REFERENCES channels(id) ON DELETE SET NULL,
      actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      target_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      action VARCHAR(50) NOT NULL,
      details JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    )
  `,
  'CREATE INDEX IF NOT EXISTS idx_moderation_audit_channel_created ON moderation_audit_log(channel_id, created_at DESC)',
  'ALTER TABLE messages ADD COLUMN IF NOT EXISTS pinned_at TIMESTAMP WITH TIME ZONE',
  'ALTER TABLE messages ADD COLUMN IF NOT EXISTS pinned_by INTEGER REFERENCES users(id) ON DELETE SET NULL',
  `
    CREATE INDEX IF NOT EXISTS idx_messages_pinned_channel
        ON messages(channel_id, pinned_at DESC)
        WHERE pinned_at IS NOT NULL
  `,
  `
    CREATE TABLE IF NOT EXISTS channel_lists (
      id SERIAL PRIMARY KEY,
      channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      title VARCHAR(120) NOT NULL,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS channel_list_items (
      id SERIAL PRIMARY KEY,
      list_id INTEGER NOT NULL REFERENCES channel_lists(id) ON DELETE CASCADE,
      title VARCHAR(200) NOT NULL,
      is_completed BOOLEAN NOT NULL DEFAULT FALSE,
      assignee_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      due_date DATE,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    )
  `,
  'CREATE INDEX IF NOT EXISTS idx_channel_lists_channel_id ON channel_lists(channel_id)',
  'CREATE INDEX IF NOT EXISTS idx_channel_list_items_list_id ON channel_list_items(list_id)',
  `
    CREATE TABLE IF NOT EXISTS channel_canvases (
      id SERIAL PRIMARY KEY,
      channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      title VARCHAR(120) NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    )
  `,
  'CREATE INDEX IF NOT EXISTS idx_channel_canvases_channel_id ON channel_canvases(channel_id)',
  `
    CREATE TABLE IF NOT EXISTS canvases (
      id SERIAL PRIMARY KEY,
      kind VARCHAR(16) NOT NULL CHECK (kind IN ('channel', 'dm', 'standalone')),
      channel_id INTEGER NULL REFERENCES channels(id) ON DELETE CASCADE,
      dm_user_low INTEGER NULL REFERENCES users(id) ON DELETE CASCADE,
      dm_user_high INTEGER NULL REFERENCES users(id) ON DELETE CASCADE,
      title VARCHAR(160) NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
      CHECK (
        (kind = 'channel' AND channel_id IS NOT NULL)
        OR (kind = 'dm' AND dm_user_low IS NOT NULL AND dm_user_high IS NOT NULL)
        OR (kind = 'standalone' AND channel_id IS NULL AND dm_user_low IS NULL AND dm_user_high IS NULL)
      ),
      CHECK (dm_user_low IS NULL OR dm_user_low < dm_user_high)
    )
  `,
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_canvases_channel ON canvases(channel_id) WHERE kind = 'channel'",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_canvases_dm ON canvases(dm_user_low, dm_user_high) WHERE kind = 'dm'",
  `
    CREATE TABLE IF NOT EXISTS canvas_collaborators (
      canvas_id INTEGER NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role VARCHAR(16) NOT NULL DEFAULT 'editor' CHECK (role IN ('viewer', 'commenter', 'editor')),
      granted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
      PRIMARY KEY (canvas_id, user_id)
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS canvas_shares (
      id SERIAL PRIMARY KEY,
      canvas_id INTEGER NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
      token VARCHAR(64) NOT NULL UNIQUE,
      role VARCHAR(16) NOT NULL DEFAULT 'editor' CHECK (role IN ('viewer', 'editor')),
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
      expires_at TIMESTAMP WITH TIME ZONE
    )
  `,
  'CREATE INDEX IF NOT EXISTS idx_canvas_shares_token ON canvas_shares(token)',

  // ---- Later additions
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

  // Who was mentioned in a canvas or replied to in its comments (source: content, comment or reply); feeds Activity
  `CREATE TABLE IF NOT EXISTS canvas_mentions (
     id SERIAL PRIMARY KEY,
     canvas_id INTEGER NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
     source VARCHAR(12) NOT NULL,
     snippet TEXT NOT NULL DEFAULT '',
     created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
   )`,
  'CREATE INDEX IF NOT EXISTS idx_canvas_mentions_user ON canvas_mentions(user_id, created_at DESC)',

  // Employee pages and the org chart: where someone works, who they report to, and their own page content
  "ALTER TABLE users ADD COLUMN IF NOT EXISTS department VARCHAR(100) NOT NULL DEFAULT ''",
  "ALTER TABLE users ADD COLUMN IF NOT EXISTS location VARCHAR(100) NOT NULL DEFAULT ''",
  'ALTER TABLE users ADD COLUMN IF NOT EXISTS manager_id INTEGER REFERENCES users(id) ON DELETE SET NULL',
  "ALTER TABLE users ADD COLUMN IF NOT EXISTS profile JSONB NOT NULL DEFAULT '{}'::jsonb",
  'CREATE INDEX IF NOT EXISTS idx_users_manager ON users(manager_id) WHERE manager_id IS NOT NULL',
  // Accounts the Superadmin creates start with a temporary password the person is asked to replace
  'ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT false',

  // Extra (dotted-line) managers besides the main one in users.manager_id; position keeps the order they were given
  `CREATE TABLE IF NOT EXISTS user_secondary_managers (
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     manager_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     position SMALLINT NOT NULL DEFAULT 0,
     PRIMARY KEY (user_id, manager_id),
     CHECK (user_id <> manager_id)
   )`,
  'CREATE INDEX IF NOT EXISTS idx_secondary_managers_manager ON user_secondary_managers(manager_id)',

  // Profile photo: the stored file name and when it last changed (the client uses that as a cache key)
  'ALTER TABLE users ADD COLUMN IF NOT EXISTS photo_file VARCHAR(255)',
  'ALTER TABLE users ADD COLUMN IF NOT EXISTS photo_updated_at TIMESTAMP WITH TIME ZONE',

  // A channel canvas used to be titled with the channel's number ("#23"); give it the channel's name
  "UPDATE canvases c SET title = '#' || ch.name FROM channels ch WHERE c.kind = 'channel' AND c.channel_id = ch.id AND c.title ~ '^#[0-9]+$'",

  // Job title shown on profile cards (for example when someone is mentioned in a canvas)
  "ALTER TABLE users ADD COLUMN IF NOT EXISTS job_title VARCHAR(100) NOT NULL DEFAULT ''",

  // Deleting a personal canvas moves it to the trash for a few days (deleted_at); a purge removes it later
  'ALTER TABLE canvases ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP WITH TIME ZONE',
  'ALTER TABLE canvases ADD COLUMN IF NOT EXISTS deleted_by INTEGER REFERENCES users(id) ON DELETE SET NULL',
  'CREATE INDEX IF NOT EXISTS idx_canvases_deleted_at ON canvases(deleted_at) WHERE deleted_at IS NOT NULL',

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
     role VARCHAR(16) NOT NULL DEFAULT 'viewer' CHECK (role IN ('viewer', 'commenter', 'editor')),
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

  // A comment-only level between viewer and editor (older databases have the two-value check)
  `DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'canvas_collaborators_role_check' AND pg_get_constraintdef(oid) NOT LIKE '%commenter%') THEN
    ALTER TABLE canvas_collaborators DROP CONSTRAINT canvas_collaborators_role_check;
    ALTER TABLE canvas_collaborators ADD CONSTRAINT canvas_collaborators_role_check CHECK (role IN ('viewer', 'commenter', 'editor'));
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'canvas_channel_grants_role_check' AND pg_get_constraintdef(oid) NOT LIKE '%commenter%') THEN
    ALTER TABLE canvas_channel_grants DROP CONSTRAINT canvas_channel_grants_role_check;
    ALTER TABLE canvas_channel_grants ADD CONSTRAINT canvas_channel_grants_role_check CHECK (role IN ('viewer', 'commenter', 'editor'));
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
