# IT Avenue Workspace - Backend

Node.js + Express + Socket.io API server with PostgreSQL.

## Stack

- **Express** - REST API
- **Socket.io** - Real-time messaging (WebSockets)
- **PostgreSQL** - Database (via `pg`)
- **bcryptjs** - Password hashing
- **jsonwebtoken** - JWT authentication
- **dotenv** - Environment configuration

## Endpoints

### Auth
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/auth/register` | Register a new user |
| POST | `/api/auth/login` | Login and receive JWT |
| GET | `/api/auth/me` | Get current user profile (requires auth) |
| PATCH | `/api/auth/me` | Update username and avatar color |
| PUT | `/api/auth/me/account` | Verify current password to update email or password |

### Channels
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/channels` | List all channels |
| GET | `/api/channels/my` | List channels current user belongs to |
| POST | `/api/channels` | Create a new channel |
| GET | `/api/channels/:id` | Get channel details |
| POST | `/api/channels/:id/join` | Join a channel |

### Messages
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/messages/:channelId` | Get paginated channel messages, including inline reply previews |
| GET | `/api/messages/:channelId/pins` | List pinned channel messages; requires channel membership |
| GET | `/api/messages/:channelId/context/:messageId` | Get the page offset containing a channel message |
| GET | `/api/messages/:channelId/threads/:messageId` | Legacy thread-replies endpoint |
| PATCH | `/api/messages/:messageId/pin` | Pin or unpin a channel message (`pinned: boolean`) |
| POST | `/api/messages/:messageId/reactions` | Add/remove a single Unicode emoji reaction |
| POST | `/api/messages/upload` | Upload a file attachment (multipart `file`) |
| GET | `/api/search?q=...` | Search accessible channel messages, DMs, people, and files |

### Files
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/files` | List files attached to messages the user can see |
| GET | `/api/files/:id/download` | Download the stored file |
| DELETE | `/api/files/:id` | Permanently delete an attachment uploaded by the current user, or let a channel moderator remove a channel attachment with a required `reason` (1-500 characters); notifies its channel or DM participants |

### Notes
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/notes` | List the current user's notes |
| POST | `/api/notes` | Create a note (`title`, `content`) |
| PUT | `/api/notes/:id` | Update a note (`title`, `content`) |
| DELETE | `/api/notes/:id` | Delete a note |

### Lists
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/lists?channelId=:id` | List shared checklists and channel members |
| POST | `/api/lists` | Create a channel checklist |
| PATCH | `/api/lists/:listId` | Rename a checklist |
| DELETE | `/api/lists/:listId` | Delete a checklist and its items |
| POST | `/api/lists/:listId/items` | Add an item with optional channel-member assignee and due date |
| PATCH | `/api/lists/:listId/items/:itemId` | Update item title, completion, assignee, or due date |
| DELETE | `/api/lists/:listId/items/:itemId` | Delete a checklist item |

Every list operation requires current channel membership. Assignees must also belong to
the list's channel.

