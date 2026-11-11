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
- **files** - File attachment metadata (`message_id` for channel messages, `dm_message_id` for DMs)
- **notes** - Per-user notes (title, content, created_at, updated_at)
- **channel_lists** - Channel-shared checklist names and creator metadata
- **channel_list_items** - Checklist titles, completion state, optional channel-member
  assignees, optional due dates, and creator metadata
- **channel_canvases** - Channel-shared Markdown documents and creator metadata
- **moderation_settings** - Workspace default and maximum timeout durations
- **channel_timeouts** - Expiring channel-scoped user timeouts
- **message_reports** - User reports and moderator resolution state
- **moderation_audit_log** - Append-only record of moderation actions

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
