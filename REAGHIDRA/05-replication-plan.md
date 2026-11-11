# 05. Replication plan: our Lists and Canvas

How to take the documented behaviour in [03](03-canvas-behaviour.md) and [04](04-lists-behaviour.md)
and build our own, starting from what the app already has. Everything here is our design, written
from behaviour descriptions. Nothing is taken from Slack's code.

Status: **plan only; nothing from it is implemented.** Decisions that need your input are listed at
the end.

> **Re-aligned after Canvas 2.0.** While this research was being written, other work landed in the
> repository (commits `8771c52`, `3dd6027`, `2d0aeaf`): a new Canvas system with channel, DM and
> standalone canvases, viewer/editor collaborators, share links and live sync. Section 1 below
> describes the code **as it is now**. Lists were not touched.

## 1. What we have today

### Canvas: two systems side by side

| | **Canvas 2.0** (`routes/canvas.js`, `/api/canvas`, table `canvases`) | **Legacy** (`routes/canvases.js`, `/api/canvases`, table `channel_canvases`) |
|---|---|---|
| Kinds | `channel` (one per channel, enforced by a unique index), `dm` (one per pair of people), `standalone` | Channel only, many per channel |
| Content | One Markdown string, max 100,000 characters; title max 160 | Same; title max 120 |
| Editing | `PATCH` title and/or the **whole** content; the client auto-saves | `PUT` whole title and content |
| Who may open or edit | Channel canvas: channel members. DM canvas: the two people. Standalone: the creator plus collaborators with `viewer` or `editor` | Any channel member |
| Who may delete | Standalone: its owner. Others: the creator, a channel moderator, or a Superadmin | Any channel member |
| Sharing | Collaborator list; **share links** (random token, `viewer` or `editor`, optional expiry; an expired link returns 410; editing through a link needs `editor`) | None |
| Live updates | Socket.IO room `canvas:<id>`; every save broadcasts `canvas_updated` with the new content | None |

The desktop client uses Canvas 2.0 for the right-hand sheet (channel and DM canvases) and the standalone
manager (rail button "Canvas"). The old system is kept on purpose and relabelled **"Wiki"**; its routes and
table are unchanged.

