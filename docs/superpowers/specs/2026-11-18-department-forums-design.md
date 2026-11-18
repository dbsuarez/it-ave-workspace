# Department forums (replacing Team Channels): design

**Date:** 2026-11-18 · **Status:** awaiting approval

## 1. Intent and why

Team Channels (channels a leader creates for their direct reports, found under a leader's Team Section) are being removed.
In their place each department gets its own Discord-style **forum**: a private space where any member of that
department can start unlimited **topics**, each with a title and its own conversation. The user wants departments
isolated in their own forum so a department's discussions stay with that department and old topics stay findable.

## 2. Goals, non-goals, anti-goals

**Goals**
- Every department has exactly one forum. Only people currently in that department can see it, read it, start topics
  and reply. The department head moderates it.
- Anyone in the department can start as many topics as they like. A topic has a title, an opening post, replies,
  attachments and reactions. The topic list is sorted by latest activity, with pinned topics first.
- Search (the Search box and `/search`) and the Files view find topics, posts and attachments (by file name), labelled
  with the topic they live in, for members of that department only.
- Team Channels and Team Sections are removed. Existing team channels become ordinary private channels with the same
  members; nothing is deleted.

**Non-goals (first version)**
- Per-topic unread counts (the forum shows activity at forum level, like a channel), topic tags or categories, moving a
  topic to another forum, forums shared by several departments, searching inside file contents, the phone app.
- Changing "My team" in People (it follows reporting lines and has nothing to do with channels).

**Anti-goals** (a failure even if it "works")
- Anyone outside the department reading a topic, post or attachment by any route: channel history, search, Files,
  Activity, notifications, sockets, links, or `/search`. An Owner who is not a member sees nothing unless the existing
  "Owner access to private channels" switch is on.
- Forum posts appearing in the history of any other channel, or ordinary channels gaining topic behaviour.
- Losing any message or file from the existing team channels during the removal.

## 3. Constraints (what the code already does)

- A forum is a **channel**, so access, bans, timeouts, slow mode, archive, search visibility (`channelVisibilitySql.js`),
  file access and sockets keep working. Department access already exists: department grants and live membership by
  department, used by department channels.
- Messages live in `messages` (reactions, files, edits, mentions, search all hang off a message). Posting goes through
  `ensureCanPostToChannel`; live posting is the Socket.IO `send_message` handler.
- Schema: tables in `migrations.js`; columns on existing tables in both `migrations.js` and `database/init.sql`.
- Team Channels touch: `teamSections.js`, `routes/settings.js` (sidebar/team routes), `routes/channels.js`,
  `routes/moderation.js`, `routes/hr.js`, `routes/people.js`, `frontend/src/features/workspace.js`, `renderer.js`, the
  schema, and five test files.
- Dialogs only from `features/dialogs.js`; tests first; backend and frontend suites stay green.

## 4. Approaches considered

- **A. A forum channel type with topics (chosen by the user).** One channel per department (`kind = 'forum'`), a
  `forum_topics` table, and posts stored as ordinary messages carrying a `topic_id`. Reuses reactions, files, mentions,
  edits, search and access. Cost: places that assume "a channel is one stream" (history, unread, notifications, search
  labels) must learn about topics.
- B. Each topic is its own channel: simplest, but unlimited topics would bury every channel list. Rejected.
- C. A topic is a titled thread in an ordinary department channel: cheapest, but flat and not a forum. Rejected.

## 5. Design

### 5.1 Data
- `channels.kind VARCHAR(20) NOT NULL DEFAULT 'channel'` (`'channel'` or `'forum'`) and
  `channels.forum_department_id INTEGER UNIQUE REFERENCES departments(id) ON DELETE SET NULL`.
- `forum_topics(id, channel_id, title VARCHAR(120), created_by, created_at, last_activity_at, pinned_at, locked_at,
  archived_at)`, indexed on `(channel_id, pinned_at, last_activity_at DESC)`.
- `messages.topic_id INTEGER REFERENCES forum_topics(id) ON DELETE CASCADE`. Rule: a message in a forum channel always
  has a `topic_id`; a message anywhere else never does. The opening post is the topic's first message.

### 5.2 Forums and access
- A forum is created automatically for every department: a migration backfills the existing departments and creating a
  department creates its forum. Name `dept-<department name>` in the channel-name format; private; slow mode 0.
- Access is the department's: the forum carries the department grant, so whoever is in the department now can read and
  post, and a person who is moved out loses access by themselves (the same live rule department channels use).
- The department head holds a channel-moderator row, kept in step when headship changes. Others who moderate: holders
  of `manage_messages`, and Owners (subject to the private-channel switch).
- Deleting a department archives its forum (content kept); an Owner may delete it afterwards.

### 5.3 API
- `GET /api/forums/:channelId/topics?archived=0|1&offset=` returns each topic with title, author, createdAt,
  lastActivityAt, replyCount, pinned, locked, archived.
- `POST /api/forums/:channelId/topics { title, content, attachmentIds? }` creates the topic and its opening post in one
  transaction and emits `forum_topic_created { channelId, topicId }`.
- `GET /api/messages/:channelId?topicId=` returns that topic's posts (same shape as channel history). A history request
  for a forum channel without `topicId` is refused with a clear message.
- Replies use the existing `send_message` event with `{ channelId, topicId, content }`. The server requires a `topicId`
  in forum channels and none elsewhere, requires the topic to belong to the channel and be open (not locked or
  archived), and updates `last_activity_at`. `new_message` carries `topicId`; clients show only the topic they have open.
- `PATCH /api/forums/topics/:topicId { title?, pinned?, locked?, archived? }`: the author renames their own topic;
  moderators pin, lock, archive. `DELETE /api/forums/topics/:topicId`: moderators, or the author while there are no
  replies. All are audited like other moderation actions.

### 5.4 Search, files, notifications
- Search results for a post carry `topicId` and `topicTitle`; topic titles are searched too and appear as "Topic"
  results. Attachment results (matched by file name, as today) show the topic. The Files view shows the topic name.
- Mention notifications and Activity items from a topic include the topic title and open that topic.

### 5.5 Client
- Opening a forum channel shows: a header with a "New topic" button (title, first post, attachments in the in-app
  dialog), a filter box for topic titles, and the topic list (pinned first, then by latest activity; locked and archived
  badges; an "Archived" toggle). Opening a topic shows its posts and the usual composer, or a "This topic is locked"
  notice. The channel list shows each person's own department forum; no one sees other departments' forums.
- Topic and forum views follow the existing rendering for posts (formatting, reactions, files, edits).

### 5.6 Removing Team Channels
- A migration detaches every channel from its team section (`team_section_id = NULL`), converts team-sourced
  memberships (`membership_source = 'team'`) to `'invited'` so nothing is removed, then drops `team_sidebar_sections`
  and the `team_section_id` column. The Team Section routes, `syncReportTeamChannels` calls, "create a team section",
  team-channel creation and the sidebar's team and inherited-section handling are removed from the server and client;
  tests that covered them are removed or rewritten. Existing team channels simply appear as ordinary private channels.

## 6. Decided by the builder (the user can overrule any of these)
1. Topic title 1 to 120 characters; posts follow the existing message length limit.
2. Forums are created automatically per department, named `dept-<name>`; no separate department files channel (topics
   carry attachments).
3. Department deletion archives the forum instead of deleting it.
4. No per-topic unread counts in this version; the forum shows activity at forum level.
5. A topic author may delete their own topic only while it has no replies.
6. Search matches topic titles, posts and attachment file names, not the contents of files.

## 7. Testing and verification
- Backend (real PostgreSQL): access (department members only, a moved person loses access, Owner needs the switch,
  guests refused, banned and timed-out rules); creating topics and posts (a forum post needs a topic, other channels
  refuse a `topicId`, locked and archived topics refuse replies, `last_activity_at` updates, ordering with pins);
  history by topic and the refusal without one; moderation (permissions, audit); search and Files visibility including
  the topic labels and attachment names; the head's moderator row following headship; backfill and idempotent migration;
  department deletion archives the forum; Team Channel removal (memberships and messages untouched, columns and routes
  gone).
- Frontend: tested pure renderers for the topic list and topic header, the build check, and an in-browser look.
- After building, a live pass on the real stack with throwaway data, as for the earlier features.

## 8. Order of work
1. Forum data, access and API (backend). 2. Forum screens (client). 3. Moderation, head-as-moderator, search and
notification labels. 4. Remove Team Channels and migrate the existing ones. Each step ships on its own.
