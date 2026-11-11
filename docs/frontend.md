# IT Avenue Workspace - Frontend

Electron desktop application that connects to the IT Avenue Workspace backend.

## Stack

- **Electron** - Desktop app framework
- **Socket.io Client** - Real-time WebSocket messaging
- **electron-store** - Local auth token persistence
- **Vanilla JS + CSS** - No build step, no framework dependencies

## File Structure

```
/frontend/
├── package.json
├── main.js              # Electron main process (windows, IPC, menu removal)
├── preload.js           # Context bridge (secure IPC to renderer)
├── start.cmd            # Launcher that clears ELECTRON_RUN_AS_NODE and runs npm start
├── src/
│   ├── index.html       # Main chat window shell (rail, pane, menus, views)
│   ├── login.html       # Login/register screen with its own title bar
│   ├── renderer.js      # Main UI logic + Socket.io client
│   ├── features/        # Feature scripts loaded before renderer.js (functions only)
│   │   ├── format.js        # Safe rich text for messages (tested in test/format.test.js)
│   │   ├── activity.js      # @mentions and the Activity feed
│   │   ├── notifications.js # Notification preferences, Do Not Disturb, status, unread counts
│   │   ├── groups.js        # Group direct messages
│   │   ├── later.js         # Edit/delete own messages, saved items, reminders, Later view
│   │   ├── admin.js         # Guests, invitations, workspace member administration
│   │   ├── workspace.js     # Scheduled messages, sidebar sections, channel tabs
│   │   ├── huddleVideo.js   # Camera and screen sharing in Huddle
│   │   └── integrations.js  # User groups and incoming webhooks
│   ├── vendor/          # socket.io client and Lato fonts (npm run vendor refreshes them)
│   ├── login.js         # Login/register logic + window controls
│   ├── styles.css       # Theme, rail, pane, menus, responsive rules
│   └── assets/          # App icon variants (icon.png, icon.ico, icon-purple, icon-white)
```

## Layout

- **Frameless window**: the native title bar is removed. The topbar carries custom minimize,
  maximize/restore, and close buttons (46 px each, close turns red on hover). The topbar is the
  drag region; interactive controls opt out with `-webkit-app-region: no-drag`.
- **Icon rail** (76 px): Home, DMs, Activity, Later, Files, Notes, Huddle, role-gated Moderation,
  and a **More** (⋮) button last, as icon-plus-label buttons. **More** opens a small menu (upward)
  with Lists, Canvas and Wiki, and lights up while one of those is open.
