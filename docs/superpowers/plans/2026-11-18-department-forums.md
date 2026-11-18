# Department Forums Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every department a private, Discord-style forum with unlimited topics, and remove Team Channels and Team Sections.

**Architecture:** A forum is a channel (`kind = 'forum'`) tied to one department and opened by the department's live membership, so access, bans, slow mode, archive, search visibility and files keep working. Topics are rows in `forum_topics`; posts are ordinary `messages` carrying a `topic_id`. Existing team channels become ordinary private channels.

**Tech Stack:** Node.js 24, Express, Socket.IO, PostgreSQL 15 (scratch DB tests via `backend/test/helpers/scratchDb.js`), plain-script Electron renderer, `node:test`.

**Spec:** `docs/superpowers/specs/2026-11-18-department-forums-design.md`

## Global Constraints

- Topic title 1 to 120 characters; post length follows the existing message limit (10,000).
- A message in a forum channel always has a `topic_id`; a message in any other channel never does. `channels.kind` is `'channel'` or `'forum'`; one forum per department (`channels.forum_department_id` is unique).
- Forum channel: private, slow mode 0, name `dept-<department name>` in the channel-name format (lowercase letters, numbers, hyphens, at most 50 characters; on a clash append `-<departmentId>`), carries the department grant in `channel_department_grants`.
- The department head holds a `channel_members` row with role `moderator`; moderators are also holders of `manage_messages`. Owners follow the existing private-channel switch (no special bypass).
- Deleting a department archives its forum (`archived_at`), never deletes it. A topic author may delete their own topic only while it has no replies.
- Search matches topic titles, post text and attachment file names (not file contents) and shows the topic; visibility is the existing `channelVisibleToUser`.
- Team Channel removal must not delete any message, file or membership: team memberships (`membership_source = 'team'`) become `'invited'`.
- New tables go in `backend/src/migrations.js` only; new columns on existing tables go in both `migrations.js` and `database/init.sql`. Dialogs only from `features/dialogs.js`. Windows + Git Bash, CRLF files; use the Write tool for scripts with quotes or backslashes. Push to `main` only when the user says so.

## Review Focus

1. A person outside the department, a person moved out, a guest and a non-member Owner (switch off) cannot read topics or posts by any route: topic list, history, search, Files, Activity, sockets, `/search` (Tasks 2, 3, 4, 5 tests).
2. Posting rules hold: a forum post without `topicId`, a `topicId` in an ordinary channel, and a topic belonging to another channel are all refused; locked, archived topics and archived forums refuse replies (Task 4 tests).
3. Concurrent reply and lock: a reply racing a lock either posts before it or is refused, never posts into a locked topic afterwards (Task 4 test).
4. Team Channel removal is idempotent and loses nothing: rerunning the migration is a no-op, memberships and messages are untouched, and users whose stored sidebar layout mentions old team sections still load a valid sidebar (Task 8 tests).
5. Department rename, head change, move and delete keep the forum consistent: name collisions, a head who is later removed, a deleted department (Tasks 1, 2 tests).

## File Structure

- `backend/src/forums.js` (create): naming, `ensureDepartmentForum`, `ensureAllForums`, `syncForumHead`, `archiveForumForDepartment`, `loadTopic`, topic serialization.
- `backend/src/routes/forums.js` (create): topic REST; mounted at `/api/forums` in `server.js`.
- Modify: `migrations.js`, `database/init.sql`, `routes/hr.js` (department hooks), `attachments.js`, `sockets/chat.js`, `routes/messages.js`, `routes/channels.js`, `searchService.js`, `routes/files.js`, `routes/settings.js`, `routes/moderation.js`, `routes/people.js`, `teamSections.js` (delete), client `renderer.js`, `workspace.js`, `index.html`, `styles.css`.
- `frontend/src/features/forum-view.js` (create): pure renderers. Tests: `backend/test/forum-schema.test.js`, `forum-lifecycle.test.js`, `forum-topics.test.js`, `forum-posts.test.js`, `forum-search.test.js`, `team-channels-removal.test.js`, `frontend/test/forum-view.test.js`.

---

### Task 1: Schema and forum creation

**Files:** Create `backend/src/forums.js`; Modify `migrations.js`, `database/init.sql`, `server.js` (call `ensureAllForums` after migrations, next to `ensureDefaultChannels`); Test `backend/test/forum-schema.test.js`

**Interfaces:**
- Produces: `forumChannelName(departmentName: string, departmentId: number) -> string`; `ensureDepartmentForum(query, departmentId: number) -> Promise<number>` (channel id; creates the channel, the department grant and the head moderator row when missing; idempotent); `ensureAllForums(query) -> Promise<number>` (count created). Columns `channels.kind`, `channels.forum_department_id`, `messages.topic_id`; table `forum_topics(id, channel_id, title, created_by, created_at, last_activity_at, pinned_at, locked_at, archived_at)`.

