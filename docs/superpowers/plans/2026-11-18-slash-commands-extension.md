# Slash Commands Extension Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make slash commands workspace-wide and ship `/help`, `/search`, `/announce` and `/poll` on a generalized, server-authorized framework.

**Architecture:** Extend the existing `backend/src/commands/` registry and dispatcher with per-command scopes, permissions, categories, shared (broadcast) results behind a one-time confirm token, and a quote/flag-aware parser. Shared results post through the existing message pipeline (`postChannelMessage`) so archive, ban, timeout, slow-mode and permission checks stay in one place. Polls get their own tables linked to a `kind='poll'` message. The client gets one generic private card renderer.

**Tech Stack:** Node.js 24, Express, Socket.IO, PostgreSQL 15 (scratch DB tests via `backend/test/helpers/scratchDb.js`), plain-script Electron renderer, `node:test`.

**Spec:** `docs/superpowers/specs/2026-11-18-slash-commands-extension-design.md` (long-term catalog: `docs/IT_AVENUE_SLASH_COMMANDS_SPEC_EXTENDED.md`).

## Global Constraints

- Command text limit 300 characters; commands that take free text declare `maxLength` (2,000 for `/announce`).
- Confirm token: single use, expires 5 minutes, bound to user + channel + command; table `command_pending`.
- Rate limit stays 30 executions per minute per user (`routes/commands.js`).
- Search: query 2 to 100 characters; command card shows at most 5 results per kind.
- Scopes: `{type:'global'}`, `{type:'any-channel'}` (channel not personal), `{type:'channel-scope', value}` with values `hr-inquiry` and `announcements`; a channel has at most one tag; `hr-inquiry` cannot be re-tagged.
- Permission key `announce` (label "Post announcements with /announce"); Owners hold it; guests are refused unless a command sets `allowGuests: true` (none do).
- `messages.kind` values: `message` (default), `announcement`, `poll`.
- Poll: question 1 to 200 characters, 2 to 10 options of 1 to 100 characters, flags `--multi`, `--anonymous`, `--closes <n>m|h|d` (max 30 days); single choice by default; named voters unless anonymous; not offered in `#hr-inquiry`.
- Private results are never inserted as messages, never emitted to a channel room, never searchable. New commands never bypass archive read-only, bans, timeouts, slow mode, or the Owner private-channel switch.
- Dialogs only from `frontend/src/features/dialogs.js`; no native confirm/alert/prompt (build check fails otherwise). Schema changes go in both `database/init.sql` and `backend/src/migrations.js`.
- Windows + Git Bash; files are CRLF. Use the Write tool for scripts with quotes or backslashes. Push to `main` only when the user says so.

## Review Focus

1. Unbalanced quote, empty quoted argument, emoji, and over-long text in a command give a clear private error and never post (Task 1 tests; Task 5 and 6 refusal tests).
2. A shared command confirmed after the channel was archived, or the user was banned, timed out or removed, between preview and confirm is refused (Task 2 test).
3. A confirm token used twice, after expiry, or by another user or in another channel is refused (Task 2 test).
4. Concurrent or repeated votes never leave a single-choice poll with two votes for one user, and anonymous polls never return voter identities from any endpoint (Task 6 tests).
5. Announcement and poll text containing HTML or `<script>` is rendered escaped, and guests and removed members calling confirm or vote endpoints directly are refused (Task 5, 6 tests).

## File Structure

