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
| Phase 3 | Rich features: Files, Notes, Lists, unread counts, presence, read receipts, audio Huddle, Canvas | Done; desktop flows verified live 2026-11-11. Huddle verified between two clients with a simulated microphone, including relay-only through a TURN server; real-microphone validation on two devices pending |
| Phase 4 | Deployment to Hostinger KVM (domain + TLS + build + installers) | Not started |
| Phase 5 | Channel roles, moderation, reports, and audit trail | Implemented; channel-moderator and Superadmin flows verified live 2026-11-11 |
| Phase 6 | Slack-style collaboration features (mentions, activity, notifications, group messages, edit/delete, saved items, reminders, guests and invitations, scheduling, rich text, sidebar sections, channel tabs, user groups, webhooks, Huddle video and screen sharing) | Implemented and verified live 2026-11-11; see "Phase 6 features" |

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
- Icon rail: Home, DMs, Activity, Later, Files, Notes, Huddle, More (Lists, Canvas, Wiki) last, with labels under each icon
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
- Reaction picker (categories, search, add); reactions reach other clients in real time and the
  reacting user's own reactions are highlighted
- Notes create/edit/delete; Lists create, add item, assign a channel member, due date, complete;
  Canvas create/save with escaped Markdown preview; both shared with the second member
- File upload, uploader delete, and moderator delete with a required reason
- Reports, timeouts, moderator message removal, and the Moderation view for a channel moderator
- Profile, Preferences (dark theme, Enter-to-send off), and Account settings (wrong password,
  mismatch, and successful email + password change with the session kept alive)
- Global search across messages and people
- Huddle join, two-client peer connection with audio flowing in both directions, mute, and leave,
  using Chromium's simulated microphone
- Huddle through TURN: with `WEBRTC_ICE_SERVERS` pointing at a temporary coturn container and both
  clients forced to relay-only, both ends selected relay candidates and audio flowed both ways
- Superadmin controls: all channels (including private) listed, timeout policy validation and
  save, channel role grant, private-channel access grant and removal (the removed user loses the
  channel immediately and cannot rejoin), workspace audit log; a non-Superadmin gets 403
- Packaged build (`npm run pack`): the unpacked app starts, signs in, connects, sends a message,
  and includes the fixes below

Fixed during this pass:

- Empty states in Notes, Files, and Activity were not vertically centred: the CSS targeted
  `.view-notes` / `.view-files` / `.view-activity` classes that do not exist (the views use IDs).
- `window.prompt()` is not supported in Electron, so reporting a message, applying a timeout, and
  moderator attachment deletion silently did nothing. They now use an in-app text dialog
  (`askText` in `renderer.js`).
- Reactions were not broadcast; the server now emits `message_reactions_updated` with counts and
  user IDs.
- The first Huddle participant's status stayed on "Waiting for others to join" after someone
  joined.
- The workspace name in the top bar was unreadable in the dark theme.

Not verified:

- Huddle with real microphones on two devices. The development PC has no working physical
  microphone (its only enabled input is a virtual noise-cancelling device, which fails with
  `NotReadableError`), so this needs other hardware.
- A production TURN service on a real restrictive network (only a local coturn was tested)
- The NSIS installer (`npm run dist`); only the unpacked build was run

## Phase 6 features (2026-11-11)

Built from [slack-help-feature-gaps.md](./slack-help-feature-gaps.md). Each item was exercised in
the real Electron app with two or three signed-in clients against the Docker backend; temporary
accounts and data were removed afterwards. Backend tests: 61 pass. Desktop formatter tests: 7 pass.

- **Mentions and Activity**: `@` picker in the composer, highlighted mentions, and an Activity feed
  (All / Mentions / Replies / Reactions / Unread channels) with unseen markers and jump-to-message.
- **Notifications**: per-account preferences, Do Not Disturb, desktop notifications when the window
  is in the background, and live unread counts for channels that are not open.
- **Custom status**: emoji and text, visible to everyone, with a "paused" marker during
  Do Not Disturb.
- **Group messages**: 3 to 9 people, with rename, add, leave, and unread counts. Text only.
- **Own messages**: edit (with stored history and an "(edited)" marker) and delete. Channel
  messages only.
- **Later**: privately saved messages and files, reminders (free text or linked to a message), and
  scheduled messages.
- **Guests and invitations**: guest accounts limited to their channels and the people in them;
  single-use invitation codes; open or invitation-only sign-up; member/guest and Superadmin
  administration.
- **Rich text**: bold, italic, strikethrough, inline code, code blocks, quotes, lists, and links
  that open in the system browser.
- **Sidebar sections**: personal, named, ordered, collapsible sections for channels.
- **Channel tabs**: Messages, Pins, Files, Canvases, Lists, and shared Links.
- **User groups**: `@handle` groups managed by Superadmins.
- **Incoming webhooks**: a secret address per channel that posts `{"text": "..."}` as a named app.
- **Huddle**: camera video and screen sharing (primary screen), alongside audio.
- **Chat layout**: bubbles, with your own messages on the right; message actions are a hover
  toolbar.

Research for the next step on Lists and Canvas (typed Lists, sectioned Canvas with revisions) is in
[../REAGHIDRA/](../REAGHIDRA/README.md); nothing from it is implemented yet.

Not built, by choice or for later:

- Editing and deleting direct messages; attachments in group messages
- A workflow builder or app directory (only incoming webhooks exist)
- Switching between multiple workspaces from one client
- Per-message read receipts
- Choosing a window instead of the whole primary screen when screen sharing

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
between two clients on one machine with a simulated microphone, directly and relay-only through a
local TURN server, but not yet with real microphones on two devices.

## Known defects being carried right now