### Canvases
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/canvases?channelId=:id` | List saved canvases in a channel |
| GET | `/api/canvases/:canvasId` | Read a saved Markdown document |
| POST | `/api/canvases` | Create a channel-shared document |
| PUT | `/api/canvases/:canvasId` | Save document title and Markdown content |
| DELETE | `/api/canvases/:canvasId` | Delete a document |

Canvas content is limited to 100,000 characters. Every operation requires current
channel membership.

### Canvas 2.0 (`/api/canvas`)
Channel canvas (one per channel), DM canvas (one per pair), and standalone canvases with
collaborators and share links. Reads and writes are gated by role (`ensureCanvasAccess`).

**Revisions (no silent overwrites).** Every canvas has an integer `revision`, starting at 1 and
increased by every save. `PATCH /api/canvas/:id` and `PATCH /api/canvas/share/:token` accept an
optional `baseRevision`: the revision the editor was based on. The save is one conditional
`UPDATE ... WHERE revision = baseRevision`, so of several simultaneous saves from the same
revision exactly one wins. The rest get **HTTP 409** with `{ code: 'revision_conflict', canvas }`
(the current version) and nothing is written. A client that omits `baseRevision` still works and
overwrites (last write wins), which keeps older installs functional. A malformed `baseRevision`
is a 400. The `canvas_updated` socket event carries `revision`, `title` and `content`.
The desktop client applies a live update only when the editor has no unsaved edits, and on a 409
asks "keep my version / use theirs" (copying its own text to the clipboard before discarding it).

**Sections and edit operations** (`src/canvasSections.js`). A section is a top-level Markdown block:
`heading`, `paragraph`, `list`, `checklist` (`- [ ]` / `- [x]`), `table`, `code` (fences keep blank
lines and `#` inside), `quote`, `divider`. Blocks are located by exact character offsets, so an
edit splices only the block it touches (line endings, including CRLF, are preserved).

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/canvas/:id/sections?type=&contains=` | Blocks as `{ id, index, type, preview, items? }` plus the `revision` they belong to (viewer access) |
| PATCH | `/api/canvas/:id` with `{ operation, baseRevision }` | Apply ONE operation (editor access) |

**Ownership and channel grants (standalone canvases).** The owner is explicit (`owner_id`, falling
back to the creator for older rows) and transferable. Access comes from three places, and the
highest role wins: ownership, a personal grant (`canvas_collaborators`), or a grant to a channel
the user belongs to (`canvas_channel_grants`). **Guests are read-only unless granted by name**: a
guest in a channel that was granted "can edit" is capped at viewer, and guests can read but not
edit channel and DM canvases. Guests cannot be made owner.

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/canvas/:id/channels` | Channels the canvas is shared with |
| PUT | `/api/canvas/:id/channels/:channelId` `{ role }` | Share with every member (owner only; you must be in that channel; `viewer` or `editor`) |
| DELETE | `/api/canvas/:id/channels/:channelId` | Stop sharing with a channel (owner only) |
| POST | `/api/canvas/:id/owner` `{ username }` | Transfer ownership (owner only); the previous owner becomes an editor |

Operations: `insert_after` / `insert_before` (`sectionId`, `markdown`), `insert_at_start` /
`insert_at_end` (`markdown`), `replace` (`markdown`; with `sectionId` one block, without it the
whole document), `delete` (`sectionId`), `toggle` (`sectionId` of a checklist, `item` 0-based,
optional `checked`), `rename` (`title`). Section ids (`<index>-<hash of the text>`) are only valid
for the revision they were returned with, so `baseRevision` is **required** with an operation; a
mismatch is a 409 with the current canvas, an id that no longer matches is a 404, and an
operation cannot be mixed with `title`/`content` in one request.

### Moderation
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/moderation/access` | Return Superadmin and channel-moderator access for the current user |
| GET | `/api/moderation/settings` | Read workspace timeout defaults (Superadmin only) |
| PUT | `/api/moderation/settings` | Set default and maximum channel timeout minutes (Superadmin only) |
| GET | `/api/moderation/channels/:channelId` | Read channel members, active timeouts, open reports, and audit history (channel moderators only) |
| PUT | `/api/moderation/channels/:channelId/members/:userId` | Grant channel membership or set a member/moderator role (Superadmin only) |
| DELETE | `/api/moderation/channels/:channelId/members/:userId` | Revoke channel membership (Superadmin only) |
| POST | `/api/moderation/channels/:channelId/timeouts/:userId` | Apply a channel timeout; omitted duration uses the configured default |
| DELETE | `/api/moderation/channels/:channelId/timeouts/:userId` | Remove an active channel timeout |
| PATCH | `/api/moderation/channels/:channelId/slowmode` | Set slow mode from 0 to 3600 seconds |
| POST | `/api/moderation/channels/:channelId/reports` | Report a message visible in the channel |
| PATCH | `/api/moderation/reports/:reportId` | Resolve or dismiss a report |
| DELETE | `/api/moderation/messages/:messageId` | Remove a channel message and its attachments (channel moderators only) |
| GET | `/api/moderation/audit` | Read the workspace audit log (Superadmin) or a channel audit log (channel moderator) |

`SUPERADMIN_USERNAME` names the account that the operator may explicitly promote after it has
been registered. Registration never grants elevated access by username. Run
`docker compose exec backend npm run bootstrap:superadmin` after setting the variable and
creating the account. Channel membership controls access to private channels; public channels
remain discoverable and joinable. Moderation checks are enforced by the API and Socket.IO,
including on channel-room joins, message sends, replies, channel timeouts, and slow mode.

### Users
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/users` | List all users |
| GET | `/api/users/:id` | Get user by ID |
| POST | `/api/users/heartbeat` | Presence keepalive (sets status online) |
| GET | `/api/users/:id/direct-messages` | Get DMs with a user |