- `backend/src/commands/parser.js` (modify): quote- and flag-aware parsing.
- `backend/src/commands/registry.js` (modify): definition shape, `scopes`, `category`, `usage`, registration of new handlers.
- `backend/src/commands/dispatcher.js` (modify): scope and permission evaluation, shared + confirm flow, `confirmPending`.
- `backend/src/commands/handlers/general.js` (create): `help`, `search`. `announce.js`, `poll.js` (create): the other two.
- `backend/src/searchService.js` (create): shared search used by `routes/search.js` and `/search`.
- `backend/src/polls.js` (create): poll create/vote/close/serialize; `backend/src/routes/polls.js` (create): HTTP voting.
- `backend/src/routes/commands.js` (modify): `POST /api/commands/confirm`, pass `io`.
- `backend/src/messageDelivery.js`, `backend/src/routes/messages.js` (modify): carry `kind` and `poll` on messages.
- `backend/src/permissions.js` (modify): `announce`. `backend/src/routes/moderation.js` (modify): channel tag endpoint.
- `frontend/src/features/command-cards.js` (create, pure functions, tested), `frontend/src/features/polls.js` (create), `renderer.js`, `index.html`, `styles.css`, `features/admin.js` or the Moderation channel panel (modify).
- Tests: `backend/test/command-parser.test.js`, `command-framework.test.js`, `command-help-search.test.js`, `command-announce.test.js`, `command-poll.test.js`, `frontend/test/command-cards.test.js` (create).

---

### Task 1: Parser with quotes, flags and per-command length

**Files:** Modify `backend/src/commands/parser.js`; Test `backend/test/command-parser.test.js`

**Interfaces:**
- Produces: `parseCommand(input: string, { maxLength?: number, flagsFor?: (name: string) => Record<string, boolean> | undefined } = {}) -> { name: string, args: string[], options: Record<string, true | string> }`. `flagsFor(name)` maps a flag name to `takesValue`. Existing callers keep working (`args` stays a string array; `options` is `{}` when no flags).

- [ ] **Step 1: Write failing tests** in `command-parser.test.js`: `'/poll "Lunch?" "Pizza" "Sushi"'` gives `args` of exactly those three strings with spaces kept inside quotes; `'--multi --closes 2h'` with `flagsFor = () => ({ multi: false, closes: true })` gives `options` `{ multi: true, closes: '2h' }`; unknown flag `--nope` throws status 400; unbalanced quote `'/poll "Lunch?'` throws 400 with a message containing `quote`; empty quoted argument `'/poll ""'` throws 400; emoji and non-ASCII are preserved; length over `maxLength` (default 300) throws 400; a flag that needs a value but has none throws 400; `'/leave-remaining sick'` still yields `{ name: 'leave-remaining', args: ['sick'], options: {} }`.
- [ ] **Step 2: Run** `cd backend && node --test test/command-parser.test.js`; expected FAIL.
- [ ] **Step 3: Implement** the tokenizer (double quotes group, backslash-escaped quote allowed, `--name` and `--name=value` flags) keeping the existing error style (`Object.assign(new Error(...), { status: 400 })`).
- [ ] **Step 4: Run** the new test and `node --test test/commands.test.js`; expected all PASS.
- [ ] **Step 5: Commit** `feat(commands): quote and flag aware parser`.

### Task 2: Framework: scopes, permissions, shared results, confirm tokens

**Files:** Modify `registry.js`, `dispatcher.js`, `routes/commands.js`, `database/init.sql`, `backend/src/migrations.js`; Test `backend/test/command-framework.test.js` (DB-backed, mount only `routes/commands.js`)

**Interfaces:**
- Consumes: Task 1 `parseCommand`.
- Produces: definition shape `{ name, aliases, category, usage, description, scopes, permission: string | null, visibility: 'private' | 'shared', options: Record<string, boolean>, maxLength?: number, allowGuests?: boolean, arguments, enabled, auditPolicy, confirm?: { preview: (ctx, args, options) => Promise<{ title, message, confirmLabel }> }, handler: (ctx, args, options) => Promise<response> }`; context `ctx = { userId, channelId, channelScope, isPersonal, io, query }`; `dispatch({ userId, channelId, input, requestId, io })` may return `{ kind: 'confirm', token, title, data: { message }, confirmLabel }`; `confirmPending({ userId, channelId, token, io }) -> response`; `GET /api/commands` rows now include `category` and `usage`; `POST /api/commands/confirm` body `{ channelId, token }`.
- Table `command_pending(id SERIAL PK, token_hash TEXT UNIQUE, user_id INT, channel_id INT, input TEXT, expires_at TIMESTAMPTZ)`.

