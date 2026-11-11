# IT Avenue Workspace - Roadmap and Progress

Honest status. "Implemented and verified" means tested end to end against the running backend.
Features awaiting manual UI verification are called out separately.

Project root: `D:\Development\itavenue-workspace`

## Phase status

| Phase | Scope | Status |
|---|---|---|
| Planning | Architecture, stack, target platform decisions | Done |
| Phase 1 | Backend (Express + Socket.io + PostgreSQL + JWT) with Docker Compose | Done and tested |
| Phase 2 | Electron desktop client (login, sidebar, messaging, threads, reactions, attachments) | Done and tested |
| Phase 3 | Rich features: Files, Notes, Lists, unread counts, presence, read receipts, audio Huddle, Canvas | Done; desktop flows verified live 2026-11-11. Huddle verified between two clients with a simulated microphone; real-microphone and TURN validation pending |
| Phase 4 | Deployment to Hostinger KVM (domain + TLS + build + installers) | Not started |
| Phase 5 | Channel roles, moderation, reports, and audit trail | Implemented; channel-moderator flows verified live 2026-11-11. Superadmin-only controls not yet exercised (no Superadmin account bootstrapped) |

## Implemented and verified

- User registration with bcrypt password hashing; auto-joins default public channels
- Login returning JWT (7-day expiry)
- Profile editing (username and avatar color), email changes, and password changes with
  current-password verification and session invalidation; backend tests pass, desktop UI
  interaction still needs manual verification
- `/api/channels` list, `/api/channels/my` for user membership with unread counts
- `POST /api/channels` create channel (name: lowercase, numbers, hyphens only; auto-join on create)
- `POST /api/channels/:id/read` mark channel read (clears unread badge)
- `GET /api/channels/:id/read-receipts` lists members who have read the channel's latest message
- `/api/messages` channel history (paginated)
- Channel message pinning: membership-protected pin/unpin and pinned-message retrieval APIs;
  backend tests pass, desktop interaction needs manual verification
- `/api/search` searches accessible channel messages, DMs, people, and files
- `/api/lists` channel-shared checklists with channel-member assignment and due dates;
  list access and assignment are scoped to channel membership
- `/api/canvases` channel-shared Markdown documents with member-only access and 100,000-character
  content limit
- `GET|POST /api/messages/:id/replies` thread endpoints
- `POST /api/messages/:messageId/reactions` emoji reaction add/remove
- `GET /api/users` user list with presence status
- `POST /api/users/heartbeat` presence keepalive
- `/api/users/:id/direct-messages` DM history
- File upload endpoint `POST /api/messages/upload` (multer; size limit from .env)
- File attachments linked to channel messages and direct messages (`files.message_id` / `files.dm_message_id`)
- Uploader-only attachment deletion for channel messages, DMs, and unattached uploads; file metadata and stored bytes are removed and connected clients are notified
- `GET /api/files` list shared files; `GET /api/files/:id/download` streams the stored file
- `GET|POST|PUT|DELETE /api/notes` per-user notes with create/update/delete
- Socket.io realtime: `authenticate`, `join_channel`, `leave_channel`,
  `send_message`, `send_direct_message`, `typing`, presence status updates
  (online on authenticate, offline on disconnect)
- Huddle signaling: authenticated channel huddle join/leave, participant roster, and
  membership-checked WebRTC offer/answer/ICE relays
- Database schema and seed data (general, random, dev, announcements) auto-applied on first boot
- Channel-scoped member/moderator roles, private-channel access grants, configurable timeouts
  (five-minute default), slow mode, reports, moderator message removal, and audit history

Desktop client (`frontend/`):

- Frameless window with custom minimize, maximize/restore, and close controls; topbar acts as the
  drag region. Login window is frameless too, with its own minimize/close bar.
