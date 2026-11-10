# IT Avenue Workspace - Roadmap and Progress

Honest status. If it is marked implemented, it has been tested end to end against the running
backend. If it is marked mock or planned, it is not.

Project root: `D:\Development\itavenue-workspace`

## Phase status

| Phase | Scope | Status |
|---|---|---|
| Planning | Architecture, stack, target platform decisions | Done |
| Phase 1 | Backend (Express + Socket.io + PostgreSQL + JWT) with Docker Compose | Done and tested |
| Phase 2 | Electron desktop client (login, sidebar, messaging, threads, reactions, attachments) | Done and tested |
| Phase 3 | Rich features: real Files upload, Notes backend integration, unread counts, presence, read receipts, actual audio huddle | Mostly done (Files, Notes, unread, presence, read receipts); audio huddle remains mock |
| Phase 4 | Deployment to Hostinger KVM (domain + TLS + build + installers) | Not started |

## Implemented and verified

- User registration with bcrypt password hashing; auto-joins default public channels
- Login returning JWT (7-day expiry)
- `/api/channels` list, `/api/channels/my` for user membership with unread counts
- `POST /api/channels` create channel (name: lowercase, numbers, hyphens only; auto-join on create)
- `POST /api/channels/:id/read` mark channel read (clears unread badge)
- `GET /api/channels/:id/read-receipts` lists members who have read the channel's latest message
- `/api/messages` channel history (paginated)
- `GET|POST /api/messages/:id/replies` thread endpoints
- `POST /api/messages/:messageId/reactions` emoji reaction add/remove
- `GET /api/users` user list with presence status
- `POST /api/users/heartbeat` presence keepalive
- `/api/users/:id/direct-messages` DM history
- File upload endpoint `POST /api/messages/upload` (multer; size limit from .env)
- File attachments linked to channel messages and direct messages (`files.message_id` / `files.dm_message_id`)
- `GET /api/files` list shared files; `GET /api/files/:id/download` streams the stored file
- `GET|POST|PUT|DELETE /api/notes` per-user notes with create/update/delete
- Socket.io realtime: `authenticate`, `join_channel`, `leave_channel`,
  `send_message`, `send_direct_message`, `typing`, presence status updates
  (online on authenticate, offline on disconnect)
- Database schema and seed data (general, random, dev, announcements) auto-applied on first boot

Desktop client (`frontend/`):

- Frameless window with custom minimize, maximize/restore, and close controls; topbar acts as the
  drag region. Login window is frameless too, with its own minimize/close bar.
- Icon rail: Home, DMs, Activity, Files, Notes, Huddle with labels under each icon
- List pane in a darker purple (#2A0D36) than the rail; channel and DM lists; active-state highlighting
- Topbar zones aligned to the columns below: hamburger over the rail (76 px), workspace name from
  76 px, search from 308 px
- Presence dots on DM list (online = green, away = amber, offline = gray) with live
  refresh every 30 seconds; status updated by backend on socket connect/disconnect
- Message list with date separators, avatar, username, timestamp
- Enter to send (Shift+Enter for newline)
- Thread panel (replies with counts)
- Emoji reactions (add/remove)
- File attachment UI (image preview inline, other files reference)
- Files tab is live: lists files attached to messages the user can see, downloads work
- Notes tab is live: list, create, edit, delete; persisted in PostgreSQL per user
- Create menu (Message, Channel, Huddle, Canvas, List) and account menu
  (Profile, Preferences, Account settings, Sign out)
- App menu with File / Edit / View / Window / Help as flyout submenus (24 commands); the native
  Electron menu is removed and all its roles are mirrored in this menu, executing through
  Electron IPC (reload, force reload, devtools, zoom, full screen, select all, clipboard,
  minimize, maximize/restore, close window, quit)
- Activity view lists channels with unread messages, with an aggregate rail badge
- Channel switching, search field (client-side filter of visible channel)
- Unread badges on channels (white pill on the dark pane); clears on open/read
- Latest-message read receipts show reader avatars/names and refresh when opening a channel or
  receiving a message in the active channel
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
- "Demo" pill remains on the Huddle view only (Files and Notes are now live and no longer labeled demo)
- Skeleton loading state for message lists (channels and DMs)
- `Ctrl/Cmd+K` focuses the search box; `Esc` closes menus, the thread panel, and modals
- Focus-visible outlines on all interactive elements for keyboard accessibility
- Responsive rules + a narrow-width breakpoint at 640px
- DM sidebar list stays in sync with channels (renders atomically together)
- Native title bar and native application menu removed; menus live in the hamburger
- Menus paint above the rail (topbar raised to its own stacking context)
- Channel pane darkened to sit visually below the rail
- Lato (SIL OFL) used as the UI font

## Mocked / not implemented (labeled honestly in the UI)

- **Huddle**: static mock screen. No microphone, no audio, no WebRTC. Label visible on screen.
- **Canvas / Lists**: entries exist in the create menu but report "not implemented yet" when used.
- **Search**: client-side filter of the currently rendered channel; not server-side full-text search.
- **Profile / Preferences / Account settings**: menu entries exist and report that editing is not
  implemented yet.
## Planned remaining work

Priority order, by user-visible value:

1. **Real huddle**
   - WebRTC audio via PeerJS or a small Node relay
   - Cross-check: does the office actually want this, or is it enough to hop on a call elsewhere?
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

## Known defects being carried right now

- Login form exposes `electronAPI` global before listeners attach; works but is fragile layout of
  responsibilities. Do not re-declare `electronAPI` anywhere (crashes parse).
- Desktop renderer loads socket.io client from node_modules directly; this is a development-time
  smell. For distribution, bundle with esbuild or similar.
- `renderer.js` parse-time vulnerabilities: renderer can die before any listener attaches. A syntax
  check rule (`node --check renderer.js`) is the guard we use; integrate into build/CI.
- `.env` contains defaults and is referenced by the repository. Secrets must be rotated.
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
| Socket auth + send + receive + persisted | Node CDP probe of actual Electron window |
| Latest-message read receipts and channel access | Docker API integration check: two members marked read; both receipts returned; non-member denied |
| Channel create modal + creation | CDP (real click path) |
| Responsive CSS | No overflow horizontal, no default scrollbars in window |
| Messages persist in Postgres | `docker exec itavenue-db psql -c ...` |

## Notes for anyone picking this up

- Backend runs only inside Docker; start with `cd D:\Development\itavenue-workspace; docker compose up -d`
  and wait for `healthy`.
- Desktop app must be launched via `D:\Development\itavenue-workspace\frontend\start.cmd`,
  never via plain `npm start` (Electron would run as Node.js).
- `--remote-debugging-port=9222` on the Electron launch line enables CDP-driven testing.
