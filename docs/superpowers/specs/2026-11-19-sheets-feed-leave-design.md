# Sheets feed Leave: holidays and leave credits

Approved by the user in the conversation of 2026-11-19 ("1" for the sheet-is-the-list rule, "go"). Builds on `2026-11-19-sheets-design.md`.

## Intent
Leave already has company holidays (`company_holidays`) and per-person leave credits (`leave_entitlements.adjustment`), both typed in one by one. HR works in spreadsheets, so a published Sheets table can now **feed** either of them, and a new year's holidays can start from last year's.

## Goals / non-goals
- Goals: a table can be declared as feeding `holidays` or `credits`; Publish shows a preview and changes Leave only after confirmation; Leave's own editors become read-only for what a sheet manages; a "holidays sheet from last year" starter.
- Non-goals: a live link (Leave changes only on confirmed Publish); changing counted days of existing requests; accruals or carry-over; more feed kinds (the mechanism allows them later); guessing movable holidays.
- Anti-goal: a sheet silently wiping holidays or credits. Nothing is removed without being listed in the preview and confirmed.

## Approaches considered
1. **Sheet replaces the list for the years it covers (chosen, user picked it).** Preview lists add / rename / remove; Leave's editor is read-only for those years.
2. Sheet only adds and renames. Rejected: removing a row from the sheet would leave its holiday, which confuses.
3. Live link (Leave reads the sheet directly). Rejected: Leave would change while someone types; Publish exists to prevent that.

## Design
- `sheet_tables.feeds` (NULL | `holidays` | `credits`), unique per kind (one table feeds holidays at a time, one feeds credits). Declaring a second asks first; the API takes `replace: true` to take over.
- Required columns (extra columns are allowed and ignored):
  - holidays: `date` (date, required), `name` (text, required).
  - credits: `person` (person, required), `leave_type` (text, required), `year` (number, required), `days` (number, required; the adjustment on top of the type's default, halves, -365..365).
- Extra checks on Check/Publish for a feeding table (reported by row like the others): duplicate date; holiday name longer than 100; `leave_type` not an active leave type (case-insensitive); `year` not a whole number 2000-2100; `days` not in halves or out of range; the same person, type and year twice.
- Publish of a feeding table is two steps: `POST .../publish { values }` returns `{ needsConfirm: true, feeds, preview }` and publishes nothing; `POST .../publish { values, confirm: true }` re-checks, saves the snapshot and applies to Leave in one transaction.
  - holidays preview: `years`, `add`, `rename`, `remove`, `unchanged` (count). Applies to every year present in the table; other years are untouched.
  - credits preview: `years`, `set` (new or changed), `reset` (adjustment removed because the sheet no longer lists it), `unchanged`. Applies to the years present.
- Only people with Manage sheets AND edit access to the sheet may set `feeds` or confirm a feeding publish.
- Leave while managed: `GET /api/leave/holidays` also returns `managed: { years, sheet, table } | null`; `POST/DELETE /holidays` and `PUT /entitlements` for a managed year answer 409 "Managed by the sheet X". Years a sheet does not cover stay editable. Managed = the feeding table's last published rows contain that year.
- Turning `feeds` off, deleting the table or the sheet: Leave keeps what was applied and is editable again.
- Starter: `POST /api/sheets/holidays-from-year { year }` (Manage sheets) makes "Holidays <year>" with a `Holidays` tab (`date`, `name`) holding the previous year's holidays moved to `year` (Feb 29 becomes Feb 28), declared as table `holidays` and set to feed holidays when no table feeds it yet. Refuses when the previous year has none. The screen reminds HR that moving holidays (Holy Week, Eid) must be corrected by hand.

## Left to the builder
Wording of dialogs, exact dialog layout (follow the Tables dialog), file split.

## Tasks
1. Pure `backend/src/leaveFeeds.js` + tests: required columns, extra checks, `planHolidays`, `planCredits`, `shiftHolidays`.
2. Migration (`feeds` + unique indexes), `PUT tables` accepts `feeds`/`replace`, list returns it; API tests.
3. Two-step Publish + transactional apply; Leave routes read-only for managed years; real-database tests.
4. Starter endpoint + tests.
5. Frontend: feeds control in the table form, preview/confirm dialog, read-only holidays and credits in Leave, starter button; markup tests.
6. Docs, browser check, backup + rebuild, handoff.