### Added in Phase 6

| Area | Endpoints |
|------|-----------|
| Activity | `GET /api/activity`, `POST /api/activity/seen` |
| Channel members and links | `GET /api/channels/:id/members`, `GET|POST /api/channels/:id/links`, `DELETE /api/channels/:id/links/:linkId` |
| Settings | `GET|PUT /api/settings` (notifications, Do Not Disturb, status), `GET|PUT /api/settings/sidebar` |
| Group messages | `GET|POST /api/conversations`, `GET /:id/messages`, `POST /:id/read`, `PATCH /:id`, `POST /:id/members`, `DELETE /:id/members/:userId` |
| Own messages | `PATCH /api/messages/:id`, `DELETE /api/messages/:id`, `GET /api/messages/:id/edits` |
| Saved items | `GET|POST /api/saved`, `DELETE /api/saved/:id` |
| Reminders | `GET|POST /api/reminders`, `DELETE /api/reminders/:id` |
| Scheduled messages | `GET|POST /api/scheduled`, `DELETE /api/scheduled/:id` |
| Administration (Superadmin) | `GET /api/admin/users`, `PATCH /api/admin/users/:id`, `GET|POST /api/admin/invitations`, `DELETE /api/admin/invitations/:id`, `PUT /api/admin/registration` |
| Public sign-up helpers | `GET /api/admin/registration`, `GET /api/admin/invitations/lookup?code=` |
| User groups | `GET /api/user-groups` (everyone); `POST`, `DELETE /:id`, `PUT|DELETE /:id/members/:userId` (Superadmin) |
| Webhooks | `GET|POST /api/webhooks`, `DELETE /api/webhooks/:id` (channel moderators); `POST /api/hooks/:token` (public, `{"text": "..."}`, 30 per minute) |

`POST /api/auth/register` accepts an optional `inviteCode`, required when sign-up is
invitation-only.

Guests (`users.account_type = 'guest'`) cannot create or join channels or start group messages,
only see the channels they belong to and the people in them, and can only exchange direct
messages with people who share a channel.

New socket events, server to client: `activity`, `channel_activity`, `message_updated`,
`message_reactions_updated`, `new_group_message`, `conversation_updated`, `conversation_removed`,
`user_status_updated`, `reminder_due`, `scheduled_message_sent`, `scheduled_message_failed`,
`channel_links_updated`, `user_groups_updated`, `account_updated`, `huddle:media-state`.
Client to server: `send_group_message`, `huddle:media-state`.

Two background runners start with the server and check every 15 seconds: reminders
(`routes/reminders.js`) and scheduled messages (`routes/scheduled.js`).

### Security rules (2026-11-11 audit follow-up)

- **One account per socket.** A second `authenticate` on a connection may repeat the same account;
  a different account gets `auth_error` and the connection is dropped. The identity is claimed
  before any asynchronous work, so two racing events cannot both succeed.
- **Attachments are claimed once.** Sending a message with `attachmentId` creates the message and
  links the upload in a single statement (`src/attachments.js`): the file must be yours and not
  attached anywhere yet, otherwise no message is created (`Attachment not found, not yours, or
  already used`). Two sends racing for one file produce one message.
