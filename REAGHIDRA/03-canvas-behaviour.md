# 03. How Slack Canvas works (from Slack's public documentation)

Source: Slack's developer documentation, read on 2026-11-11. This is a paraphrase of published
behaviour, not Slack code. Where the pages disagree or are silent, that is stated.

Pages used:
[Canvases overview](https://docs.slack.dev/surfaces/canvases/) ·
[canvases.create](https://docs.slack.dev/reference/methods/canvases.create/) ·
[conversations.canvases.create](https://docs.slack.dev/reference/methods/conversations.canvases.create/) ·
[canvases.edit](https://docs.slack.dev/reference/methods/canvases.edit/) ·
[canvases.sections.lookup](https://docs.slack.dev/reference/methods/canvases.sections.lookup/) ·
[canvases.access.set](https://docs.slack.dev/reference/methods/canvases.access.set/) ·
[canvases.delete](https://docs.slack.dev/reference/methods/canvases.delete/)

## What a canvas is

A rich document that lives in Slack. Two kinds are documented:

- **Standalone canvas.** Owned by whoever created it. Created empty and untitled unless a title or
  content is supplied. It can optionally be added as a tab in a channel at creation time (required
  on free workspaces).
- **Channel canvas.** At most one per channel; a second create fails with
  `channel_canvas_already_exists`. Its ID is exposed on the channel record. It needs no separate
  sharing: access follows channel membership (private channels require membership). The canvas icon
  in the channel header appears only once it has content.

No separate "direct message canvas" kind is documented. Sharing into DMs is by user.

## Content model

- Content is sent as markdown inside an object that states its type (`markdown` is the only type).
  Block Kit is not supported.
- Size limit: 1 MiB (1,048,576 characters) per content object, applied per change when editing.
- Supported elements: headings level 1 to 3, paragraphs, bold, italic, strikethrough, code spans,
  fenced code blocks, block quotes, bulleted and numbered lists, **checklists**, **tables**,
  callouts, dividers, column layouts, links, emoji (standard and custom), hard line breaks, user and
  channel mentions, and link unfurls (message, file, canvas, website).
- Tables: at most 300 cells, any shape. Cells can hold links, checkboxes, lists, mentions, styled text.
- Code blocks are allowed inside quotes, callouts and columns but **not inside list items** (the
  create or edit fails). Inside tables use a code span.
- Mentions use an image-link syntax (`![](@USERID)`, `![](#CHANNELID)`). A channel the viewer cannot
  access is shown as "private channel".
- A link unfurls as a card when it sits in its own block and as a title when nested.
- Images: a public URL or a Slack file link.

## Editing model

Edits are **section-based**, not whole-document by default.

- A **section** is a block-level piece of the document. Section IDs are obtained with a lookup
  call (see below); they look like `temp:C:…`. The docs do not say how long an ID stays valid, and
  their examples look an ID up again before each edit.
- Operations: `insert_after` and `insert_before` (need a section ID and content), `insert_at_start`
  and `insert_at_end` (content only), `replace` (content; a section ID optional, and **omitting it
  replaces the whole canvas**), `delete` (a section ID; sections only, deletion is permanent), and
  `rename` (title only, as markdown text).
- **One operation per call.** The edit request takes a list of changes but the list is limited to
  exactly one.
- **Lookup** (`canvases.sections.lookup`) finds section IDs by criteria: section type
  (21 types, including any heading, h1/h2/h3, list, code block, table, callout, column layout,
  divider, user mention, chart, citation) and/or text contained. Criteria can be combined. Some
  types cannot be used as a filter but still appear when no type is given. Typical use: look up a
  checklist item, then replace it to tick it off.
- Concurrency is handled with a lock error (`canvas_editing_locked`: another edit is running; retry
  later) and a size error (`canvas_too_large`). There is no documented revision or merge scheme.
- If the workspace's "skills" feature is on, canvases must be updated whole through a different
  endpoint; section edits are not allowed.

## Access control

- Levels: `read` (view), `write` (view and edit), `owner` (users only; only the current owner can
  hand ownership on; cannot cross workspaces).
- Granted to either **channels** or **users**, never both in one call, 1 to 20 targets per call.
- Channels must be ordinary channels. For DMs, grant to the users instead.
- To grant a user access, the user must already have been sent the canvas directly; membership of a
  channel it was shared to is not enough.
- No default level is documented for a new standalone canvas.

## Create and delete

- `canvases.create`: optional title, optional content, optional channel to tab it into. Returns the
  new canvas ID.
- `conversations.canvases.create`: creates the channel canvas; channel required.
- `canvases.delete`: removes the canvas for the whole workspace, no undo. Error if the canvas does
  not exist or is not visible. What happens to channel tabs and shares is **not documented**.
- Finding canvases: the generic file listing filtered to type `canvas`.
- Scopes: write for create/edit/delete/access, read for lookup. Rate tiers: create tier 2 (20+/min);
  edit, lookup, access, delete tier 3 (50+/min).

## Not documented anywhere in these pages

Version history, comments, real-time collaboration (beyond the edit lock), templates, default
access, and the lifetime of section IDs. Treat all of these as **our own design decisions**.

## Inconsistencies in the docs worth knowing

- The overview says the size limit "applies to each change in the changes array", implying several
  changes, while the edit method allows exactly one.
- A Salesforce-record unfurl is listed for create and edit but not for the overview or the
  channel-canvas method.
- Creating with a channel says the canvas is tabbed "with write permissions" without saying whose.

Cross-check: the main facts (one operation per call, the six operation names, the 1 MiB limit,
markdown as the only type) were confirmed by two independent reads (a search summary and a page
read).
