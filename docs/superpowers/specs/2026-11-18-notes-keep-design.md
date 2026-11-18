# Notes, Google Keep style: design

Status: approved by the user on 2026-11-18 ("all steps, replace current screen"). Reference: a screenshot of Google Keep.

## Why
Our Notes are a title, plain text and a list with a "New note" dialog. The user wants them to feel like Google Keep: a wall of
colourful cards, quick capture, pins, labels, checklists, pictures and reminders.

## Goals
- Replace the Notes screen with a Keep-style one: masonry wall, a "Take a note..." bar, Pinned and Others sections, search.
- Colours, pin, labels (sidebar filter and chips), archive, trash with restore, checklist notes, pictures, reminders.
- Click a card: it opens as a floating editor with a bottom toolbar, saves by itself and says "Edited at 10:01".
- Existing notes keep working: default colour, unpinned, text notes.

## Non-goals
- Notes stay personal (one owner). No sharing or collaboration.
- No rich text (bold and so on) in this round: Keep's "A" formatting button is left out.
- No drawing notes, no voice notes, no Google sync.

## Decisions (mine)
- Everything about a note lives on the `notes` row (`color`, `pinned`, `archived_at`, `deleted_at`, `kind`, `items`) except
  labels (`note_labels`, `note_label_links`), pictures (`note_images`, BYTEA like drawing pictures) and the reminder, which reuses
  the existing `reminders` table through a new `reminders.note_id`, so the existing due-reminder pop-up and Later list work.
- The list call returns all of the person's notes (archived and trashed too, with small cards); search and filters run in the
  browser. Limits keep that fast: 1000 notes, 50 labels, 200 checklist items, 10 pictures of at most 2 MB per note.
- Trash keeps a note 30 days, then it is removed (checked whenever the list is loaded and at start-up).
- Text and checklist notes are one editor: the checkbox button converts lines to items and back.
- Layout is CSS columns (masonry), no layout library.

## Approaches considered
1. Rich text editor library (as Canvas uses): heavy and not asked for. Rejected for now.
2. Plain `textarea` / item rows with autosave (chosen): small, fast, matches Keep's feel.

## API (all under `/api/notes`, owner only)
`GET /` -> `{ notes, labels }`; `POST /`; `PUT /:id` (any of title, content, kind, items, color, pinned, archived, trashed,
labelIds); `DELETE /:id` (forever); `POST /trash/empty`; labels: `POST /labels`, `PUT /labels/:id`, `DELETE /labels/:id`;
pictures: `POST /:id/images`, `GET /:id/images/:imageId`, `DELETE /:id/images/:imageId`; reminder: `PUT /:id/reminder`,
`DELETE /:id/reminder`.

## Tasks
1. Schema and the notes API (fields, pin, archive, trash, purge), real-database tests.
2. Labels, pictures and reminders API.
3. Frontend pure modules (card, checklist, colours, filters, search) with tests.
4. The new Notes screen and floating editor, checked in the browser.
5. Docs, Help, rebuild, live check, handoff.
