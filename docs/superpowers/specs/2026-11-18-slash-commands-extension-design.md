# Slash commands extension: design

**Date:** 2026-11-18 · **Status:** awaiting approval · **Source:** `docs/IT_AVENUE_SLASH_COMMANDS_SPEC_EXTENDED.md` (the long-term catalog); this document is the first slice of it.

## 1. Intent and why

The slash-command system exists but only serves HR: 12 leave commands, usable only in `#hr-inquiry`. The user wants it to become a workspace-wide system, starting with four commands people will actually reach for: `/help`, `/search`, `/announce` and `/poll`. They asked whether commands must be on every channel; the decision is **no** (see section 4, option A).

## 2. Goals, non-goals, anti-goals

**Goals**
- Commands can be offered globally, in ordinary channels, or only in channels carrying a specific tag, decided per command.
- `/help`, `/search`, `/announce` and `/poll` work end to end, with tests, and are verified on the live stack.
- Each piece ships and is useful on its own, in this order: framework + `/help` + `/search`, then `/announce`, then `/poll`.

**Non-goals (this slice)**
- The other ~90 commands in the extended spec (messages, calls, files, tasks, IT tickets, directory, admin), HR attendance and ticket commands, DM-based commands, the mobile PWA.
- Notifications that force a push to everyone for announcements.

**Anti-goals** (a failure even if it "works")
- A command result visible to someone it shouldn't be (private results must never be broadcast, stored as messages, or searchable).
- `/announce` usable in a channel that was not designated for announcements.
- A retry or reconnect that posts an announcement or poll twice.
- A new command quietly bypassing archive read-only, bans, timeouts, slow mode, or the Owner private-channel switch.

## 3. Constraints (what the code already does)

- `backend/src/commands/`: `registry.js` (definitions), `parser.js` (whitespace-split, 300 characters), `dispatcher.js` (membership check, scope check, audit row in `command_audit_log`), routes `GET /api/commands?channelId=` and `POST /api/commands/execute` (30 per minute per user).
- A command is allowed only if its `scopes` contain `{type:'channel-scope', value}` equal to the channel's immutable `channels.command_scope` (today only `hr-inquiry`). Responses are always private and rendered by `renderPrivateCommandResponse` in `renderer.js`, which hard-codes leave fields.
- The composer already intercepts a leading single `/` in every channel (unknown commands answer privately; `//` posts a literal `/`).
- A built-in `#announcements` channel exists (`defaultChannels.js`, "Official company announcements", available to all).
- Permissions are a catalogue in `permissions.js` checked with `can(query, userId, key, {channelId})`; roles and the Roles screen read the catalogue.
- Search is `GET /api/search` (`routes/search.js`) using `channelVisibilitySql.js`, so it already respects private channels and the Owner switch.
- Posting goes through `ensureCanPostToChannel` / `postChannelMessage`, which already enforce membership, archive, timeouts, slow mode and channel permissions.
- Dialogs: only `features/dialogs.js` (native confirm/alert/prompt fail the build check).

## 4. Approaches considered (where commands are available)

- **A. Each command declares where it works (chosen by the user).** Scope types: `global`, `any-channel` (shared, non-personal), `channel-scope:<tag>`. `/help` and `/search` are global; `/poll` is any-channel; `/announce` is `channel-scope:announcements`. Reuses the immutable tag mechanism, so renaming a channel cannot grant or remove a command.
- B. Same commands everywhere: simplest, but `/announce` would work in any channel, which defeats the point. Rejected.
- C. Per-channel on/off switch: most control, but an Owner has to switch it on per channel. Rejected as too much admin work for the value.

## 5. Design

### 5.1 Framework (first, enables the rest)
- **Scopes.** `allowed(definition, context)` accepts `{type:'global'}`, `{type:'any-channel'}` (channel is not personal) and the existing `{type:'channel-scope', value}`. A channel has at most one tag.
- **Per-command permission.** `permission` is `null` (any workspace member) or a permission key checked with `can()` in the channel's context. The existing `hr.leave.read_self` string keeps its current meaning (members only). Guests are refused by default; a command opts in explicitly.
- **Category and usage.** Each definition gets `category` (`general`, `search`, `announcements`, `polls`, `hr`) and `usage`. `GET /api/commands` returns them; the menu groups by category and shows usage.
- **Visibility `shared`.** A handler may return `{visibility:'shared', ...}`; the dispatcher then performs the write through the existing message pipeline (so archive, ban, timeout, slow mode and permission checks all apply) and returns a small private acknowledgement. Private results stay out of messages, sockets and search, as today.
- **Confirmation for broadcasts.** A shared command first returns `kind:'confirm'` with a preview and a one-time token stored server-side (`command_pending`: user, channel, command, argument hash, expires in 5 minutes). `POST /api/commands/confirm {token}` re-checks scope and permission, runs it once, and deletes the token. This also makes retries idempotent.
- **Parser.** Supports double-quoted arguments and `--flag` / `--name value` options; rejects unknown options; length limit raised to 2,000 characters for commands that take text (per-command `maxLength`).
- **Client.** Replace the leave-specific card with a generic private card (title, text, table, list, link-style actions from an allowlist, one `confirm` kind); keep the leave output visually unchanged by mapping it to the generic shape. The menu shows only what `GET /api/commands` returns for the current channel.
- The canvas editor's own slash menu is a separate surface and is untouched.