- **Sign-in throttling** (`src/rateLimit.js`, `src/authLimits.js`, in memory, resets on restart):
  8 failed sign-ins per address+account and 40 per address in 15 minutes, then HTTP 429 with
  `Retry-After`; 15 sign-up attempts per address per hour; 30 invitation-code lookups per address
  per 15 minutes; 8 wrong current-password guesses per account on password change. Successful
  sign-in clears the account counter. An unknown username takes as long to answer as a wrong
  password.
- **Passwords:** 8 to 128 characters, not equal to the username (sign-up and password change).
  Existing shorter passwords still work for signing in.
- **Behind a reverse proxy** set `TRUST_PROXY` (number of proxies, e.g. `1`) so limits see each
  person's real address; leave it empty when clients connect directly.
- **Uploads (A06):** the client's file name and MIME type are only claims. The extension must be
  on the allow-list, the stored and served type is derived from it (`src/uploadContent.js`), the
  first bytes must match the extension for signed formats (png, jpg, gif, bmp, pdf, zip and Office
  files, gz, 7z, rar), and anything that looks like a Windows, Linux or macOS program is refused
  whatever its name. Rejected uploads are deleted. Downloads are attachments with `nosniff`.
- **Response headers and logs** (`src/httpHardening.js`): `nosniff`, `X-Frame-Options: DENY`,
  `Referrer-Policy: no-referrer`, a deny-everything CSP, and HSTS only over TLS. One access-log
  line per request (method, path without query string, status, time, address); health checks and
  bodies are not logged. Silence with `LOG_REQUESTS=false`.
- **Guests are kept out of group messages** (cannot be added, cannot send); converting a member to
  a guest removes them from their groups.

### Socket.io Events

| Event | Direction | Description |
|-------|-----------|-------------|
| `authenticate` | Client → Server | Authenticate with JWT token |
| `join_channel` | Client → Server | Join a channel room |
| `leave_channel` | Client → Server | Leave a channel room |
| `send_message` | Client → Server | Send a message to a channel |
| `send_direct_message` | Client → Server | Send a DM |
| `typing` | Client → Server | Typing indicator |
| `huddle:join` | Client → Server | Join an authorized channel audio huddle |
| `huddle:signal` | Client ↔ Server | Relay WebRTC offers, answers, and ICE candidates between huddle members |
| `huddle:leave` | Client → Server | Leave the active channel huddle |
| `huddle:joined` | Server → Client | Huddle participants and ICE server configuration |
| `huddle:participant-joined` / `huddle:participant-left` | Server → Client | Huddle roster updates |
| `huddle:error` | Server → Client | Huddle authorization or connection error |
| `new_message` | Server → Client | New message received |
| `file_deleted` | Server → Client | An attachment was permanently deleted by its uploader |
| `message_deleted` | Server → Client | A moderator removed a channel message |
| `message_pin_updated` | Server → Client | A channel message was pinned or unpinned |
| `new_direct_message` | Server → Client | New DM received |
| `user_typing` | Server → Client | User typing indicator |
| `message_sent` | Server → Client | Message send confirmation |
| `message_error` | Server → Client | Error |

Password changes increment the user's token version, invalidating existing HTTP and Socket.IO
sessions. The desktop client receives a replacement token.

## Local Development

```bash
cd backend
npm install
cp ../../.env.example .env  # or create .env manually
npm run dev
```

Server runs on `http://127.0.0.1:3001` by default (use the literal IPv4 address; the Docker port
mapping is IPv4 only).

## Environment Variables

See `../../.env.example` for required variables.

`WEBRTC_ICE_SERVERS` is a JSON array used by channel huddles. The default public STUN server
supports many direct connections; configure a TURN server in this variable for users behind
restrictive NATs/firewalls. TURN credentials are sent to authenticated huddle participants, so use
short-lived credentials where your TURN provider supports them.