What neither system has: **any revision or conflict check** (the server accepts every write, so a
stale editor still overwrites a newer save even though live updates now show other people's saves),
section-based edits, history, and a block-aware editor. Whether the Canvas 2.0 preview supports more
than the old headings/bullets/emphasis/code set was not re-checked; confirm in the client before
scoping renderer work.

### Lists (unchanged)

| | `backend/src/routes/lists.js` |
|---|---|
| Storage | `channel_lists` (title, max 120) and `channel_list_items` (title max 200, completed flag, assignee, due date) |
| Scope | One channel; many lists per channel |
| API | list by channel, create, rename, delete; add, update, delete items |
| Who can change | Any channel member |
| Real time | None |

Our Lists are Slack's **to-do mode** and nothing more.

## 2. Gaps against the documented model

### Canvas

| Slack behaviour | Ours now | Priority |
|---|---|---|
| Safe concurrent edits (Slack: a lock error; no merge) | Live updates show others' saves, but the server has no revision check: a stale editor overwrites silently | **High** (data-loss risk) |
| Section-based edits: look up a section, then insert before/after, replace, delete; rename | Whole document only | High |
| Richer blocks: h1-h3, checklists, tables (up to 300 cells), callouts, dividers, mentions | Not re-checked after Canvas 2.0 (the old preview had headings, bullets, emphasis, code) | Medium |
| Channel canvas (one per channel) | **Done** (Canvas 2.0), plus a DM canvas, which Slack's docs do not describe | Done |
| Standalone canvas, collaborators, link sharing | **Done**: viewer/editor collaborators, share links with role and expiry | Done |
| Access `read` / `write` / `owner`; grant to a channel as well as users | Viewer/editor plus the creator as implicit owner; no explicit transferable owner; cannot grant a standalone canvas to a whole channel | Low to medium |
| Size limit 1 MiB | 100,000 characters | Low |
| Two systems for channel canvases | Legacy `/api/canvases` still exists beside Canvas 2.0 | Decision (see section 6) |
| Not documented by Slack: history, comments, templates | None | Our call (see section 3) |

### Lists

| Slack behaviour | Ours | Priority |
|---|---|---|
| Typed columns (text, number, select, date, user, checkbox, …) with one primary text column | Fixed columns (title, done, assignee, due) | **High** (this is what makes it a "list" rather than a checklist) |
| Select options with colours (≤ 100 per column, ≤ 50 chosen per cell) | None | High (part of typed columns) |
| Subtasks, duplicate item, archive, copy a whole list (with or without items) | None | Medium |
| Cursor pagination, 1–100 cell updates per call | All items returned in one response | Medium |
| Auto columns: created by / when, last edited by / when | Only creator and timestamps on the row | Low |
| Access levels per list | Channel membership only | Medium |
| Not documented by Slack: views (sort, filter, group), board layout, item comments, reminders | None | Our call (see §6) |

## 3. Canvas design

**Content stays Markdown in one column.** It is simple, diffable, already works with our preview,
and fits Slack's own wire format (markdown). Add structure on top rather than replacing it.

- **Sections are the top-level Markdown blocks** (heading, paragraph, list, table, code fence,
  quote, divider). The server parses the document into blocks on demand.
- **`GET /api/canvas/:id/sections?type=&contains=`** returns blocks as `{ id, type, preview,
  index }`. Section IDs are **ephemeral**, derived from block position plus a short hash of its
  text. Slack does not document its lifetime either, so we state ours: an ID is valid for the
  revision it was returned with.
- **`PATCH /api/canvas/:id`** takes one operation, mirroring the documented set:
  `insert_after`, `insert_before`, `insert_at_start`, `insert_at_end`, `replace` (whole document
  when no section is given), `delete`, `rename`. It also takes **`baseRevision`**.
- **Revisions fix the data-loss risk.** Add `revision INTEGER` to the canvas. Every write must
  carry the revision it was based on; a mismatch returns **409** with the current text so the client
  can re-apply. This replaces Slack's coarse lock with something better and needs no real-time
  infrastructure. The existing whole-document `PATCH` keeps working but also requires `baseRevision`.
- **Broadcast already exists** (`canvas_updated` on the `canvas:<id>` room). Extend its payload with
  the new `revision`, and have the client re-base or warn when its local text is behind.
- **Checklists:** support `- [ ]` / `- [x]` in the renderer and let a section edit toggle one item
  (this is Slack's lookup-then-replace example).
- **Tables, callouts, h1–h3, dividers** are renderer work (safe, escaped). The `format.js` rich-text
  module already shows the pattern and has a test that user text cannot become markup.

Optional, our design (Slack publishes nothing): **history.** `canvas_revisions(canvas_id, revision,
title, content, edited_by, edited_at)`, written on each save, with a "restore this version" action.
Storage is bounded by keeping the last N revisions or only changes more than a minute apart.

### Canvas access

Mostly in place. `ensureCanvasAccess` in `backend/src/security.js` already gates every Canvas 2.0 route
by role. Remaining work: make `owner` an explicit, transferable level (today the creator is implicitly
owner); allow granting a standalone canvas to a whole channel as well as to users; decide the guest
default (recommended: read-only unless granted); keep moderators and Superadmins able to delete.

## 4. Lists design

Replace the fixed item table with a small typed-table model. Keep today's API working during the
change (the to-do list becomes a list created in "to-do mode").

```
lists          (id, channel_id, title, description, todo_mode, created_by, created_at, updated_at, archived_at)
list_columns   (id, list_id, key, name, type, options JSONB, is_primary, position)
list_rows      (id, list_id, parent_row_id NULL, position, archived_at, created_by, updated_by, created_at, updated_at)
list_cells     (row_id, column_id, value JSONB, PRIMARY KEY (row_id, column_id))
list_access    (list_id, subject_type, subject_id, level)
```

- **Column types to build first:** `text` (primary), `checkbox`, `date`, `user`, `select`
  (single or multiple, with coloured choices), `number`, `link`. Later: `email`, `phone`, `rating`,
  `attachment`, `message`, `created_by`, `created_time`, `last_edited_by`, `last_edited_time`.
  Skip `vote`, `canvas`, `reference`, and `channel` until there is a need.
- **Exactly one primary column, always text, never changed.** Enforce in the database and the API.
- **Value shapes** follow the documented table in 04 (for example date as `YYYY-MM-DD`, select as the
  choice ID, not the label, so renaming a label never breaks data).
- **Item operations:** create (with initial cells, optional parent for subtasks, optional
  "duplicate of"), update 1–100 cells per call in **one transaction**, archive, delete,
  list with a cursor and a default page size well under Slack's 5,000.
- **To-do mode** creates three columns: completed (checkbox), assignee (user, single), due date.
  The migration maps existing `channel_list_items` rows onto these columns, preserving IDs and
  timestamps, and keeps the existing endpoints as thin wrappers until the client moves over.
- **Validation lives server-side**, per type, with one function per type (like `parseDueDate` today).
  Reject unknown columns, wrong shapes, a select choice that does not exist, a user who is not in the
  channel (same rule as today's assignee check), and writes to automatic columns.
- **Copy list** (with or without items) and **duplicate item** are small once the model exists.

Optional, our design: **views.** `list_views(list_id, name, kind ['table'|'board'], sort, filter,
group_by_column_id)`. Start with a table view with one sort and one filter; board view groups by a
select column. Slack documents none of this, so we choose the minimum that is useful.

## 5. Order of work

1. **Canvas revisions and 409 conflicts** on the `PATCH` and the share-link `PATCH`. Smallest change,
   removes a real data-loss risk that live sync makes more visible, and adds the revision column the
   later steps depend on.
2. **Canvas section lookup and edit operations, plus checklist toggling.**
3. **Canvas explicit owner level and channel grants** (small, on top of the existing access helper).
4. **Lists typed schema and cells, with the to-do migration.** The largest step; do it behind the
   existing endpoints so the desktop app keeps working throughout.
5. **Lists: select options, subtasks, archive, copy, duplicate, pagination.**
6. **Lists access levels, then views.**
7. **Canvas richer blocks (tables, callouts) and history.**

For each step, follow how the rest of this project was built: tests first for the validation and
permission rules; a startup migration in `backend/src/migrations.js` mirrored in `database/init.sql`;
a live check in the Electron app with two clients; roadmap and docs updated; temporary test data
removed.

## 6. Decisions for you

1. **Legacy canvases (now labelled "Wiki" in the UI).** The Canvas 2.0 handoff deliberately keeps the old
   system working and says not to refactor it or remove its table, so **keep both for now.** If you ever
   want to retire it: Canvas 2.0 allows one channel canvas per channel whereas the legacy table allows
   many, so a migration would turn the extras into standalone canvases shared with the channel's members,
   which needs step 3 (channel grants) first.
2. **Canvas history:** build it? (Recommendation: yes, after step 2; it is cheap and removes the fear
   of overwriting.)
3. **Lists views:** table only, or table plus board? (Recommendation: table first, board only if
   someone asks.)
4. **Guest default for canvases and lists:** read-only unless granted (recommended), or write like
   members?
5. **Standalone lists.** Canvases now have a standalone kind. Should Lists too, or stay channel-scoped?
   (Recommendation: stay channel-scoped until Lists get access levels, then revisit.)

## 7. Risks

- Slack's Lists docs are internally inconsistent (select values, key naming, type list). We are not
  bound by them; define our own types and write them down once.
- The 100,000-character limit, the whole-document `PATCH`, and the auto-save loop are contracts the
  shipped client depends on: adding `baseRevision` and raising the limit must stay backward compatible,
  and the client must handle a 409 (it currently has no path for one).
- Section IDs derived from position shift when someone else edits; the revision check is what makes
  that safe, so step 1 must come first.
- Canvas 2.0 v1 was **deliberately** built as last-write-wins (its plan lists real conflict handling as
  out of scope and `canvas_revisions` as optional). Step 1 is therefore a proposal to revisit that choice,
  not a correction of a mistake; confirm before changing it.
- Two people (or tools) are changing this repository at the same time. Re-read the current Canvas and
  Lists code before starting any step; this document was already stale once within hours.