- **List pane** (232 px): channels on Home, direct messages on DMs; collapsed for full-width
  sections. It uses a dark purple (#2A0D36), slightly darker than the rail gradient.
- **Topbar alignment**: the hamburger sits over the rail column (76 px), the workspace name starts
  at 76 px and spans the pane width, and the search field starts at 308 px (rail + pane), so each
  zone lines up with the column beneath it.
- **Rail bottom**: create (+) menu (Message, Channel, Huddle, Canvas, List) and the account
  avatar menu (Profile, Preferences, Account settings, Sign out).
- **App menu**: hamburger in the topbar whose groups are flyout submenus (File, Edit, View,
  Window, Help), mirroring the roles of the removed native menu. The native application menu is
  removed in `main.js` (`Menu.setApplicationMenu(null)`), and window/file commands execute
  through Electron IPC.

## Features

| Feature | Status |
|---|---|
| Login / Register | ✅ |
| JWT auth (stored locally) | ✅ |
| Profile editing | ✅ Username and avatar color |
| Preferences | ✅ Device-local theme and Enter-to-send |
| Account settings | ✅ Email/password update; manual UI verification pending |
| Channel list + switch | ✅ |
| Direct messages | ✅ |
| Real-time messaging (Socket.io) | ✅ Optimistic message display with send-failure rollback |
| Channel replies | ✅ Inline preview and jump-to-original |
| Pinned messages | ✅ Channel pin panel, pin/unpin actions, and jump-to-message |
| Emoji reactions | ✅ |
| File attachments (upload, link to message, download, uploader deletion, moderator removal with reason) | ✅ Permanent for everyone; moderator removals are audited |
| Search | ✅ |
| Files tab (live) | ✅ Animated, centered no-files state; uploader can delete shared files |
| Notes tab (live, create/edit/delete) | ✅ |
| Shared channel Lists | ✅ Checklists with completion, assignees, and due dates |
| Shared channel Canvas | ✅ Saved Markdown documents with safe preview |
| Activity view (unread channels) | ✅ |
| Unread badges | ✅ |
| Presence (online/away/offline) | ✅ |
| Global search | ✅ Channel messages, DMs, people, and accessible files |
| Frameless window + custom controls | ✅ |
| Huddle (audio-only peer mesh, max 6 participants) | MVP implemented; two-client audio verification pending |
| Moderation | ✅ Channel-scoped roles, timeout policy, timeouts, slow mode, reports, message and attachment removal, and audit log |
| Auto-updater | ⏳ Planned |

## Lists: checklist and table

The Lists screen (More → Lists) shows checklists (the original card: tick, assignee, due date) and
table lists. **Table lists** (`src/features/lists-table.js`) have typed columns: text, number, date,
checkbox, select (coloured choices, one or several), person, link. Cells edit in place and save on
change; a rejected value shows the server's message and is not stored. Click a column header to sort
(ascending, descending, off), use the filter box to search every cell, add a subtask or duplicate a
row from the row's hover buttons, archive and restore rows from the **Archived** view, and add,
rename or delete columns (the primary column is permanent). **Copy list** makes a new list with the
same columns and, optionally, the rows. Sorting and filtering run on the rows already loaded (500
per page, **Load more rows** for the rest).

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+K` | Focus search |
| `Ctrl+N` | New message (focus composer on Home) |
| `Ctrl+R` | Reload window |
| `Ctrl+Shift+R` | Force reload |
| `Ctrl+Shift+I` | Toggle developer tools |
| `F11` | Toggle full screen |
| `Ctrl+Q` | Quit |
| `Esc` | Cancel a reply or close menus, note editor, and modals |

Standard text editing shortcuts (`Ctrl+Z/X/C/V/A`) continue to work inside inputs.

Channel replies appear inline in the conversation with a preview of the message
they reference. Select the preview to jump to the original message.
Pin a channel message from its message actions, then open the pin icon in the channel
header to browse pinned messages and jump back to their original locations.
Global search opens with `Ctrl+K`; use the arrow keys and Enter to navigate
matching messages, people, and files.
Message reactions use a built-in searchable picker of Unicode emoji (no paid emoji pack
or external image assets required); choose a category or search by name.
Profile and account settings are saved through the backend; theme and Enter-to-send
preferences are stored locally on the desktop device.
Lists are shared with channel members. Choose a channel in the Lists view, then create
checklists and assign items to channel members with optional due dates.
Canvas documents are also shared per channel. The editor supports Markdown headings,
unordered lists, emphasis, and inline/fenced code, with an explicit Save action; it does
not perform simultaneous real-time co-editing.
Moderation is visible to Superadmins and assigned channel moderators. Superadmins control
private-channel membership and the default/maximum timeout policy; channel moderators manage
timeouts, slow mode, reports, and message removal only in their assigned channels. Timeouts
default to five minutes and expire automatically.

## Local Development

**Important:** The shell may contain `ELECTRON_RUN_AS_NODE=1` (it is set globally in this machine's environment), which forces Electron to behave as plain Node and breaks the app. Use the launcher below, which clears it for this process:

```cmd
D:\Development\itavenue-workspace\frontend\start.cmd
```

Or from the command line:

```cmd
set ELECTRON_RUN_AS_NODE=
cd /d D:\Development\itavenue-workspace\frontend
npm start
```

The app connects to `http://127.0.0.1:3001` by default (use the literal IPv4 address, not
`localhost`: the Docker port mapping is IPv4 only). Make sure the backend is running first
(`docker compose up -d` in the project root).

## Choosing the server (no code change needed)

The installed app talks to one backend. On the **sign-in window**, the bottom of the card shows
`Server  http://...  Change`:

1. Click **Change**, type the address (for example `192.168.18.63:3001` or `https://chat.example.com`;
   `http://` is assumed when omitted), and click **Save and reconnect**.
2. The app checks `/api/health`. If nothing answers it asks whether to save the address anyway.
3. **Use this computer (127.0.0.1)** puts it back to the default.

The address is saved per Windows user. It can only be changed from the sign-in window (sign out
first), never from inside the signed-in app.

For development and scripted installs, the `API_BASE` (and optional `SOCKET_URL`) environment
variables override the saved address; the sign-in window then shows the address as fixed.
Precedence: environment variable, then saved address, then `http://127.0.0.1:3001`.
The logic is in `frontend/server-config.js` and is unit tested.

Use the host computer's LAN address (not `127.0.0.1`) when other computers connect to it, and open
TCP port 3001 in that computer's firewall.

## Desktop bridge limits

The renderer can only call a small set of main-process functions, and only from the app's own
pages (`frontend/ipc-policy.js`):

- The persistent store accepts only `authToken`, `user`, and `preferences:<id>`, with size and shape
  checks; any other key is refused.
- Every IPC call is refused unless it comes from the top-level frame of a page loaded from `src/`.
- The server-address functions work only from the sign-in window.

The login window is also frameless, with its own slim title bar carrying minimize and close
buttons (it is fixed-size, so it has no maximize control).

## Building for Production

```bash
npm run dist
```

This creates platform-specific installers (Windows NSIS, macOS DMG, Linux AppImage).

## Status

- Planning: Complete
- Phase 1 (Backend + Database): Built and verified
- Phase 2 (Electron Desktop App): Built and verified
- Phase 3 (Rich Features): Files, Notes, unread, presence, Activity, and read receipts done;
  Lists and Canvas implemented; audio Huddle MVP awaits two-client audio verification
- Phase 4 (Deploy to Hostinger KVM): Planned