- [ ] **Step 1: Write failing tests** `forum-schema.test.js`: after init and migrations the columns and table exist and rerunning migrations changes nothing; `forumChannelName('Human Resource', 6)` is `dept-human-resource`, a 90-character name is cut to at most 50 characters, and a name that cannot be slugged (`'***'`) becomes `dept-6`; `ensureDepartmentForum` creates one private forum with `kind = 'forum'`, `forum_department_id` set, slow mode 0, the department grant, and a moderator row for the head; calling it again returns the same channel id and creates nothing; a clash with an existing channel named `dept-mis` yields `dept-mis-<id>`; `ensureAllForums` creates a forum for every department and returns 0 when run again; a CHECK rejects `messages.topic_id` pointing at a topic of a different channel only through the API layer (not the schema), so assert only that deleting a topic cascades its messages.
- [ ] **Step 2: Run** `cd backend && node --test test/forum-schema.test.js`; expected FAIL.
- [ ] **Step 3: Implement** the schema (both files for the columns, `migrations.js` for the table and indexes) and `forums.js`; call `ensureAllForums` in `server.js` after the migrations.
- [ ] **Step 4: Run** the new test and `test/schema.test.js`; expected PASS.
- [ ] **Step 5: Commit** `feat(forums): schema and automatic department forums`.

### Task 2: Access and department lifecycle

**Files:** Modify `routes/hr.js` (departments POST, PUT, DELETE), `forums.js`; Test `backend/test/forum-lifecycle.test.js`

**Interfaces:**
- Consumes: Task 1. Produces: `syncForumHead(query, departmentId)` (the head, and only the head, holds the moderator row; a removed or changed head loses it); `renameForum(query, departmentId)`; `archiveForumForDepartment(query, departmentId)`. Creating a department creates its forum; renaming renames it; changing the head syncs it; deleting archives it and clears `forum_department_id`.

- [ ] **Step 1: Write failing tests:** a member of the department reads the forum channel (`GET /api/channels/:id` and history refused until topics exist is Task 4, so assert `GET /api/channels/:id` 200); a member of another department, a person with no department, a guest and an Owner who is not a member with the switch off get 403; moving a person out of the department (change `user_departments`) removes access at once; turning the Owner switch on gives the Owner access; creating a department through `POST /api/hr/departments` creates its forum; renaming updates the channel name (with the clash rule); changing `headId` moves the moderator row and removes the old head's; deleting the department archives the forum (`archived_at` set, `forum_department_id` null) and keeps its topics.
- [ ] **Step 2: Run** `node --test test/forum-lifecycle.test.js`; expected FAIL.
- [ ] **Step 3: Implement** the three functions and call them from the department routes.
- [ ] **Step 4: Run** the new test plus `test/hr.test.js` and `test/channel-permissions.test.js`; expected PASS.
- [ ] **Step 5: Commit** `feat(forums): department lifecycle keeps the forum in step`.

### Task 3: Topics API

**Files:** Create `backend/src/routes/forums.js`; Modify `forums.js` (`loadTopic`, `serializeTopic`), `server.js` (mount `/api/forums`), `attachments.js` (`insertChannelMessage` takes `topicId`); Test `backend/test/forum-topics.test.js`

**Interfaces:**
- Produces: `GET /api/forums/:channelId/topics?archived=0|1&offset=0` -> `{ topics: [{ id, title, createdBy, authorUsername, createdAt, lastActivityAt, replyCount, pinned, locked, archived }], hasMore }` (pinned first, then `last_activity_at` descending, 50 per page); `POST /api/forums/:channelId/topics { title, content, attachmentIds? }` -> 201 `{ topic, message }` and socket event `forum_topic_created { channelId, topicId }` to `channel_<id>`; `PATCH /api/forums/topics/:topicId { title?, pinned?, locked?, archived? }`; `DELETE /api/forums/topics/:topicId`; `insertChannelMessage(query, { ..., topicId })`.

- [ ] **Step 1: Write failing tests:** a department member lists and creates topics (title trimmed, 1 to 120 characters, empty or over-long refused, content required); the opening post exists as a message with `topic_id`; nothing is created in a non-forum channel (400) or by an outsider (403) or a guest (403) or in an archived forum (409); `attachmentIds` of the creator's own uploads attach to the opening post and another person's upload refuses the whole request; list order is pinned first then latest activity, `archived=1` lists archived topics only, paging works; the author renames their own topic and cannot pin, lock or archive; a moderator (the head, or a `manage_messages` holder) pins, locks, archives, renames and deletes; the author deletes their own topic only with no replies; every moderation change writes an audit row; a locked or archived topic refuses a rename by a non-moderator.
- [ ] **Step 2: Run** `node --test test/forum-topics.test.js`; expected FAIL.
- [ ] **Step 3: Implement** the router (fresh `ensureChannelMembership`, `ensureCanPostToChannel` for creation, moderator check as in `ensureChannelModerator`) and the topic-creation transaction.
- [ ] **Step 4: Run** the new test and `test/files.test.js`; expected PASS.
- [ ] **Step 5: Commit** `feat(forums): topics API`.