- [ ] **Step 1: Write failing tests** (register throwaway test definitions in the test via a `registry.definitions.push`): `global` command allowed in any channel including a personal channel; `any-channel` refused in a personal channel; `channel-scope:announcements` refused in an untagged channel even when called directly through `POST /api/commands/execute`; renaming a tagged channel keeps access; `permission: 'announce'` refused for a plain member and allowed for an Owner; a guest is refused; a `shared` command with `confirm` returns `kind:'confirm'` and posts nothing, then `POST /api/commands/confirm` with the token posts exactly one message via `postChannelMessage`; reusing the token fails (400/404); an expired token fails; another user or another channel using the token fails; archiving the channel, banning or timing out the user, or removing them from the channel between preview and confirm makes confirm fail without posting; private results create no `messages` row; `GET /api/commands` returns `category` and `usage`.
- [ ] **Step 2: Run** `node --test test/command-framework.test.js`; expected FAIL.
- [ ] **Step 3: Implement** `allowed(definition, context)` over the three scope types; permission via `can(query, userId, definition.permission, { channelId })` after membership; guest check on `account_type`; for `visibility:'shared'` with `confirm`, store `sha256(token)`, the raw `input`, user, channel, 5-minute expiry; `confirmPending` deletes the row with `DELETE ... RETURNING` (single use), then re-runs the full authorization path and the handler. Add the table to `init.sql` and `migrations.js`. Pass `req.io` from the routes.
- [ ] **Step 4: Run** the new test, `test/commands.test.js`, and `test/schema.test.js` (init vs migrations parity); expected PASS.
- [ ] **Step 5: Commit** `feat(commands): scopes, per-command permission, shared results with confirm tokens`.

### Task 3: Client generic card, grouped menu, confirm flow

**Files:** Create `frontend/src/features/command-cards.js`, `frontend/test/command-cards.test.js`; Modify `renderer.js` (`renderPrivateCommandResponse`, `updateCommandMenu`, `executeSlashCommand`), `index.html` (script tag before `renderer.js`), `styles.css`

**Interfaces:**
- Produces: `commandCardHtml(response, commandText): string` (pure; escapes everything; supports `data.message`, `data.table = { head: string[], rows: string[][] }`, `data.list = { title, text }[]`, `data.note`, the existing leave fields, and actions from the allowlist `open-route` (`route: 'leave' | 'search'`, optional `query`) and `cancel-leave`), `groupCommandsByCategory(items): { category, items }[]`.

- [ ] **Step 1: Write failing tests** in `command-cards.test.js`: leave response renders the same table and request rows as before (assert a few cells); table and list render with HTML in values escaped (`<script>` becomes `&lt;script&gt;`); an action with an unknown `type` or `route` renders no button; grouping orders categories `general, search, announcements, polls, hr` and keeps command order.
- [ ] **Step 2: Run** `cd frontend && node --test test/command-cards.test.js`; expected FAIL.
- [ ] **Step 3: Implement** the module (guard `module.exports` like `format.js`), switch `renderer.js` to it, group the menu by category with `usage` shown, and in `executeSlashCommand` handle `kind:'confirm'` with `confirmAction({ title, message, confirmLabel, danger: false })` then `POST /api/commands/confirm`; render the returned acknowledgement as a card.
- [ ] **Step 4: Run** `npm test` and `npm run check` in `frontend`; expected PASS.
- [ ] **Step 5: Commit** `feat(commands): generic private cards, grouped menu, confirm flow`.

### Task 4: `/help` and `/search`

