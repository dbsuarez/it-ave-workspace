# Sheets: spreadsheets HR makes in the app, which the app reads from

Status: approved by the user on 2026-11-19 ("approved, autosave is enough"). The first version has no live co-editing.

## Why
HR works in spreadsheets. They want to build spreadsheets inside the app and have the rest of the app read from them, not only
for leave: "we can handle something else in the future". So this is a general capability, not a leave screen.

## Goals
- A **Sheets** section: create, open, edit, rename, share and delete spreadsheets with a familiar grid (Jspreadsheet CE).
- Edits save by themselves; a second person saving at the same moment does not silently lose work.
- A tab can be declared a **table** with a header row and typed columns. **Publish** validates it and saves a snapshot.
- The rest of the app reads **only the published snapshot**, typed, through one server function and one API.
- CSV in and out. A button to make a sheet from the current leave records (first user of the engine).

## Non-goals
- No live co-editing, no cursors, no comments (later, if wanted).
- No `.xlsx` (the free edition lacks it). No server-side formula evaluation, ever.
- No specific consumer built into the engine. Leave, holidays and the rest can be added as readers later.

## Decisions (mine)
- Creating a sheet needs a new permission **Manage sheets** (Owners always, the HR role by default). People a sheet is shared
  with (editor or viewer) need no permission. Owners (the Owner role) get no automatic access to other people's sheets.
- A sheet's cells are stored as JSONB: `{ tabs: [{ id, name, rows: [[string...]...], widths? }] }`. Limits: 20 tabs, 5000 rows,
  200 columns, 5000 characters per cell, 5 MB in all. Cells are strings; the grid shows formulas, but only **values** are published.
- Saving sends the whole sheet with the revision it was based on. If the revision moved on, the server answers 409 with the
  latest sheet and the browser merges cell by cell (a cell I changed wins, anything else comes from the server). Adding or
  removing rows or tabs on both sides asks the person to reload instead of guessing.
- Table columns: text, number, date (YYYY-MM-DD), yes/no, person (an existing username). A table has a name (a-z, 0-9, _),
  a tab, and the columns. Publish checks every row and lists the problems; nothing is published until it is clean.
- The published snapshot (`sheet_tables.published`) holds the typed rows. Editing a sheet never changes it until Publish.
- Readers: `GET /api/sheets/:id/tables/:name` for people who can open the sheet, and `readPublishedTable(query, sheetId, name)`
  for server code (typed rows, `null` when unpublished).

## Approaches considered
1. A free grid read raw by the app: breaks the first time someone renames a column. Rejected.
2. **Typed tables with Publish** (chosen): safe for "the app reads the sheet".
3. Import-only (upload a file into database tables): safe, but not "make the spreadsheet in the app". Rejected.

## Tasks
1. Schema, the permission and the Sheets API (create, list, open, save with revision, rename, delete, share).
2. The grid, bundled offline (licence checked: Jspreadsheet CE, jSuites and the formula add-on are MIT), and the Sheets screen with autosave and cell merge.
3. Sharing and delete in the screen; CSV import and export.
4. Tables panel, column types and the Publish check (pure rules, tested on the server).
5. The reading side: API, the server helper, and a "Published data" view.
6. Leave bridge (a sheet from current leave records), docs, Help, rebuild and verification.