### Task 4: Posting and history

**Files:** Modify `sockets/chat.js` (`send_message`), `routes/messages.js` (history), `forums.js`; Test `backend/test/forum-posts.test.js` (uses a Socket.IO test client as `huddle.test.js` or the fake-`io` pattern of `command-poll.test.js`, plus HTTP for history)

**Interfaces:**
- Consumes: Task 3. Produces: `send_message { channelId, topicId?, content, ... }` rules; `GET /api/messages/:channelId?topicId=` returns that topic's posts (same shape as channel history); `new_message` payloads carry `topicId`; a helper `ensureTopicOpen(query, channelId, topicId, { forPosting: true })` that throws 400, 404 or 409.

- [ ] **Step 1: Write failing tests:** in a forum channel `send_message` without `topicId` is refused; with a `topicId` of another channel's topic refused; with a valid open topic it posts, sets `topic_id`, raises `last_activity_at` and `replyCount`, and the `new_message` event carries `topicId`; in an ordinary channel a `topicId` is refused; locked and archived topics and an archived forum refuse posts; a banned, timed-out, moved-out or guest user is refused; a reply racing a lock (run both at once, repeat) never ends with a post newer than `locked_at`; `GET /api/messages/:channelId` on a forum without `topicId` is a 400 that says to open a topic, with `topicId` returns only that topic's posts in order, and returns 404 for a topic of another channel; ordinary channel history is unchanged and never contains topic posts.
- [ ] **Step 2: Run** `node --test test/forum-posts.test.js`; expected FAIL.
- [ ] **Step 3: Implement** the checks (the lock race is closed by taking `SELECT ... FOR UPDATE` on the topic row inside the insert transaction) and the history filter.
- [ ] **Step 4: Run** the new test, `test/message-replies.test.js`, `test/channels.test.js`; expected PASS.
- [ ] **Step 5: Commit** `feat(forums): posting and history by topic`.

### Task 5: Search, Files and notification labels

**Files:** Modify `searchService.js`, `routes/files.js`, `sockets/chat.js` (`notifyMessageActivity` preview), `routes/activity.js`; Test `backend/test/forum-search.test.js`

**Interfaces:**
- Produces: `searchWorkspace` results gain `topics: [{ id, channelId, channelName, title }]` and each message and file result gains `topicId`, `topicTitle` (null outside forums); `/api/files` rows gain `topicTitle`; mention and Activity items from a topic include `topicId` and `topicTitle`. Visibility is unchanged (`channelVisibleToUser`).

- [ ] **Step 1: Write failing tests:** a member finds a topic by title, a post by its text and an attachment by file name, each labelled with the topic; a person outside the department, a moved-out person and a non-member Owner (switch off) find none of them, in `GET /api/search`, `/search`, `GET /api/files` and Activity; an existing non-forum search result is unchanged (`topicTitle` null); a mention in a topic produces an Activity item with the topic title.
- [ ] **Step 2: Run** `node --test test/forum-search.test.js`; expected FAIL.
- [ ] **Step 3: Implement** the joins and the extra `topics` query (same visibility predicate, up to 5 results).
- [ ] **Step 4: Run** the new test, `test/search.test.js`, `test/command-help-search.test.js`, `test/channel-content-visibility.test.js`; expected PASS.
- [ ] **Step 5: Commit** `feat(forums): search, files and notifications know about topics`.

### Task 6: Forum screens

**Files:** Create `frontend/src/features/forum-view.js`, `frontend/test/forum-view.test.js`; Modify `routes/channels.js` (channel payload gains `kind` and `forumDepartmentId`), `renderer.js` (open a forum channel, topic list, topic view, new-topic dialog, reply composer, `forum_topic_created` and topic-aware `new_message` handling), `index.html`, `styles.css`

**Interfaces:**
- Produces: `forumTopicListHtml(topics, { canModerate }) -> string`, `forumTopicHeaderHtml(topic, { canModerate }) -> string` (pure, escaped; buttons `data-topic-open`, `data-topic-pin`, `data-topic-lock`, `data-topic-archive`, `data-topic-delete`), constants for badges.

