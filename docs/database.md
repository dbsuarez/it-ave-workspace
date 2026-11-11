# IT Avenue Workspace - Database

PostgreSQL initialization scripts.

## Schema

The `init.sql` file creates:

- **users** - User accounts with hashed passwords, avatar colors, token versions, and a
  Superadmin flag
- **channels** - Public/private channels with per-channel slow-mode settings
- **channel_members** - Channel membership, member/moderator role, and slow-mode send timestamps
- **channel_read_at** - Per-user per-channel last-read timestamp (unread badges)
- **messages** - Channel messages with inline replies and pin metadata
- **direct_messages** - 1:1 direct messages
- **reactions** - Emoji reactions on messages
- **files** - File attachment metadata (`message_id` for channel messages, `dm_message_id` for DMs, `canvas_id` for an image inside a canvas, deleted with it; comments live in `canvas_comments`; personal canvases have `deleted_at`/`deleted_by` while in the trash; `users.job_title` is shown on profile cards; `users.department`, `location`, `manager_id` and `profile` (JSONB) hold the employee page and org chart; `users.photo_file` and `photo_updated_at` hold the profile photo; `canvas_mentions` records canvas mentions and comment replies for Activity)
- **notes** - Per-user notes (title, content, created_at, updated_at)
- **channel_lists** - Channel-shared lists: title, description, `todo_mode`, creator metadata
- **list_columns** - A list's typed columns (`text`, `checkbox`, `date`, `user`, `select`, `number`,
  `link`) with `options` (JSON), a stable `key`, and exactly one `is_primary` text column per list
- **list_rows** / **list_cells** - Rows (with `parent_row_id`, `archived_at`, who and when) and one
  JSON value per row and column. A missing cell is an empty cell
- **channel_list_items** - The old fixed-column items. Frozen after the one-time move into rows
  (row ids equal the old item ids); kept as a safety copy and no longer written
- **schema_markers** - Names of one-off data migrations that have already run
- **channel_canvases** - Channel-shared Markdown documents and creator metadata
- **moderation_settings** - Workspace default and maximum timeout durations
- **channel_timeouts** - Expiring channel-scoped user timeouts
- **message_reports** - User reports and moderator resolution state
- **moderation_audit_log** - Append-only record of moderation actions
- **message_mentions** - Who was mentioned in which channel message
- **message_edits** - Earlier versions of edited messages
- **conversations**, **conversation_members**, **conversation_messages** - Group direct messages
- **saved_items** - Per-user saved messages and files
- **reminders** - Per-user reminders, optionally linked to a message
- **scheduled_messages** - Messages waiting to be sent to a channel or a person
- **invitations** - Single-use sign-up codes (stored as hashes) with account type and channels
- **channel_links** - Shared web links shown in a channel's Links tab
- **user_groups**, **user_group_members** - Mentionable groups of people
- **webhooks** - Incoming webhook addresses (stored as hashes) and their bot accounts

Added columns: `users.account_type` (`member`, `guest`, or `bot`), `users.notification_prefs`,
`users.dnd_until`, `users.status_text`, `users.status_emoji`, `users.activity_seen_at`,
`users.sidebar_layout`, and `moderation_settings.registration_mode` (`open` or `invite`).

New schema is defined once in `backend/src/migrations.js` (applied at startup, idempotent) and
repeated at the end of `init.sql` for fresh databases.

## Seed Data

Default channels seeded on first run:
- `#general` - Company-wide announcements
- `#random` - Non-work banter
- `#dev` - Engineering discussion
- `#announcements` - Official announcements

## Running

The schema is automatically applied when the PostgreSQL container starts
(via `docker-entrypoint-initdb.d` in docker-compose).
The backend also idempotently adds `users.token_version` and message pin columns at startup
for older databases, and creates the channel list and canvas tables and indexes for existing
databases. It also applies moderation table/column migrations and indexes. Set
`SUPERADMIN_USERNAME` and explicitly run the backend `bootstrap:superadmin` command to grant
the role to an existing account; registration itself never elevates an account.
