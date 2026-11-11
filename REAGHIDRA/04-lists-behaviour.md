# 04. How Slack Lists work (from Slack's public documentation)

Source: Slack's developer documentation, read on 2026-11-11. A paraphrase of published behaviour,
not Slack code. The Lists documentation is thinner and less consistent than Canvas's, and most of
it is on the API method pages, so the product model below is inferred from the API.

Pages used:
[Lists overview](https://docs.slack.dev/surfaces/lists/) ·
[Lists API announcement](https://docs.slack.dev/changelog/2025/09/02/list-api/) ·
[slackLists.create](https://docs.slack.dev/reference/methods/slackLists.create/) ·
[slackLists.items.create](https://docs.slack.dev/reference/methods/slackLists.items.create/) ·
[slackLists.items.list](https://docs.slack.dev/reference/methods/slackLists.items.list/) ·
[slackLists.items.update](https://docs.slack.dev/reference/methods/slackLists.items.update/) ·
[slackLists.items.delete](https://docs.slack.dev/reference/methods/slackLists.items.delete/) ·
[slackLists.access.set](https://docs.slack.dev/reference/methods/slackLists.access.set/)

## What a List is

A collaborative tracker, essentially a typed table: **columns** define a schema, **items** (rows,
also called records) hold a value per column. Lists are paid-plan only. A List created through the
API is a standalone List owned by the creator; it is shared by granting access (below).
Whether a List "belongs" to a channel is not documented.

Two starting modes:

- **General list**: starts with one text column unless a schema is supplied.
- **To-do list** (`todo_mode`): adds three columns: completed (checkbox), assignee (people), due
  date. This is exactly what our current Lists feature already is.

A List can be **copied** from another, with or without its records (copying cannot be combined with
a new schema). Items can be **duplicated**, and items can be **subtasks** of another item (a
separate subtask schema exists).

## Schema (columns)

Each column has a developer key, a display name, a type, an optional primary flag, and
type-specific options. Slack assigns a stable column ID at creation; later calls use the ID.

- **Exactly one primary column, and it must be a text column.** It cannot be reassigned later
  (the documented workaround is exporting, reordering and recreating).
- Documented column types: `text`, `message`, `number`, `select`, `date`, `user`, `attachment`,
  `checkbox`, `email`, `phone`, `channel`, `rating`, `created_by`, `last_edited_by`, `created_time`,
  `last_edited_time`, `vote`, `canvas`, `reference`, `link`. (Examples elsewhere on the same pages
  also use names outside this list, such as `multi_select`, `assignee`, `due_date`, `completed`,
  and the to-do variants. Do not treat the list as exhaustive.)
- Options by type:
  - select: single or multiple selection; choices with a value, a label and a colour (indigo, blue,
    cyan, pink, yellow, green, gray, red, purple, orange, brown); up to 100 choices per column and
    up to 50 selected per cell.
  - user and channel: single or multiple; default value; show-member-name; user columns can notify
    the person.
  - number: decimal precision. date: one of seven display formats. rating: an emoji and a maximum.
    vote: an emoji.
- Creator and edit-time columns (`created_by`, `created_time`, and the last-edited pair) are
  maintained automatically and reject manual edits.

## Items (rows)

An item has an ID, the List ID, creation time and author, last updater, optional parent (for
subtasks), an archived flag, and a set of **cells** keyed by column ID.

How a value is represented, by type (as seen in the API examples):

| Type | Value |
|---|---|
| text | rich text blocks (plain text is only a response fallback) |
| user | list of user IDs |
| date | list of `YYYY-MM-DD` strings |
| select | list of option identifiers (the docs conflict on value vs encoded ID) |
| checkbox | boolean |
| number | list of numbers |
| email, phone | list of strings |
| attachment | list of file IDs |
| message | list of message permalinks (response: channel, timestamp, thread timestamp) |
| link | original URL, display URL, display name |
| rating | a single integer |
| timestamp | unix seconds |
| channel | list of channel IDs |
| reference | list of references to a file, message, other list record, or canvas section |

Item-level extras in responses: saved/reminder state per item (`in_progress`, `completed`,
`archived`, due and completed dates), per-cell saved state, and an `is_subscribed` flag. How those
are set is not documented.

## Operations

- **Create item**: list ID, optional initial cells, optional "duplicate this item", optional parent
  (creates a subtask).
- **Update**: a list of 1 to 100 cell edits, each naming the row, the column and a typed value.
  Returns only success.
- **List items**: cursor pagination (`next_cursor`, empty when done), a limit that defaults to and
  is capped at 5,000, an option to return archived items instead, and an option to include the
  List's own schema and row count. **No sorting, filtering or ordering parameters are documented.**
- **Delete item**: by ID. A bulk delete and a single-item read exist but were not read.
- Limits exist for row count, column count, cell count, title length and number of Lists; only the
  5,000-row listing cap and the 100/50/100 numbers above are stated.
- Frontline workers cannot create or delete items.

## Access control

`slackLists.access.set` grants `read`, `write` or `owner` (owner only for users, only the current
owner can transfer it) to channels or users (one kind per call). Revoking uses a separate method
that was not read. Scopes: read for listing, write for everything else. Rate tiers: create, list
and delete tier 2 (20+/min); item create, update and access tier 3 (50+/min).

## Not documented anywhere in these pages

**Views, sorting, grouping, filtering UI, board versus table layout, comments on items, and how
reminders are set.** The overview mentions "custom views" in passing, and copying a List can fail on
unreadable view settings, so views exist but have no description or API. These are **our own design
decisions**. Also undocumented: how a List relates to a channel or canvas, and the numeric limits.

## Inconsistencies in the docs worth knowing

- Column types in the schema list versus those used in examples (above).
- Select values: choice values versus encoded option IDs.
- The legacy `key` is said to be deprecated in favour of the column ID, yet examples still use it.
- Link fields are snake_case in requests and camelCase in responses.
- The update method says it updates cells but its examples also create rows.
- Example IDs are sometimes malformed, so do not rely on an ID format.
- The access page says "not both" for channels and users while another sentence says "at least one"
  is required (read as exactly one).

Cross-check: the column type list, the 100/50 select limits, primary-column rule and tier numbers
were confirmed by two independent reads (a search summary and a page read).
