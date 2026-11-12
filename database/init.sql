-- IT Avenue Workspace Database Schema
-- Run once on first deploy (or via docker-entrypoint-initdb.d)

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username VARCHAR(50) UNIQUE NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  token_version INTEGER NOT NULL DEFAULT 0,
  is_superadmin BOOLEAN NOT NULL DEFAULT FALSE,
  avatar_color VARCHAR(20) DEFAULT '#6B21A8',
  status VARCHAR(20) DEFAULT 'online',
  last_seen TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS channels (
  id SERIAL PRIMARY KEY,
  name VARCHAR(50) UNIQUE NOT NULL,
  topic TEXT DEFAULT '',
  is_private BOOLEAN DEFAULT FALSE,
  created_by INTEGER REFERENCES users(id),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  slowmode_seconds INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS channel_members (
  channel_id INTEGER REFERENCES channels(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  joined_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  role VARCHAR(20) NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'moderator')),
  last_message_at TIMESTAMP WITH TIME ZONE,
  PRIMARY KEY (channel_id, user_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id SERIAL PRIMARY KEY,
  channel_id INTEGER REFERENCES channels(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  reply_to INTEGER REFERENCES messages(id),
  edited_at TIMESTAMP WITH TIME ZONE,
  pinned_at TIMESTAMP WITH TIME ZONE,
  pinned_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_messages_pinned_channel
  ON messages(channel_id, pinned_at DESC)
  WHERE pinned_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS direct_messages (
  id SERIAL PRIMARY KEY,
  sender_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  receiver_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS reactions (
  id SERIAL PRIMARY KEY,
  message_id INTEGER REFERENCES messages(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  emoji VARCHAR(10) NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(message_id, user_id, emoji)
);

-- Unread tracking: per-user, per-channel last-read timestamp
CREATE TABLE IF NOT EXISTS channel_read_at (
  channel_id INTEGER REFERENCES channels(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  read_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  PRIMARY KEY (channel_id, user_id)
);

-- Read receipts for the newest message seen in a channel
CREATE TABLE IF NOT EXISTS message_read_receipts (
  message_id INTEGER REFERENCES messages(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  read_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  PRIMARY KEY (message_id, user_id)
);

-- User notes (scratchpads)
CREATE TABLE IF NOT EXISTS notes (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  title VARCHAR(200) NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_notes_user_id ON notes(user_id);

-- Lists are shared by members of a channel.
CREATE TABLE IF NOT EXISTS channel_lists (
  id SERIAL PRIMARY KEY,
  channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  title VARCHAR(120) NOT NULL,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

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
);
CREATE INDEX IF NOT EXISTS idx_channel_lists_channel_id ON channel_lists(channel_id);
CREATE INDEX IF NOT EXISTS idx_channel_list_items_list_id ON channel_list_items(list_id);

-- Saved Markdown documents shared by channel members.
CREATE TABLE IF NOT EXISTS channel_canvases (
  id SERIAL PRIMARY KEY,
  channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  title VARCHAR(120) NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_channel_canvases_channel_id ON channel_canvases(channel_id);

CREATE TABLE IF NOT EXISTS moderation_settings (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  default_timeout_minutes INTEGER NOT NULL DEFAULT 5 CHECK (default_timeout_minutes BETWEEN 1 AND 10080),
  max_timeout_minutes INTEGER NOT NULL DEFAULT 10080 CHECK (max_timeout_minutes BETWEEN 1 AND 10080),
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  CHECK (default_timeout_minutes <= max_timeout_minutes)
);

INSERT INTO moderation_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS channel_timeouts (
  id SERIAL PRIMARY KEY,
  channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  moderator_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reason VARCHAR(500) NOT NULL DEFAULT '',
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE (channel_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_channel_timeouts_active
  ON channel_timeouts(channel_id, user_id, expires_at DESC);

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
);
CREATE INDEX IF NOT EXISTS idx_message_reports_queue
  ON message_reports(channel_id, status, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_message_reports_open_reporter
  ON message_reports(message_id, reporter_id) WHERE status = 'open' AND reporter_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS moderation_audit_log (
  id BIGSERIAL PRIMARY KEY,
  channel_id INTEGER REFERENCES channels(id) ON DELETE SET NULL,
  actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  target_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action VARCHAR(50) NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_moderation_audit_channel_created
  ON moderation_audit_log(channel_id, created_at DESC);

CREATE TABLE IF NOT EXISTS files (
  id SERIAL PRIMARY KEY,
  message_id INTEGER REFERENCES messages(id) ON DELETE CASCADE,
  dm_message_id INTEGER REFERENCES direct_messages(id) ON DELETE CASCADE,
  filename VARCHAR(255) NOT NULL,
  original_name VARCHAR(255) NOT NULL,
  size INTEGER NOT NULL,
  mime_type VARCHAR(100),
  uploaded_by INTEGER REFERENCES users(id),
  uploaded_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_messages_channel_id ON messages(channel_id);
CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
CREATE INDEX IF NOT EXISTS idx_messages_reply_to ON messages(reply_to);
CREATE INDEX IF NOT EXISTS idx_channel_members_user_id ON channel_members(user_id);
CREATE INDEX IF NOT EXISTS idx_direct_messages_sender ON direct_messages(sender_id);
CREATE INDEX IF NOT EXISTS idx_direct_messages_receiver ON direct_messages(receiver_id);
CREATE INDEX IF NOT EXISTS idx_reactions_message_id ON reactions(message_id);
CREATE INDEX IF NOT EXISTS idx_files_message_id ON files(message_id);
CREATE INDEX IF NOT EXISTS idx_message_read_receipts_message_id ON message_read_receipts(message_id);
CREATE INDEX IF NOT EXISTS idx_message_read_receipts_user_id ON message_read_receipts(user_id);

-- Seed data: default channels (created_by left NULL - admin user is created on first registration)
INSERT INTO channels (name, topic, created_by)
SELECT 'general', 'Company-wide announcements and general chat', NULL
WHERE NOT EXISTS (SELECT 1 FROM channels WHERE name = 'general');

INSERT INTO channels (name, topic, created_by)
SELECT 'random', 'Non-work banter and fun', NULL
WHERE NOT EXISTS (SELECT 1 FROM channels WHERE name = 'random');

INSERT INTO channels (name, topic, created_by)
SELECT 'dev', 'Engineering discussion and code review', NULL
WHERE NOT EXISTS (SELECT 1 FROM channels WHERE name = 'dev');

INSERT INTO channels (name, topic, created_by)
SELECT 'announcements', 'Official company announcements', NULL
WHERE NOT EXISTS (SELECT 1 FROM channels WHERE name = 'announcements');

-- Mentions and the activity feed (also applied by backend/src/migrations.js)
CREATE TABLE IF NOT EXISTS message_mentions (
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  PRIMARY KEY (message_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_message_mentions_user ON message_mentions(user_id, created_at DESC);
ALTER TABLE users ADD COLUMN IF NOT EXISTS activity_seen_at TIMESTAMP WITH TIME ZONE;
CREATE INDEX IF NOT EXISTS idx_messages_reply_to ON messages(reply_to) WHERE reply_to IS NOT NULL;

-- Notification preferences, Do Not Disturb, and custom status
ALTER TABLE users ADD COLUMN IF NOT EXISTS notification_prefs JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE users ADD COLUMN IF NOT EXISTS dnd_until TIMESTAMP WITH TIME ZONE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS status_text VARCHAR(100) NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS status_emoji VARCHAR(16) NOT NULL DEFAULT '';

-- Group direct messages
CREATE TABLE IF NOT EXISTS conversations (
  id SERIAL PRIMARY KEY,
  name VARCHAR(80) NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS conversation_members (
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  last_read_at TIMESTAMP WITH TIME ZONE,
  PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_conversation_members_user ON conversation_members(user_id);
CREATE TABLE IF NOT EXISTS conversation_messages (
  id SERIAL PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_conversation_messages_conversation ON conversation_messages(conversation_id, created_at);

-- Message edit history, saved items, and reminders
CREATE TABLE IF NOT EXISTS message_edits (
     id SERIAL PRIMARY KEY,
     message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
     previous_content TEXT NOT NULL,
     edited_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
     edited_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
   );
CREATE INDEX IF NOT EXISTS idx_message_edits_message ON message_edits(message_id, edited_at DESC);
CREATE TABLE IF NOT EXISTS saved_items (
     id SERIAL PRIMARY KEY,
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     message_id INTEGER REFERENCES messages(id) ON DELETE CASCADE,
     file_id INTEGER REFERENCES files(id) ON DELETE CASCADE,
     created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
     CHECK ((message_id IS NULL) <> (file_id IS NULL))
   );
CREATE INDEX IF NOT EXISTS idx_saved_items_user ON saved_items(user_id, created_at DESC);
CREATE TABLE IF NOT EXISTS reminders (
     id SERIAL PRIMARY KEY,
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     text VARCHAR(500) NOT NULL DEFAULT '',
     message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
     remind_at TIMESTAMP WITH TIME ZONE NOT NULL,
     delivered_at TIMESTAMP WITH TIME ZONE,
     created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
   );
CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders(remind_at) WHERE delivered_at IS NULL;

-- Guest accounts and invitations
ALTER TABLE users ADD COLUMN IF NOT EXISTS account_type VARCHAR(20) NOT NULL DEFAULT 'member';
ALTER TABLE moderation_settings ADD COLUMN IF NOT EXISTS registration_mode VARCHAR(20) NOT NULL DEFAULT 'open';
CREATE TABLE IF NOT EXISTS invitations (
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
   );

-- Scheduled messages, personal sidebar sections, and channel links
CREATE TABLE IF NOT EXISTS scheduled_messages (
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
   );
CREATE INDEX IF NOT EXISTS idx_scheduled_messages_due ON scheduled_messages(send_at) WHERE sent_at IS NULL AND failed_at IS NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS sidebar_layout JSONB NOT NULL DEFAULT '{}'::jsonb;
CREATE TABLE IF NOT EXISTS channel_links (
     id SERIAL PRIMARY KEY,
     channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
     title VARCHAR(120) NOT NULL,
     url VARCHAR(2000) NOT NULL,
     created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
     created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
   );
CREATE INDEX IF NOT EXISTS idx_channel_links_channel ON channel_links(channel_id, created_at);

-- User groups and incoming webhooks
CREATE TABLE IF NOT EXISTS user_groups (
     id SERIAL PRIMARY KEY,
     handle VARCHAR(31) NOT NULL UNIQUE,
     name VARCHAR(80) NOT NULL,
     created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
     created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
   );
CREATE TABLE IF NOT EXISTS user_group_members (
     group_id INTEGER NOT NULL REFERENCES user_groups(id) ON DELETE CASCADE,
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     PRIMARY KEY (group_id, user_id)
   );
CREATE TABLE IF NOT EXISTS webhooks (
     id SERIAL PRIMARY KEY,
     channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
     name VARCHAR(40) NOT NULL,
     token_hash VARCHAR(64) NOT NULL UNIQUE,
     bot_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
     created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
     created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
     last_used_at TIMESTAMP WITH TIME ZONE
   );

-- Canvas 2.0: channel, DM and standalone rich-text documents.
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
     revision INTEGER NOT NULL DEFAULT 1,
     owner_id INTEGER NULL REFERENCES users(id) ON DELETE SET NULL,
     CHECK (
         (kind = 'channel' AND channel_id IS NOT NULL)
       OR (kind = 'dm' AND dm_user_low IS NOT NULL AND dm_user_high IS NOT NULL)
       OR (kind = 'standalone' AND channel_id IS NULL AND dm_user_low IS NULL AND dm_user_high IS NULL)
     ),
     CHECK (dm_user_low IS NULL OR dm_user_low < dm_user_high)
   );
CREATE UNIQUE INDEX IF NOT EXISTS idx_canvases_channel ON canvases(channel_id) WHERE kind = 'channel';
CREATE UNIQUE INDEX IF NOT EXISTS idx_canvases_dm ON canvases(dm_user_low, dm_user_high) WHERE kind = 'dm';

CREATE TABLE IF NOT EXISTS canvas_collaborators (
     canvas_id INTEGER NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     role VARCHAR(16) NOT NULL DEFAULT 'editor' CHECK (role IN ('viewer', 'commenter', 'editor')),
     granted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
     created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
     PRIMARY KEY (canvas_id, user_id)
   );

CREATE TABLE IF NOT EXISTS canvas_shares (
     id SERIAL PRIMARY KEY,
     canvas_id INTEGER NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
     token VARCHAR(64) NOT NULL UNIQUE,
     role VARCHAR(16) NOT NULL DEFAULT 'editor' CHECK (role IN ('viewer', 'editor')),
     created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
     created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
     expires_at TIMESTAMP WITH TIME ZONE
   );
CREATE INDEX IF NOT EXISTS idx_canvas_shares_token ON canvas_shares(token);

CREATE TABLE IF NOT EXISTS canvas_channel_grants (
     canvas_id INTEGER NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
     channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
     role VARCHAR(16) NOT NULL DEFAULT 'viewer' CHECK (role IN ('viewer', 'commenter', 'editor')),
     granted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
     created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
     PRIMARY KEY (canvas_id, channel_id)
   );
CREATE INDEX IF NOT EXISTS idx_canvas_channel_grants_channel ON canvas_channel_grants(channel_id);

-- Lists as typed tables (see REAGHIDRA/05); mirrors backend/src/migrations.js.
ALTER TABLE channel_lists ADD COLUMN IF NOT EXISTS todo_mode BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE channel_lists ADD COLUMN IF NOT EXISTS description VARCHAR(500) NOT NULL DEFAULT '';
ALTER TABLE channel_lists ADD COLUMN IF NOT EXISTS archived_at TIMESTAMP WITH TIME ZONE;
CREATE TABLE IF NOT EXISTS list_columns (
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
   );
CREATE UNIQUE INDEX IF NOT EXISTS idx_list_columns_one_primary ON list_columns(list_id) WHERE is_primary;
CREATE TABLE IF NOT EXISTS list_rows (
     id SERIAL PRIMARY KEY,
     list_id INTEGER NOT NULL REFERENCES channel_lists(id) ON DELETE CASCADE,
     parent_row_id INTEGER REFERENCES list_rows(id) ON DELETE CASCADE,
     position INTEGER NOT NULL DEFAULT 0,
     archived_at TIMESTAMP WITH TIME ZONE,
     created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
     updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
     created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
     updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
   );
CREATE INDEX IF NOT EXISTS idx_list_rows_list ON list_rows(list_id, position, id);
CREATE TABLE IF NOT EXISTS list_cells (
     row_id INTEGER NOT NULL REFERENCES list_rows(id) ON DELETE CASCADE,
     column_id INTEGER NOT NULL REFERENCES list_columns(id) ON DELETE CASCADE,
     value JSONB NOT NULL,
     PRIMARY KEY (row_id, column_id)
   );
CREATE INDEX IF NOT EXISTS idx_list_cells_column ON list_cells(column_id);
CREATE TABLE IF NOT EXISTS schema_markers (
     name VARCHAR(80) PRIMARY KEY,
     applied_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
   );
DO $$
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
$$;

-- Canvas mentions and comment replies (Activity feed); mirrors backend/src/migrations.js.
CREATE TABLE IF NOT EXISTS canvas_mentions (
  id SERIAL PRIMARY KEY,
  canvas_id INTEGER NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  source VARCHAR(12) NOT NULL,
  snippet TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_canvas_mentions_user ON canvas_mentions(user_id, created_at DESC);

-- Employee pages and the org chart; mirrors backend/src/migrations.js.
ALTER TABLE users ADD COLUMN IF NOT EXISTS department VARCHAR(100) NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS location VARCHAR(100) NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS manager_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS profile JSONB NOT NULL DEFAULT '{}'::jsonb;
CREATE INDEX IF NOT EXISTS idx_users_manager ON users(manager_id) WHERE manager_id IS NOT NULL;
ALTER TABLE moderation_settings ADD COLUMN IF NOT EXISTS prelaunch_password BOOLEAN NOT NULL DEFAULT false;
-- Employee management; mirrors backend/src/migrations.js.
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_hr BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS employee_no VARCHAR(40);
ALTER TABLE users ADD COLUMN IF NOT EXISTS hire_date DATE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS separation_date DATE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS employment_status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (employment_status IN ('active', 'on_leave', 'resigned'));
ALTER TABLE users ADD COLUMN IF NOT EXISTS employment_type VARCHAR(20) NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS deactivated_at TIMESTAMP WITH TIME ZONE;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_employee_no ON users (LOWER(employee_no)) WHERE employee_no IS NOT NULL;
CREATE TABLE IF NOT EXISTS departments (
     id SERIAL PRIMARY KEY,
     name VARCHAR(100) NOT NULL,
     head_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
     created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
   );
CREATE UNIQUE INDEX IF NOT EXISTS idx_departments_name ON departments (LOWER(name));
ALTER TABLE users ADD COLUMN IF NOT EXISTS department_id INTEGER REFERENCES departments(id) ON DELETE SET NULL;
INSERT INTO departments (name) SELECT DISTINCT ON (LOWER(department)) department FROM users WHERE department <> '' ON CONFLICT DO NOTHING;
UPDATE users u SET department_id = d.id FROM departments d WHERE u.department_id IS NULL AND u.department <> '' AND LOWER(u.department) = LOWER(d.name);
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_name VARCHAR(100) NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS first_name VARCHAR(100) NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS middle_name VARCHAR(100) NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS user_secondary_managers (
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     manager_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     position SMALLINT NOT NULL DEFAULT 0,
     PRIMARY KEY (user_id, manager_id),
     CHECK (user_id <> manager_id)
   );
CREATE INDEX IF NOT EXISTS idx_secondary_managers_manager ON user_secondary_managers(manager_id);

-- Profile photo; mirrors backend/src/migrations.js.
ALTER TABLE users ADD COLUMN IF NOT EXISTS photo_file VARCHAR(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS photo_updated_at TIMESTAMP WITH TIME ZONE;

-- Job title on profiles; mirrors backend/src/migrations.js.
ALTER TABLE users ADD COLUMN IF NOT EXISTS job_title VARCHAR(100) NOT NULL DEFAULT '';

-- Trash for personal canvases; mirrors backend/src/migrations.js.
ALTER TABLE canvases ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE canvases ADD COLUMN IF NOT EXISTS deleted_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_canvases_deleted_at ON canvases(deleted_at) WHERE deleted_at IS NOT NULL;

-- Comment threads on a canvas; mirrors backend/src/migrations.js.
CREATE TABLE IF NOT EXISTS canvas_comments (
  id SERIAL PRIMARY KEY,
  canvas_id INTEGER NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
  parent_id INTEGER REFERENCES canvas_comments(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  body TEXT NOT NULL,
  anchor TEXT,
  resolved_at TIMESTAMP WITH TIME ZONE,
  resolved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_canvas_comments_canvas ON canvas_comments(canvas_id, created_at);

-- Images inside a canvas; mirrors backend/src/migrations.js.
ALTER TABLE files ADD COLUMN IF NOT EXISTS canvas_id INTEGER REFERENCES canvases(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_files_canvas_id ON files(canvas_id);

-- Canvas history; mirrors backend/src/migrations.js.
CREATE TABLE IF NOT EXISTS canvas_revisions (
     id SERIAL PRIMARY KEY,
     canvas_id INTEGER NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
     revision INTEGER NOT NULL,
     title VARCHAR(160) NOT NULL,
     content TEXT NOT NULL,
     edited_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
     edited_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
     UNIQUE (canvas_id, revision)
   );

-- Onboarding and offboarding checklists; mirrors backend/src/migrations.js.
CREATE TABLE IF NOT EXISTS hr_task_templates (
     id SERIAL PRIMARY KEY,
     kind VARCHAR(12) NOT NULL CHECK (kind IN ('onboarding', 'offboarding')),
     title VARCHAR(160) NOT NULL,
     position INTEGER NOT NULL DEFAULT 0
   );
CREATE TABLE IF NOT EXISTS employee_tasks (
     id SERIAL PRIMARY KEY,
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     kind VARCHAR(12) NOT NULL CHECK (kind IN ('onboarding', 'offboarding')),
     title VARCHAR(160) NOT NULL,
     position INTEGER NOT NULL DEFAULT 0,
     done_at TIMESTAMP WITH TIME ZONE,
     done_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
     created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
   );
CREATE INDEX IF NOT EXISTS idx_employee_tasks_user ON employee_tasks(user_id, kind, position);
INSERT INTO hr_task_templates (kind, title, position)
   SELECT v.kind, v.title, v.position FROM (VALUES
     ('onboarding', 'Create the email account', 1), ('onboarding', 'Issue laptop and equipment', 2),
     ('onboarding', 'Sign the employment contract', 3), ('onboarding', 'Introduce them to the team', 4),
     ('offboarding', 'Collect laptop and equipment', 1), ('offboarding', 'Remove system access', 2),
     ('offboarding', 'Exit interview', 3), ('offboarding', 'Compute the final pay', 4)
   ) AS v(kind, title, position)
   WHERE NOT EXISTS (SELECT 1 FROM schema_markers WHERE name = 'hr_task_templates_v1');
INSERT INTO schema_markers (name) VALUES ('hr_task_templates_v1') ON CONFLICT DO NOTHING;

-- Leave; mirrors backend/src/migrations.js.
CREATE TABLE IF NOT EXISTS leave_types (
     id SERIAL PRIMARY KEY,
     name VARCHAR(60) NOT NULL,
     days_per_year NUMERIC(5,1) NOT NULL DEFAULT 0 CHECK (days_per_year >= 0),
     paid BOOLEAN NOT NULL DEFAULT true,
     active BOOLEAN NOT NULL DEFAULT true,
     position INTEGER NOT NULL DEFAULT 0
   );
CREATE UNIQUE INDEX IF NOT EXISTS idx_leave_types_name ON leave_types (LOWER(name));
CREATE TABLE IF NOT EXISTS leave_entitlements (
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     leave_type_id INTEGER NOT NULL REFERENCES leave_types(id) ON DELETE CASCADE,
     year SMALLINT NOT NULL,
     adjustment NUMERIC(5,1) NOT NULL DEFAULT 0,
     PRIMARY KEY (user_id, leave_type_id, year)
   );
CREATE TABLE IF NOT EXISTS leave_requests (
     id SERIAL PRIMARY KEY,
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     leave_type_id INTEGER NOT NULL REFERENCES leave_types(id) ON DELETE RESTRICT,
     start_date DATE NOT NULL,
     end_date DATE NOT NULL,
     days NUMERIC(4,1) NOT NULL,
     half_day BOOLEAN NOT NULL DEFAULT false,
     reason VARCHAR(500) NOT NULL DEFAULT '',
     status VARCHAR(12) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
     decided_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
     decided_at TIMESTAMP WITH TIME ZONE,
     decision_note VARCHAR(300) NOT NULL DEFAULT '',
     created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
     CHECK (end_date >= start_date)
   );
CREATE INDEX IF NOT EXISTS idx_leave_requests_user ON leave_requests(user_id, start_date);
CREATE INDEX IF NOT EXISTS idx_leave_requests_status ON leave_requests(status, start_date);
CREATE TABLE IF NOT EXISTS company_holidays (
     day DATE PRIMARY KEY,
     name VARCHAR(100) NOT NULL
   );
INSERT INTO leave_types (name, days_per_year, paid, position)
   SELECT v.name, v.days, v.paid, v.position FROM (VALUES
     ('Vacation Leave', 15, true, 1), ('Sick Leave', 10, true, 2), ('Emergency Leave', 3, true, 3), ('Unpaid Leave', 0, false, 4)
   ) AS v(name, days, paid, position)
   WHERE NOT EXISTS (SELECT 1 FROM schema_markers WHERE name = 'leave_types_v1');
INSERT INTO schema_markers (name) VALUES ('leave_types_v1') ON CONFLICT DO NOTHING;

-- Attendance; mirrors backend/src/migrations.js.
CREATE TABLE IF NOT EXISTS work_schedules (
     id SERIAL PRIMARY KEY,
     name VARCHAR(60) NOT NULL,
     start_time TIME NOT NULL,
     end_time TIME NOT NULL,
     break_minutes SMALLINT NOT NULL DEFAULT 60 CHECK (break_minutes BETWEEN 0 AND 240),
     grace_minutes SMALLINT NOT NULL DEFAULT 10 CHECK (grace_minutes BETWEEN 0 AND 120),
     overtime_min_minutes SMALLINT NOT NULL DEFAULT 30 CHECK (overtime_min_minutes BETWEEN 0 AND 240),
     work_days SMALLINT[] NOT NULL DEFAULT '{1,2,3,4,5}',
     is_default BOOLEAN NOT NULL DEFAULT false
   );
CREATE UNIQUE INDEX IF NOT EXISTS idx_work_schedules_name ON work_schedules (LOWER(name));
CREATE UNIQUE INDEX IF NOT EXISTS idx_work_schedules_default ON work_schedules (is_default) WHERE is_default;
INSERT INTO work_schedules (name, start_time, end_time, is_default)
   SELECT 'Regular (8:00 to 17:00)', '08:00', '17:00', true
   WHERE NOT EXISTS (SELECT 1 FROM schema_markers WHERE name = 'work_schedule_v1');
INSERT INTO schema_markers (name) VALUES ('work_schedule_v1') ON CONFLICT DO NOTHING;
ALTER TABLE users ADD COLUMN IF NOT EXISTS schedule_id INTEGER REFERENCES work_schedules(id) ON DELETE SET NULL;
CREATE TABLE IF NOT EXISTS attendance_records (
     id SERIAL PRIMARY KEY,
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     work_date DATE NOT NULL,
     source VARCHAR(10) NOT NULL DEFAULT 'self' CHECK (source IN ('self', 'hr', 'correction')),
     note VARCHAR(200) NOT NULL DEFAULT '',
     edited_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
     created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
     UNIQUE (user_id, work_date)
   );
CREATE INDEX IF NOT EXISTS idx_attendance_date ON attendance_records(work_date);

-- Attendance v2; mirrors backend/src/migrations.js.
CREATE TABLE IF NOT EXISTS attendance_punches (
     id SERIAL PRIMARY KEY,
     record_id INTEGER NOT NULL REFERENCES attendance_records(id) ON DELETE CASCADE,
     clock_in TIMESTAMP WITH TIME ZONE NOT NULL,
     clock_out TIMESTAMP WITH TIME ZONE,
     in_ip VARCHAR(64) NOT NULL DEFAULT '',
     out_ip VARCHAR(64) NOT NULL DEFAULT '',
     in_device VARCHAR(64) NOT NULL DEFAULT '',
     out_device VARCHAR(64) NOT NULL DEFAULT '',
     CHECK (clock_out IS NULL OR clock_out >= clock_in)
   );
CREATE INDEX IF NOT EXISTS idx_attendance_punches_record ON attendance_punches(record_id, clock_in);
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'attendance_records' AND column_name = 'clock_in') THEN
    INSERT INTO attendance_punches (record_id, clock_in, clock_out) SELECT id, clock_in, clock_out FROM attendance_records;
    ALTER TABLE attendance_records DROP COLUMN clock_in;
    ALTER TABLE attendance_records DROP COLUMN clock_out;
    ALTER TABLE attendance_records DROP CONSTRAINT IF EXISTS attendance_records_source_check;
    ALTER TABLE attendance_records ALTER COLUMN source TYPE VARCHAR(10);
    ALTER TABLE attendance_records ADD CONSTRAINT attendance_records_source_check CHECK (source IN ('self', 'hr', 'correction'));
  END IF;
END
$$;
ALTER TABLE users ADD COLUMN IF NOT EXISTS job_level VARCHAR(16) NOT NULL DEFAULT 'rank_and_file' CHECK (job_level IN ('rank_and_file', 'managerial'));
ALTER TABLE users ADD COLUMN IF NOT EXISTS remote_clock BOOLEAN NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS attendance_networks (
     id SERIAL PRIMARY KEY,
     label VARCHAR(80) NOT NULL,
     cidr VARCHAR(64) NOT NULL UNIQUE
   );
CREATE TABLE IF NOT EXISTS attendance_settings (
     id INTEGER PRIMARY KEY CHECK (id = 1),
     network_only BOOLEAN NOT NULL DEFAULT false
   );
INSERT INTO attendance_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
CREATE TABLE IF NOT EXISTS user_devices (
     id SERIAL PRIMARY KEY,
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     device_id VARCHAR(64) NOT NULL,
     name VARCHAR(120) NOT NULL DEFAULT '',
     first_seen TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
     last_seen TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
     trusted BOOLEAN NOT NULL DEFAULT false,
     trusted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
     UNIQUE (user_id, device_id)
   );
CREATE TABLE IF NOT EXISTS attendance_corrections (
     id SERIAL PRIMARY KEY,
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     work_date DATE NOT NULL,
     punches JSONB NOT NULL,
     reason VARCHAR(300) NOT NULL,
     status VARCHAR(12) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
     decided_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
     decided_at TIMESTAMP WITH TIME ZONE,
     decision_note VARCHAR(300) NOT NULL DEFAULT '',
     created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
   );
CREATE INDEX IF NOT EXISTS idx_attendance_corrections_status ON attendance_corrections(status, work_date);
