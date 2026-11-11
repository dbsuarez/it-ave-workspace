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

## Canvas: the editable page

A canvas opens as a formatted page that people edit directly: click a heading and type, tick a
checklist, press `/` for a table. Nobody has to know Markdown. It is built on TipTap (ProseMirror)
and lives in `editor-src/canvas-editor.js` (the editor and our Markdown dialect),
`src/vendor/canvas-editor.js` (the bundle the app loads) and `src/features/canvas-wysiwyg.js`
(toolbar, slash menu, templates, comment bubble, link box).

- **Still Markdown underneath.** The canvas is saved as Markdown, so history, comments, section
  operations, the API and old clients keep working. Each canvas view keeps a hidden textarea that
  holds the Markdown and drives autosave; the page writes to it on every edit and reloads from it
  whenever the app sets it (opening a canvas, a remote change, a restore).
- **The dialect.** Checklists `- [ ]`, callouts `> [!info] Title` (info, note, tip, warning, danger;
  a title becomes a bold first line), pictures `![name](file:<id>)`, GitHub-style tables, headings,
  lists, quotes, code and dividers. `test/canvas-editor.test.js` checks that each survives a round
  trip, that the saved form is stable, and that remote images and scripts never get through.
- **Slash menu.** Type `/` at the start of an empty line: headings, text, lists, checklist, quote,
  callouts, table, image, code, divider, date, mention. `/h1 My title` then Enter writes the heading
  in one go.
- **Toolbar.** Bold, italic, strikethrough, link (Ctrl+K), headings, lists, checklist, quote, table,
  image, code, callout, divider, undo and redo. Inside a table it adds row and column buttons; inside
  a callout it adds the four callout types. The **Aa** button next to **Markdown** hides it (remembered
  per computer).
- **Templates.** An empty canvas offers Meeting notes, Project plan, Action items, Incident report
  and Channel FAQ.
- **Pictures.** `/image` or the Image button uploads to the canvas; so does pasting a picture or
  dropping an image file onto the page. The page fetches each picture with the signed-in request and
  shows it from a blob URL. There is never a public URL. Click a picture to select it: a bar offers
  size presets (25, 50, 75 percent, full), left, center or right alignment, a description (alt text),
  Replace and Delete, and a corner handle resizes it by dragging. Size and alignment are saved in
  the standard Markdown image title, for example `![name](file:7 "50% center")`.
- **Tables.** Tables fill the page, with equal columns, until columns are given widths. With the cursor
  in a table a bar floats above it, with related actions grouped into dropdown menus: **Row** (insert
  above or below, delete), **Column** (insert left or right, delete), **Widths** (equalize all columns,
  auto-fit to contents) and **Align** (left, center, right), plus **Header row** and **Delete table**.
  Hovering a table shows a "+" at its right edge (add a column) and bottom edge (add a row); Tab in
  the last cell adds a row. Drag a column border to resize it: the drag stops at the edge of the page,
  so a table never becomes wider than the page. Widths are saved in the Markdown separator row (about
  10px per dash, three dashes or fewer means automatic), which other Markdown renderers ignore.
- **Picture bar.** Selecting a picture floats a bar with **Size** (25, 50, 75 percent, full width) and
  **Align** menus, plus Description, Replace and Delete.
- **Mentions.** Type `@` and a name to pick someone; it is saved as plain `@name` text, so search and
  old clients keep working. Next to other text it shows as a small chip. Alone on its own line it
  becomes a profile card (avatar, name, job title, status, email) so readers know who is meant. The
  details come from the people the app already knows (`canvasMentionLookup` in
  `features/canvas-wysiwyg.js`); the card has a **Message** button that opens a direct message with them; an unknown name stays a plain chip. People set their **job title** in
  Profile.
- **Moving things.** Hover any block and drag its grip (six dots) to move it, whether it is a paragraph,
  a picture, a table or a callout.
- **Markdown source.** The **Markdown** button swaps the page for the Markdown text (with its own
  slash menu and toolbar) and **Page** swaps back, for people who prefer the source.
- **Viewers and guests** get the same page, locked: no toolbar, no editing, links still open.
- **Rebuilding the bundle.** After changing `editor-src/` or upgrading `@tiptap/*`, run
  `npm run editor` in `frontend/` and commit `src/vendor/canvas-editor.js`.