### 5.2 `/help` and `/search` (global, private)
- `/help [command]` lists the commands available in this channel grouped by category with usage; `/help leave` shows one command. `/hr-help` stays as the HR-only list; the old `help` alias of `/hr-help` moves to the global command.
- `/search <keywords>` runs the same logic as the Search box (shared function extracted from `routes/search.js`, no duplicated SQL) and returns up to 5 results each for messages, people and files in a private card, plus an "Open all results" action that opens the existing Search view with the query. Same 2 to 100 character limits and the same visibility rules as the API.

### 5.3 `/announce` (scope `announcements`, shared)
- **Where.** Channels with `command_scope = 'announcements'`. The built-in `#announcements` gets the tag by migration (and in `ensureDefaultChannels`). A new control in the Moderation channel panel (Owners and `manage_channels`) marks or unmarks other channels via `PATCH /api/moderation/channels/:id/command-scope`; a channel with the `hr-inquiry` tag cannot be re-tagged.
- **Who.** New permission `announce` in the catalogue ("Post announcements with /announce"). Owners have it; roles such as HR or Management can be given it. It is also subject to the normal posting checks (membership, not archived, not banned or timed out).
- **What.** `/announce <text>` (up to 2,000 characters) shows a preview ("This posts to #announcements, visible to N members") with Post / Cancel in the in-app dialog. On Post it inserts a normal message with `messages.kind = 'announcement'` (new column, default `'message'`), shown with a megaphone label and highlight. It follows ordinary notification rules; nothing forces a push in this slice.
- Audited in `command_audit_log` (metadata only); the message itself is the record of content.

### 5.4 `/poll` (scope any-channel, shared)
- **Syntax.** `/poll "Question?" "Option A" "Option B" ["Option C" ...] [--multi] [--anonymous] [--closes 2h]`: 2 to 10 options, question up to 200 characters, option up to 100.
- **Storage.** `polls` (id, channel_id, message_id, created_by, question, multiple, anonymous, closes_at, closed_at, created_at), `poll_options` (id, poll_id, position, label), `poll_votes` (poll_id, option_id, user_id, voted_at; one row per user per option). Creating a poll inserts the `kind='poll'` message (content is the question, so search and exports have it) and the poll rows in one transaction.
- **Voting.** `POST /api/polls/:id/vote {optionIds}` replaces the caller's votes (single choice: exactly one; `--multi`: any number). Re-authorized every time: channel membership, channel not archived, poll not closed, not a guest, not banned. `DELETE /api/polls/:id/vote` withdraws. Results and `poll_updated` socket events go to the channel room as counts only; named voters are visible to members unless the poll is anonymous (then never returned by any endpoint).
- **Closing.** The creator or a channel moderator closes it (`POST /api/polls/:id/close`); `closes_at` is enforced lazily on every read and vote, no scheduler.
- **Client.** Messages with `kind='poll'` render an interactive card (options with bars and counts, your vote, Close for allowed people).
- Not offered in `#hr-inquiry` (a private-lookup channel).

## 6. Decided by the builder (the user can overrule any of these)
1. `announce` is a new permission, Owners only until a role is given it.
2. Announcements are a message flavor in the channel with a preview and confirm step; no forced notifications.
3. Polls: single choice by default, named voters, no closing time, no confirmation step (a poll is low risk; retries are de-duplicated by request ID).
4. `/hr-help` keeps listing HR commands; `/help` is the global list.
5. Search results in the command card are capped at 5 per kind.
6. Desktop client only in this slice.

## 7. Testing and verification
- Unit and database-backed tests: each scope type (a command outside its scope is refused even when called directly); per-command permission; private results never in messages, room broadcasts or search; shared commands go through archive, ban, timeout and slow-mode checks; confirm token one-time, expiring, bound to user, channel and arguments; `/search` visibility including the Owner switch and private channels; `/announce` refused in a non-announcement channel, without the permission, and for guests; poll lifecycle (create, vote, change vote, multi, withdraw, close, lazy auto-close, anonymous never leaks voters, archived read-only, guest refused); parser quoting and flags; frontend build check and an in-browser check of the generic card, announcement and poll rendering.
- After building, a live pass on the real stack with throwaway data, as for Phase 5.

## 8. Order of work
1. Framework + `/help` + `/search` (ship). 2. `/announce` (ship). 3. `/poll` (ship). The extended spec's remaining commands stay a catalog for later slices; every new command is a registry entry plus a handler on this framework.