**Files:** Create `backend/src/searchService.js`, `commands/handlers/general.js`; Modify `routes/search.js`, `registry.js`, `renderer.js` (handle `open-route` `search`); Test `backend/test/command-help-search.test.js`

**Interfaces:**
- Produces: `searchWorkspace(query, userId, term: string) -> { messages, directMessages, people, files }` (the exact JSON `GET /api/search` returns today); `/help [command]` (global, private, category `general`); `/search <keywords>` (global, private, category `search`).

- [ ] **Step 1: Write failing tests:** existing `test/search.test.js` still passes unchanged after extraction; `/help` in an ordinary channel lists `help` and `search` but not leave commands, in `#hr-inquiry` also lists leave commands; `/help leave` returns that command's usage and description, `/help nope` returns a private "unknown command"; `/search needle` returns at most 5 rows per kind, never a private channel's message the user cannot read, respects the Owner switch (Owner not a member sees nothing while off), refuses a 1-character and a 101-character query with 400, and creates no `messages` row; the card includes an `open-route` action with `route: 'search'` and the query.
- [ ] **Step 2: Run** the new test; expected FAIL.
- [ ] **Step 3: Extract** the query body of `routes/search.js` into `searchWorkspace` (no behavior change), implement both handlers, move the old `help` alias off `/hr-help`, and wire `open-route search` to the existing Search view with the query prefilled.
- [ ] **Step 4: Run** `node --test test/command-help-search.test.js test/search.test.js test/commands.test.js`; expected PASS.
- [ ] **Step 5: Commit** `feat(commands): /help and /search`.

### Task 5: `/announce`

**Files:** Create `commands/handlers/announce.js`; Modify `permissions.js`, `database/init.sql`, `migrations.js` (`messages.kind`, tag `#announcements`), `defaultChannels.js` (tag on ensure), `messageDelivery.js` (`postChannelMessage({..., kind})`), `routes/messages.js` (return `kind`), `routes/moderation.js` (`PATCH /channels/:channelId/command-scope`), `renderer.js` + `styles.css` (announcement styling), the Moderation channel panel (tag control); Test `backend/test/command-announce.test.js`

**Interfaces:**
- Consumes: Task 2 shared + confirm. Produces: `PATCH /api/moderation/channels/:channelId/command-scope` body `{ scope: 'announcements' | null }` (requires `manage_channels`, audited as `channel_command_scope_changed`, 409 for a channel tagged `hr-inquiry` or a personal channel); `/announce <text>` (scope `announcements`, permission `announce`, shared, confirm preview "This posts to #<name>, visible to <N> members"); message payload field `kind`.

- [ ] **Step 1: Write failing tests:** refused in an untagged channel, for a member without `announce`, for a guest, in an archived channel and for a banned or timed-out user; allowed for an Owner and for a role granted `announce`; first call posts nothing and returns the preview with the member count; confirming posts exactly one message with `kind='announcement'` and the exact text; text over 2,000 characters refused; HTML in the text is stored verbatim and the GET messages payload carries `kind: 'announcement'`; tag endpoint rules (permission, audit row, refuses `hr-inquiry` and personal channels); built-in `#announcements` is tagged after migrations; `permissions` catalogue includes `announce` and the Roles screen lists it.
- [ ] **Step 2: Run** `node --test test/command-announce.test.js`; expected FAIL.
- [ ] **Step 3: Implement** column `messages.kind VARCHAR(20) NOT NULL DEFAULT 'message'` in both schema files, the tag endpoint and control, the handler (posts through `postChannelMessage`), and the client style (megaphone label, highlight) in the message renderer, escaping text as for normal messages.
- [ ] **Step 4: Run** the new test, `test/permissions.test.js`, `test/roles.test.js`, `test/schema.test.js`, then `npm test` and `npm run check`; expected PASS.
- [ ] **Step 5: Commit** `feat(commands): /announce with announcement channels and announce permission`.

### Task 6: `/poll`