## Notifications and sounds

Notifications follow the account's settings (Preferences): mentions, direct and group messages, replies,
reactions, every channel message (off by default), desktop notifications when the app is in the
background, and Do Not Disturb. Each one is a toast, an entry in Activity, an unread badge and, in the
background, a system notification. Canvas @mentions, comments that mention you and replies to your
comments arrive the same way (`canvas_activity` socket event, Activity feed, `canvas_mentions` table).

**Sounds** (`features/notification-sound.js`) are made with the Web Audio API, so there are no sound
files. A different sound plays for a message, a mention, a reply, a reaction, a reminder and an incoming
call (a ring that repeats until answered, declined, cancelled or 60 seconds pass). The default is **Chime**
at 70 percent and it plays out of the box. In Preferences each person can choose another style (Bell,
Marimba, Pop, Soft, Digital), set the volume and play a sample before saving; the choice is kept on that
computer (`preferences:<id>`). The account setting "Play a sound for notifications and incoming calls"
turns sounds off, and Do Not Disturb silences them. The system notification is sent silent so the
app's own sound is not doubled. A burst of messages makes one sound (0.7 s gap).

## One-to-one huddles

The **Huddle** button on a profile card (or answering a call) starts a huddle between two people:
the same audio, camera and screen share as a channel huddle, with the call keyed to the pair
(`dm:<low>-<high>`). The first person in rings the other: a banner with **Join** and **Decline**, a
toast, a system notification and a repeating ring (`features/direct-huddle.js`). Hanging up before an
answer, declining, or 60 seconds stops the ringing. Guests can only call people they share a channel with.

## Profile photos

Profile has an **Upload photo** button. The picture is cropped to a square and shrunk to 256 px in the
app, then uploaded (PNG or JPEG, 2 MB at most). Photos are fetched with the signed-in request and cached
as blob URLs per person and version (`features/profile-photo.js`); they show on your avatar, in Profile and
on mention cards, and are included in PDF and Word exports of a card.

## Canvas: export

The **Export** menu in the canvas header saves the canvas as a **PDF**, a **Word document (.docx)** or a
**Markdown** file. Only the desktop app can save files, so the menu is hidden elsewhere.

- The page gathers the content (`features/canvas-export.js`): the editor's document, and each picture
  fetched with the signed-in request and converted to PNG (at most 1600px wide). The main process builds
  the file and shows the save dialog (`canvas:export` in `main.js`); the page never chooses the path.
- **PDF.** `export/pdf-html.js` makes a self-contained page (pictures inlined, strict
  Content-Security-Policy) which a hidden window with scripts off, no network and its own session prints
  with Chromium's `printToPDF` (A4). Callouts, tables, checklists, picture size and alignment are kept.
- **Word.** `export/docx-builder.js` builds a real `.docx` with the `docx` package: heading styles, bold,
  italic, strikethrough, code, links, bulleted, numbered (each list restarts at 1) and checklist lists
  with boxes, quotes, code blocks, dividers, tables (header row, alignment, column widths), callouts as
  shaded boxes and pictures at their saved size and alignment.
- The title is added on top unless the content already starts with a heading that says the same.
- `ipc-policy.js` validates every request (format, sizes, picture data) and sanitizes the suggested file
  name. For automated tests only, the environment variable `IAV_TEST_EXPORT_DIR` makes the app write into
  that folder and skip the save dialog.

## Canvas: recently deleted

Deleting a personal canvas moves it to **Recently deleted** (button at the bottom of the canvas list)
for 7 days (`CANVAS_TRASH_DAYS`). **Restore** brings it back with its comments, pictures and history.
After that a purge removes it for good. Channel and DM canvases are still removed at once.

## Canvas: comments

The **Comments** button in the canvas header (showing the number of open threads) opens a panel
(`features/canvas-comments.js`). Each block of the page shows a comment bubble on hover;
pressing it starts a thread that quotes that block. Editors can reply, resolve and reopen threads,
filter Open / Resolved / All, and delete their own comments; viewers read. Other people's comments
appear live.

## Canvas: History

The **History** button lists earlier versions; pick one to preview its text and **Restore this
version** (kept as a new version, so it can be undone). Opening or closing a canvas without typing
does not save anything. The old read-only renderer (`features/canvas-render.js`) is no longer used
by the editors.

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