- The backend container does not mount source; run `docker compose up -d --build backend` after
  backend changes or the app runs stale code.
- The desktop installer is unsigned (Windows shows an "unknown publisher" warning) and has no
  auto-update.
- `renderer.js` and the files in `frontend/src/features` are classic scripts that share one global
  scope. The build check (below) guards the known ways that breaks, including duplicate names.
- Rebuild the backend image from PowerShell (`docker compose up -d --build backend`). From Git
  Bash the build can fail silently and leave the old container running.
- With many rail sections, labels are hidden in windows shorter than 740 px so every section stays
  reachable.

## Security audit follow-up (2026-11-11)

The ChatGPT audit in [IT_AVE_WORKSPACE_CODE_AUDIT_2026-11-11 [chatGPT].md](IT_AVE_WORKSPACE_CODE_AUDIT_2026-11-11%20%5BchatGPT%5D.md)
was checked against the code and acted on. Each fix has a regression test that fails on the old
code, and was verified live against PostgreSQL and in the Electron app (dev and packaged).

| ID | Status |
|---|---|
| A01 socket re-authentication | Fixed: one account per connection (`sockets/chat.js`, `test/socket-identity.test.js`) |
| A02 Postgres port | Already bound to `127.0.0.1` (audit was out of date) |
| A03 Electron store bridge | Fixed: key allowlist, value checks, trusted-page check on every IPC (`frontend/ipc-policy.js`) |
| A04 attachment re-linking | Fixed: atomic one-time claim (`src/attachments.js`); race verified live |
| A05 throttling, password length | Fixed: limits on sign-in, sign-up, invitation lookup, password change; minimum 8 |
| A06 upload type trust | **Fixed**: extension must be allow-listed, stored type derived server-side, leading bytes checked, programs refused, `nosniff` on downloads |
| A07 CORS reflects origin | **Open**, low priority; JWT remains the boundary |
| A08 loopback server address | Fixed: server address setting on the sign-in window; saved per user |
| A09 schema in several places | **Open** (`server.js`, `migrations.js`, `init.sql`) |

Found while checking: guests could be put in group messages, bypassing "guests only reach people in
their channels". Fixed, with a startup cleanup of any existing guest memberships.

Done since: uploads hardening (A06), security headers and request logging (dependency-free, in
`src/httpHardening.js`), and backup/restore steps with a verified restore (`docs/BACKUP.md`).

Still to do before exposing the server beyond the LAN: TLS and reverse proxy, schema consolidation
(A09), real-database integration tests and CI.

## Lists and Canvas rework (from `REAGHIDRA/05`), started 2026-11-11

Decisions taken (user: "go with your recommendations"): keep the legacy Wiki beside Canvas 2.0;
build canvas history; Lists table view only (board only on request); guests read-only unless
granted; Lists stay channel-scoped until they have access levels.

| Step | Status |
|---|---|
| 1. Canvas revisions and 409 conflicts | **Done**: `revision` column, conditional save, client conflict dialog, live updates adopt the revision. Verified against the real database (5 simultaneous saves: 1 wins) and in the Electron client |
| 2. Section lookup/edit operations, checklist toggle | **Done** (API): `GET /sections`, `PATCH` with an `operation`, 11 parser tests plus route tests, verified on the real database (3 concurrent edits: 1 wins). The checklist toggle is reachable from the UI once the rendered view exists (step 7) |
| 3. Canvas owner level and channel grants | **Done**: transferable owner, channel grants, guest read-only default (also for channel/DM canvases), share dialog sections for channels and ownership, viewers get a read-only editor. Verified on the real database and in the client |
| 4. Lists typed schema with to-do migration | **Done** (backend): typed columns/rows/cells, 7 column types, to-do items migrated once with ids preserved, old endpoints kept as wrappers. First real-PostgreSQL tests (`test/helpers/scratchDb.js` builds a throwaway database): migration, 13 route tests, 10 validator tests. Verified on the live data (output identical before and after) and through the existing Lists screen. The client still shows the to-do view; the table view is step 6 |
| 5. Select options, subtasks, archive, copy, duplicate, pagination | **Done** (backend; select options came with step 4): subtasks one level deep, archive/restore with subtasks, duplicate row, copy list (with or without rows, across channels), cursor paging. 18 real-database route tests |
| 6. Lists access levels, table view | Not started |
| 7. Richer Canvas blocks and history UI | Not started |

## Hardening done (2026-11-11)

- Postgres is published on `127.0.0.1:5432` only; the backend reaches it over the Docker network.
- `npm run check` (`frontend/scripts/check.js`) runs automatically before `npm start`,
  `npm run pack`, and `npm run dist`. It fails on a syntax error in any desktop script, a
  re-declaration of `electronAPI`, a `prompt()` call, a reference into `node_modules`, or a
  missing local asset.
- The socket.io client and Lato fonts are vendored into `frontend/src/vendor` (`npm run vendor`
  refreshes them) and are no longer shipped as runtime dependencies.
- `login.js` is wrapped in a function scope, attaches its listeners before any asynchronous work,
  and uses one submit handler. This also fixed sign-up firing a login request alongside the
  registration.
- The local `.env` database password and JWT secret were replaced with random values. Production
  must use its own secrets, set at deployment.

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
| Huddle signaling and audio | Docker Socket.IO check: authorization, concurrent joins, signal relay, six-person cap, and leave; two Electron clients connected with simulated-microphone audio in both directions, directly and relay-only via a local coturn (CDP, 2026-11-11); real microphones on two devices remain |
| Superadmin controls | Temporary Superadmin account in the Electron app over CDP, 2026-11-11 |
| Packaged build | `npm run pack`, then the unpacked app driven over CDP, 2026-11-11 |
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
