# IT Avenue Workspace - Database

PostgreSQL initialization scripts.

## Schema

The `init.sql` file creates:

- **users** - User accounts with hashed passwords
- **channels** - Public/private channels
- **channel_members** - Channel membership
- **channel_read_at** - Per-user per-channel last-read timestamp (unread badges)
- **messages** - Channel messages with reply threading
- **direct_messages** - 1:1 direct messages
- **reactions** - Emoji reactions on messages
- **files** - File attachment metadata (`message_id` for channel messages, `dm_message_id` for DMs)
- **notes** - Per-user notes (title, content, created_at, updated_at)

## Seed Data

Default channels seeded on first run:
- `#general` - Company-wide announcements
- `#random` - Non-work banter
- `#dev` - Engineering discussion
- `#announcements` - Official announcements

## Running

The schema is automatically applied when the PostgreSQL container starts
(via `docker-entrypoint-initdb.d` in docker-compose).
