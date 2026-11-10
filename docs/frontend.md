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
│   ├── login.js         # Login/register logic + window controls
│   ├── styles.css       # Theme, rail, pane, menus, responsive rules
│   └── assets/          # App icon variants (icon.png, icon.ico, icon-purple, icon-white)
```

## Layout

- **Frameless window**: the native title bar is removed. The topbar carries custom minimize,
  maximize/restore, and close buttons (46 px each, close turns red on hover). The topbar is the
  drag region; interactive controls opt out with `-webkit-app-region: no-drag`.
- **Icon rail** (76 px): Home, DMs, Activity, Files, Notes, Huddle as icon-plus-label buttons.
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
| Channel list + switch | ✅ |
| Direct messages | ✅ |
| Real-time messaging (Socket.io) | ✅ |
| Threaded replies | ✅ |
| Emoji reactions | ✅ |
| File attachments (upload, link to message, download) | ✅ |
| Search | ✅ |
| Files tab (live) | ✅ |
| Notes tab (live, create/edit/delete) | ✅ |
| Activity view (unread channels) | ✅ |
| Unread badges | ✅ |
| Presence (online/away/offline) | ✅ |
| Frameless window + custom controls | ✅ |
| Huddle (audio-only peer mesh, max 6 participants) | MVP implemented; two-client audio verification pending |
| Canvas / Lists | ⏳ Planned (menu entries report not implemented) |
| Auto-updater | ⏳ Planned |

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
| `Esc` | Close menus, thread panel, note editor, modals |

Standard text editing shortcuts (`Ctrl+Z/X/C/V/A`) continue to work inside inputs.

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

## Connecting to Your Deployed Backend

Edit `src/renderer.js` and change `API_BASE` and `SOCKET_URL` to your deployed server URL:

```js
const API_BASE = 'https://your-domain.com';
const SOCKET_URL = 'https://your-domain.com';
```

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
  audio Huddle MVP implemented; Canvas and Lists are not started
- Phase 4 (Deploy to Hostinger KVM): Planned