- [ ] **Step 1: Write failing tests** `forum-view.test.js`: the list shows pinned topics first with a Pinned badge, Locked and Archived badges, author, reply count, relative last-activity text (passed in as a string), and escapes every value; an empty list shows an empty-state message; moderation buttons appear only when `canModerate`; the header of a locked topic shows the locked notice.
- [ ] **Step 2: Run** `cd frontend && node --test test/forum-view.test.js`; expected FAIL.
- [ ] **Step 3: Implement** the module, the channel payload fields, and the renderer integration (opening a channel with `kind === 'forum'` shows the topic list instead of the message stream; opening a topic loads `GET /api/messages/:channelId?topicId=` and sends replies with `topicId`; live `new_message` events with a different `topicId` are ignored).
- [ ] **Step 4: Run** `npm test` and `npm run check` in `frontend`, and the backend `test/channels.test.js`; expected PASS. Look at the screens in a browser preview and fix layout problems.
- [ ] **Step 5: Commit** `feat(forums): forum screens`.

### Task 7: Moderation controls

**Files:** Modify `renderer.js`, `styles.css`; Test: additions to `frontend/test/forum-view.test.js`

- [ ] **Step 1: Write failing tests:** Pin, Lock, Archive and Delete buttons render with the right label for the topic's current state (Unpin, Unlock, Unarchive) and the archived-topics toggle renders with its pressed state.
- [ ] **Step 2: Run** `node --test test/forum-view.test.js`; expected FAIL.
- [ ] **Step 3: Implement** the handlers (confirm destructive actions with `confirmAction`; rename in an in-app dialog; call the Task 3 endpoints; refresh the list; show errors as toasts).
- [ ] **Step 4: Run** `npm test` and `npm run check`; expected PASS.
- [ ] **Step 5: Commit** `feat(forums): moderation controls`.

### Task 8: Remove Team Channels

**Files:** Modify `migrations.js`, `database/init.sql`, `routes/settings.js` (sidebar/team routes and team parts of the sidebar), `routes/channels.js`, `routes/moderation.js`, `routes/hr.js`, `routes/people.js`, `frontend/src/features/workspace.js`, `renderer.js`; Delete `backend/src/teamSections.js`; Modify tests `channels.test.js`, `moderation.test.js`, `phase3-department-transition.test.js`, `phase3-groups-sections-source.test.js`, `workspace-sidebar-sections.test.js`; Test `backend/test/team-channels-removal.test.js`

**Interfaces:**
- Produces: a migration that sets `channels.team_section_id = NULL`, converts `membership_source = 'team'` to `'invited'`, then drops `team_sidebar_sections` and the `team_section_id` column (all guarded so a rerun is a no-op); `GET /api/settings/sidebar` no longer returns `teamSections` or `canCreateTeamSections`; the `sidebar/team` routes and the `teamSectionId` channel-creation parameter are gone.

- [ ] **Step 1: Write failing tests** `team-channels-removal.test.js` on a database seeded as before the migration (a team section, a team channel with messages and a file, team-sourced members): after the migration no channel references a section, every message, file and member row is still there, members are `'invited'`, the table and column are gone, and a second run changes nothing; `GET /api/settings/sidebar` works for a user whose stored `sidebar_layout` still names old section ids; the removed routes answer 404; creating a channel with `teamSectionId` ignores or refuses it with a clear error; moving a person's manager no longer touches channel membership; `workspace-sidebar-sections.test.js` still passes without team sections.
- [ ] **Step 2: Run** `node --test test/team-channels-removal.test.js`; expected FAIL.
- [ ] **Step 3: Implement** the migration and remove the server code, the client team-section UI and the dead tests, keeping the rest of the sidebar sections working.
- [ ] **Step 4: Run** the full backend suite (`npm test`) and the frontend `npm test` and `npm run check`; expected PASS.
- [ ] **Step 5: Commit** `feat(forums): remove Team Channels and Team Sections`.

### Task 9: Live verification, docs, handoff

**Files:** Modify `docs/backend.md`, `docs/database.md`, `docs/frontend.md`, `docs/EMPLOYEE_MANAGEMENT.md` as needed; Test: a throwaway live script (not committed)

- [ ] **Step 1:** Back up the database, rebuild the backend (`docker compose up -d --build backend` from PowerShell), then run a live pass with throwaway departments and users: a forum exists for each department, members and outsiders see what they should, create a topic with an attachment, reply, pin, lock, archive, search it, and confirm an existing team channel survived the migration with its messages and members; clean up through the app's own flows.
- [ ] **Step 2:** Update the docs and the palace handoff (one lean CURRENT STATE drawer), re-mine and purge orphans.
- [ ] **Step 3:** Backend `npm test` and frontend `npm run check` and `npm test` all green; commit; push only if the user says so.