**Files:** Create `backend/src/polls.js`, `routes/polls.js`, `commands/handlers/poll.js`, `frontend/src/features/polls.js`; Modify `database/init.sql`, `migrations.js`, `server.js` (mount `/api/polls`), `routes/messages.js` and `messageDelivery.js` (attach `poll`), `index.html`, `styles.css`, `renderer.js` (render `kind='poll'`, handle `poll_updated`); Test `backend/test/command-poll.test.js`

**Interfaces:**
- Produces: tables `polls`, `poll_options`, `poll_votes` as in the spec; `createPoll(io, query, { userId, channelId, question, options, multiple, anonymous, closesAt }) -> messageData` (message `kind:'poll'` plus `poll` object); `serializePoll(query, pollId, viewerId) -> { id, question, multiple, anonymous, closesAt, closed, options: [{ id, label, count, voters?: string[] }], myOptionIds: number[] }` (`voters` omitted when anonymous); routes `POST /api/polls/:id/vote { optionIds }`, `DELETE /api/polls/:id/vote`, `POST /api/polls/:id/close`; socket event `poll_updated { pollId, channelId }` to `channel_<id>` carrying counts only.

- [ ] **Step 1: Write failing tests:** `/poll "Lunch?" "Pizza" "Sushi"` posts one `kind='poll'` message whose content is the question and creates 2 options; refused for fewer than 2 or more than 10 options, an over-long question or option, unknown flags, a guest, an archived channel and in `#hr-inquiry`; vote on a single-choice poll replaces the previous vote and two concurrent votes by one user leave exactly one row; `--multi` accepts several and rejects zero for POST; withdraw works; vote refused when closed, archived, not a member, guest or banned; creator and a channel moderator can close, others get 403; `--closes 1m` auto-closes lazily (set `closes_at` in the past in the test) on the next vote and read; non-anonymous poll lists voter usernames to members, anonymous poll's responses (poll GET, vote response, socket payload, messages payload) never contain any voter identity; `GET /api/messages/:id` carries the `poll` object with the viewer's `myOptionIds`; HTML in the question is stored verbatim.
- [ ] **Step 2: Run** `node --test test/command-poll.test.js`; expected FAIL.
- [ ] **Step 3: Implement** the schema (both files), `polls.js` (transactional create; vote replacement inside one transaction with `DELETE` then `INSERT` and a row lock on the poll), routes with fresh authorization via `ensureChannelMembership`, `ensureChannelNotArchived`, guest and ban checks, the command handler (parser flags `multi`, `anonymous`, `closes`), message payload and socket event, and the poll card in `features/polls.js` (escape all text, bars and counts, vote buttons, Close for allowed users).
- [ ] **Step 4: Run** the new test then `npm test` and `npm run check`; expected PASS.
- [ ] **Step 5: Commit** `feat(commands): /poll with voting, closing and anonymous polls`.

### Task 7: Live verification, docs, handoff

**Files:** Modify `docs/IT_AVENUE_SLASH_COMMANDS_SPEC.md` (implemented list), `docs/backend.md`; Test: a throwaway live script (not committed)

- [ ] **Step 1:** Take a DB backup, run `rebuild-backend.cmd` (or tell the user to), then run a live pass with throwaway `p5*` fixtures and `p5run-*` channels: `/help` and `/search` in an ordinary channel; `/announce` refused in an untagged channel, tag a throwaway channel, preview then confirm posts one announcement; `/poll` create, vote, change vote, close, anonymous; clean up through the app's delete flow; counts identical before and after.
- [ ] **Step 2:** Update the spec's "Implemented" list and `docs/backend.md` endpoints; replace the palace handoff with one lean CURRENT STATE drawer per `MEMPALACE_SETUP.md` section 6; re-mine and purge per section 5.
- [ ] **Step 3:** `npm test` (backend) and `npm run check` (frontend) all green; commit; push only if the user says so.
