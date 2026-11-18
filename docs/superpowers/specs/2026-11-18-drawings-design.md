# Drawings (Excalidraw) design

Status: for approval. Written 2026-11-18. Nothing is built yet.

## Intent

People want to sketch and diagram inside the app: quick drawings in a channel or forum topic, whiteboarding live together in a
meeting, and documenting systems and processes. They also want to draw alone, including with no connection to the server.
The editor is Excalidraw (https://github.com/excalidraw/excalidraw, MIT licence, package `@excalidraw/excalidraw` 0.18.1),
built into the app and sitting beside Canvas. Live co-editing follows Excalidraw's own way of working.

## Goals

- A **Drawings** area beside Canvas: a left-rail entry, and a **Drawings** tab in every channel and forum.
- Two kinds of drawing: **channel or topic drawings** (belong to a channel, optionally a forum topic) and **standalone drawings**
  (private to the owner, shareable with people).
- **Live co-editing** with cursors, over our existing Socket.IO connection.
- **Offline drawing**: every drawing is saved on the person's computer as they draw; a solo drawing works with no connection and
  syncs on reconnect.
- A drawing appears **in the conversation** as a card (like a poll), in a channel or in a forum topic.
- Export to PNG and SVG. The same access rules as the rest of the app, including department forums and guests.

## Non-goals (v1)

- Search by drawing content, comments on drawings, version history or restore, public share links, thumbnails on cards.
- More than one backend process (live rooms live in the memory of one server; the app already assumes one process).
- Excalidraw's own hosted features: its collaboration server, its public shape library, and its sharing links. Nothing in the app
  may call excalidraw.com or any CDN.
- Editing in the mobile or Android shell (the editor is for the desktop client).

## Anti-goals (a failure even if it works)

- A drawing, or part of one, lost because the network dropped or two people edited at once.
- A person reading or editing a drawing in a channel, topic or forum they cannot open.
- Any network request to a third party (fonts, library, telemetry), or the app failing to start drawing when offline.

## Approaches considered

| | Approach | Verdict |
|---|---|---|
| A | Save with a revision check, one editor at a time (as Canvas works) | Not live; rejected |
| **B** | **Live through our Socket.IO using Excalidraw's per-shape versions and merge rule; server keeps and saves the merged drawing** | **Chosen** |
| C | A conflict-free sync layer (Yjs) | Most robust offline merging, but a new dependency and sync server and no official Excalidraw support; rejected |

The user chose B and accepted Excalidraw's conflict rule: shapes only one person touched keep everyone's work, and when two
people changed the same shape, the more recent edit (higher version; on a tie, the lower random nonce) wins. No shape is ever
silently dropped; deletions are kept as "deleted" shapes so they propagate.

## Design

### Data
- `drawings`: id, title (1 to 120 characters), owner_id, `channel_id` (nullable), `topic_id` (nullable, must be a topic of that
  forum channel), `message_id` (the conversation card, nullable), `scene` (JSONB: all shapes including deleted ones, plus a small
  set of view settings such as background and grid), `revision` (integer, +1 per saved change), created_at, updated_at, updated_by.
  A drawing with no `channel_id` is standalone.
- `drawing_members`: drawing_id, user_id, role (`editor` or `viewer`), for standalone drawings.
- `drawing_files`: drawing_id, file key (Excalidraw's image id), mime type, bytes. Pasted or inserted images live here, not in
  the scene. Limits (my call): 2 MB per image, 20 MB per drawing, scene JSON 10 MB, 20,000 shapes.
- A drawing posted to a conversation is a message with `kind = 'drawing'` (and `topic_id` in a forum), shown as a card with the
  title and an **Open** button. Deleting the drawing replaces the card text with "Drawing removed".
- All tables are created in `migrations.js`.

### Who can do what
| Drawing | Open and edit | View only | Create | Delete | Share |
|---|---|---|---|---|---|
| Channel or topic | Members who can open the channel or forum, checked every time | Guests | Anyone who can post there | Its creator, and channel or forum moderators | Already shared with the channel |
| Standalone | Owner, and invited editors | Invited viewers | Any member | Owner | Owner invites people; "Share into a channel or topic" makes a **copy** there |

When the place a drawing lives is archived (an archived channel, or a forum that was archived with its department) or the topic
is locked or archived, the drawing becomes view-only for everyone, as posts do. Deleting a channel or a forum topic deletes the
drawings in it (and their cards); a moderator removing a drawing is recorded in the audit log.

A viewer's live edits are refused by the server. Access is re-checked when someone joins a live drawing and on every save.
Guests (account type guest) never create or edit. Owner "private-channel switch" rules apply to forums exactly as they do now.

### Live editing (Socket.IO)
- `drawing:join {drawingId}`: the server checks access, joins the room `drawing_<id>`, and replies with the saved drawing, the
  files, the revision, the person's role, and who is present.
- `drawing:update {drawingId, elements}`: only the shapes that changed. The server merges them into the in-memory drawing with
  the version rule above (its own small function, tested; it does not import React), then sends them to the others. Updates from
  viewers are refused.
- `drawing:pointer`: cursor position, tool, and selection, sent to others only, throttled, never saved.
- `drawing:leave` and disconnects remove the person from the room and the presence list.
- Access is re-checked at each save tick for everyone in the room (the same idea as the channel rooms): someone who was moved out of the
  department, banned, or removed from a share is dropped from the room and told, and their later updates are refused.
- **Saving:** the server keeps each live drawing in memory, marks it changed, and writes it to the database every 5 seconds
  while changed, when the last person leaves, and on shutdown. Each write increases `revision`.
- Presence shows names in each person's role colour (as names do elsewhere).

### Offline
- The client keeps a local copy of every drawing it has opened or made (IndexedDB: shapes, files, the last revision it synced, and
  a "changed since sync" flag), saved about a second after each change.
- A **standalone drawing can be created and drawn with no connection**. It has a temporary id until the first sync, then the
  server creates it and the id is swapped. A **channel or topic drawing** can be edited offline if it was opened before; creating
  a new channel drawing needs a connection, because it is a post in a conversation.
- On reconnect the client joins the drawing, receives the server's version, merges it with its local one using Excalidraw's own
  `reconcileElements`, shows the result, and sends the shapes that differ from the server. The server applies the same rule.
- If the person lost access while offline, the sync is refused: the local copy is kept, a banner says it cannot sync, and export
  still works. If the drawing was deleted meanwhile, the person is offered "Save as my own drawing".
- The editor bar always says one of: **Saved**, **Saving**, **Offline: will sync**, **Cannot sync**.

### Screens
- Left rail **Drawings** (beside Canvas): **My drawings** and **Shared with me**, with New drawing.
- Channel and forum: a **Drawings** tab listing that channel's drawings with a New drawing button. In a forum topic, the composer
  has an **Add drawing** action that creates a topic drawing and posts its card into the topic.
- The editor takes the whole pane: Excalidraw, with a title bar (back, rename, presence, connection state, Export, and Share for
  standalone). Share asks for people and a role, or "Share into a channel or topic".
- Controls that reach outside the app (public library, embedded web pages, "open in Excalidraw+") are switched off.
- The help guide gets a Drawings section.

### Bundling
Excalidraw needs React, so it is built with esbuild into one script, as the text editor already is
(`editor-src/`, `scripts/build-editor.js`), into `src/vendor/` with its fonts, the output committed. The app loads nothing from
`node_modules` or the internet at runtime. `check` fails the build if the bundle contains an external address that is called at
runtime (fonts, library, telemetry).

## Risks and how we handle them

1. **Size and offline behaviour of the bundle** (Excalidraw is large; its fonts load from a CDN by default). First task: a
   spike that bundles it, renders in Electron with the network cut, measures the size, and proves there are no outside
   requests. If the size is unacceptable we stop and rethink before building anything else.
2. **Live merge correctness.** The merge function is pure and tested for order independence (the same updates in any order give
   the same drawing), including deletions and ties.
3. **Growth** of deleted shapes inside a drawing: pruning old deleted shapes is left for later; the size caps stop runaway growth.
4. **Untrusted scene data** from clients: the server checks the shape of every update (an id, a numeric version, size limits) and
   refuses malformed or oversized input; the editor never runs scripts from a drawing.
5. **Single process.** Documented; the app already assumes it.

## Testing

- Pure server tests: the merge rule (including property-style order independence), size limits, validation.
- Real-database tests: the access table above for channels, topics, forums, guests, standalone owners, editors and viewers.
- Fake-socket tests like the forum posts: join, update, pointer, refusal for viewers and outsiders, save on last leave.
- Pure client tests: offline sync planning, the "saved / offline" state, and the card markup.
- A bundle check that no third-party address is used at runtime.
- Visual check of the screens in the browser preview, and a manual check in Electron with the network disconnected.

## Left to the builder

The exact event payload shapes, the IndexedDB layout, the card's look, the editor toolbar choices, and the esbuild settings.
Decisions to confirm with the user are marked **(my call)** where limits are concerned: the size caps (2 MB image, 20 MB
drawing, 10 MB scene, 20,000 shapes) and the 5-second save interval.