- Icon rail: Home, DMs, Activity, Files, Notes, Lists, Canvas, Huddle with labels under each icon
- List pane in a darker purple (#2A0D36) than the rail; channel and DM lists; active-state highlighting
- Topbar zones aligned to the columns below: hamburger over the rail (76 px), workspace name from
  76 px, search from 308 px
- Presence dots on DM list (online = green, away = amber, offline = gray) with live
  refresh every 30 seconds; status updated by backend on socket connect/disconnect
- Message list with date separators, avatar, username, timestamp
- Enter to send (Shift+Enter for newline)
- Inline channel replies with message preview and jump-to-original
- Pinned-message panel with pin/unpin actions and jump-to-original navigation
- Emoji reactions (add/remove)
- Searchable, categorized Unicode emoji picker for message reactions; no external emoji pack
- File attachment UI (image preview inline, other files reference); uploaders can permanently
  delete their attachments for everyone
- Files tab is live: lists files attached to messages the user can see, downloads work, and uses
  a centered animated no-files state with reduced-motion support
- Notes tab is live: list, create, edit, delete; persisted in PostgreSQL per user
- Lists view is live: create shared channel checklists, add/delete items, assign channel
  members, set due dates, and mark items complete
- Canvas view is live: channel-shared Markdown documents with safe preview and explicit saves
- Create menu (Message, Channel, Huddle, Canvas, List) and account menu
  (Profile, Preferences, Account settings, Sign out)
- App menu with File / Edit / View / Window / Help as flyout submenus (24 commands); the native
  Electron menu is removed and all its roles are mirrored in this menu, executing through
  Electron IPC (reload, force reload, devtools, zoom, full screen, select all, clipboard,
  minimize, maximize/restore, close window, quit)
- Activity view lists channels with unread messages, with an aggregate rail badge
- Channel switching and authenticated global search across messages, people, and files
- Canvas Markdown editor with safe preview (headings, unordered lists, emphasis, and code)
- Profile, Preferences, and Account settings forms; preferences (theme and Enter-to-send) are
  stored locally in the desktop app
- Unread badges on channels (white pill on the dark pane); clears on open/read
- Latest-message read receipts show reader avatars/names and refresh when opening a channel or
  receiving a message in the active channel
- Huddle MVP: audio-only WebRTC peer mesh, microphone mute, participant list, and leave controls;
  limited to six participants per channel
- Role-gated Moderation view with Superadmin timeout policy and channel member/report/timeout
  controls
- Compact inline SVG icons throughout (no emoji-in-UI)
- Toast notifications instead of native `alert()`
- Responsive rules: scrollbars eliminated on desktop; sidebar + layout adapt below 1000px
- Working login verified end to end (form submit -> backend -> token -> main window)
- Dev-mode banner is hidden unless `IAV_DEV=1` (dev builds only)

Also resolved:

- Docker stack starts and restarts cleanly
- End-to-end socket message persistence test passes (message sent via WS was read back via REST)
- Create-channel flow verified by simulating the UI click path via CDP

## UI pass (done)

- Demo banner now gated to `IAV_DEV=1`; real users never see it
- Emoji icons replaced with inline SVG icons throughout
- Native `alert()` replaced with a toast notification system
- Files, Notes, Lists, and Canvas are live; Huddle now has an audio-only MVP rather than a demo screen
- Skeleton loading state for message lists (channels and DMs)
- Channel replies appear inline with a preview that links back to the original message
- `Ctrl/Cmd+K` focuses the search box; `Esc` cancels a reply or closes menus and modals
- Focus-visible outlines on all interactive elements for keyboard accessibility
- Responsive rules + a narrow-width breakpoint at 640px
- DM sidebar list stays in sync with channels (renders atomically together)
- Native title bar and native application menu removed; menus live in the hamburger
- Menus paint above the rail (topbar raised to its own stacking context)
- Channel pane darkened to sit visually below the rail
- Lato (SIL OFL) used as the UI font

## Placeholder status

- The previously identified Canvas and Lists create-menu placeholders are now implemented.

## Desktop UI verification (2026-11-11)

Exercised in the real Electron app with two signed-in clients driven over CDP against the rebuilt
Docker backend. Temporary accounts, channel, and data were removed afterwards.

Verified working:

- Optimistic send for channels and DMs (pending state, server acknowledgement, no duplicates) and
  rollback with an error toast when the server rejects a message (channel timeout)
- Inline replies with jump-to-original, pin/unpin with the pinned panel, read receipts, and
  real-time delivery between two clients
- Reaction picker (categories, search, add); reactions appear for other clients after a reload
  only (see known defects)
- Notes create/edit/delete; Lists create, add item, assign a channel member, due date, complete;
  Canvas create/save with escaped Markdown preview; both shared with the second member
- File upload, uploader delete, and moderator delete with a required reason
- Reports, timeouts, moderator message removal, and the Moderation view for a channel moderator
- Profile, Preferences (dark theme, Enter-to-send off), and Account settings (wrong password,
  mismatch, and successful email + password change with the session kept alive)
- Global search across messages and people
- Huddle join, two-client peer connection with audio flowing in both directions, mute, and leave,
  using Chromium's simulated microphone

Fixed during this pass:

- Empty states in Notes, Files, and Activity were not vertically centred: the CSS targeted
  `.view-notes` / `.view-files` / `.view-activity` classes that do not exist (the views use IDs).
- `window.prompt()` is not supported in Electron, so reporting a message, applying a timeout, and
  moderator attachment deletion silently did nothing. They now use an in-app text dialog
  (`askText` in `renderer.js`).

Not verified:

- Huddle with real microphones on two devices, and TURN on restrictive networks
- Superadmin-only controls (timeout policy, role grants, private-channel access)
- Packaged installer build after these changes

## Planned remaining work

Priority order, by user-visible value:

1. **Huddle validation and connectivity**
   - Verify live audio with two desktop clients and real microphones
   - Configure a TURN service for networks where direct peer connections fail
   - Decide whether to replace the six-person mesh with an SFU if larger calls are needed
2. **Deployment to Hostinger KVM**
   - Point DNS at the VPS IP
   - Install Node/Docker, pull this repository
   - Reverse proxy (Nginx) + TLS (Let's Encrypt)
   - Build Windows installer (electron-builder) or distribute a portable exe
   - Rate-limit login, add request logging, consider helmet + CSP
3. **Android**
   - Capacitor-based wrapper around the existing frontend
   - Reuse the same business logic / API client
   - Android will refuse plain HTTP; requires domain + TLS

Read receipts currently cover the latest message in each channel. They do not provide a
per-message read-state history or a dedicated receipt-change event.
Huddle uses a peer-to-peer mesh with a six-participant cap and public STUN by default; reliable
calls across restrictive networks require a configured TURN service. Audio has been verified
between two clients on one machine with a simulated microphone, not yet with real microphones on
two devices.

## Known defects being carried right now

- Login form exposes `electronAPI` global before listeners attach; works but is fragile layout of
  responsibilities. Do not re-declare `electronAPI` anywhere (crashes parse).
- Desktop renderer loads socket.io client from node_modules directly; this is a development-time
  smell. For distribution, bundle with esbuild or similar.
- `renderer.js` parse-time vulnerabilities: renderer can die before any listener attaches. A syntax
  check rule (`node --check renderer.js`) is the guard we use; integrate into build/CI.
- `.env` contains defaults and is referenced by the repository. Secrets must be rotated.
- Reactions are not broadcast over Socket.IO; other clients see them only after reloading the
  channel.
- Dark theme: the workspace name in the top bar is dark purple on a dark background.
- Huddle: the first participant's status keeps saying "Waiting for others to join" after someone
  joins.
- The backend container does not mount source; run `docker compose up -d --build backend` after
  backend changes or the app runs stale code.
- Docker Compose exposes Postgres on `5432` on all interfaces. If this machine is not trusted
  (office LAN), bind Postgres to `127.0.0.1:5432:5432` in the compose file.

## How to read this progress

- If a line says **verified via CDP** or **verified end to end**, we ran it live.
- If a line says **static seed entries / mock**, it is cosmetic only.
- If a line says **not implemented**, it does not exist yet.
- "Done" means the user-facing flow works, not that the code is clean or secure.

## Verification quick list

| Feature | How verified |
|---|---|
| Registration + login + JWT | curl, PowerShell `Invoke-WebRequest` |
| Profile/account API validation and token rotation | Backend automated tests; `token_version` startup migration queried in PostgreSQL |
| Lists API and channel authorization | Backend automated tests and live Docker/PostgreSQL create, assign, due-date, completion, and read check |
| Canvas API and channel authorization | Backend automated tests and live Docker/PostgreSQL create, list, read, update, and delete check |
| Socket auth + send + receive + persisted | Node CDP probe of actual Electron window |
| Latest-message read receipts and channel access | Docker API integration check: two members marked read; both receipts returned; non-member denied |
| Huddle signaling and audio | Docker Socket.IO check: authorization, concurrent joins, signal relay, six-person cap, and leave; two Electron clients connected with simulated-microphone audio in both directions (CDP, 2026-11-11); real microphones and TURN remain |
| Desktop flows (send, replies, pins, reactions, Notes, Lists, Canvas, files, moderation, settings, search) | Two Electron clients driven over CDP against the Docker backend, 2026-11-11 |
| Channel create modal + creation | CDP (real click path) |
| Responsive CSS | No overflow horizontal, no default scrollbars in window |
| Messages persist in Postgres | `docker exec itavenue-db psql -c ...` |

## Notes for anyone picking this up

- Backend runs only inside Docker; start with `cd D:\Development\itavenue-workspace; docker compose up -d`
  and wait for `healthy`.
- Desktop app must be launched via `D:\Development\itavenue-workspace\frontend\start.cmd`,
  never via plain `npm start` (Electron would run as Node.js).
- `--remote-debugging-port=9222` on the Electron launch line enables CDP-driven testing.
