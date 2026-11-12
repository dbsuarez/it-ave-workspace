# Employee management

Who does what, where it lives, and what is deliberately not included.

## Roles

| Role | Can do |
|---|---|
| Employee (member) | Edit their own page (title, location, phone, about, links, photo, privacy), request and cancel leave, see the directory, org chart and department list. |
| Manager (anyone with direct reports) | Approve or decline leave for their direct reports; see the team calendar. |
| HR (`users.is_hr`) | Everything under **People > Manage**: employee records, departments, reporting lines and extra managers, names, checklists, leave types, holidays, balance adjustments, deactivate / reactivate, reset passwords, create **member** accounts. Approves any leave request (never their own). |
| Superadmin | All of HR, plus: gives and takes the HR role (Moderation > Workspace members), creates guest accounts, changes usernames, moderation. |

Guests have none of this.

## Where things are

- **People > Directory / Org chart**: everyone sees them. Org chart pans and zooms; extra (dotted-line) managers are dashed curves.
- **People > Leave**: My leave (balances, request form, my requests), Approvals (a badge on the People rail icon counts requests waiting for you), Calendar (team, or everyone for HR).
- **People > Manage** (HR and Superadmin): a table with search and status/department filters, **Add people** (the same form as Moderation > Create accounts, with CSV/Excel import), **Departments**, **Checklists**, **Leave settings**, **Export CSV**. Click a row for the employee record.
- **Employee record**: names, employee number, employment type, department, job title, reports to, location, status (active / on leave / resigned), hire date, last day, leave balances (adjust per person per year), onboarding and offboarding checklists, reset password, deactivate / reactivate. The Superadmin also sees the username and the HR switch.

## Rules worth knowing

- **Deactivating** signs the person out immediately (token version bumped, sockets dropped), blocks sign-in, hides them from the directory, org chart, DM list and search, moves their direct reports up to their manager, removes extra-manager links and department headship, sets status Resigned with a last day, and starts the offboarding checklist. Messages, files and history stay. **Reactivating** does not restore reporting lines. A Superadmin cannot be deactivated (remove the role first); nobody can deactivate themselves.
- **Reset password** gives a temporary password once; the person is signed out and must choose their own at next sign-in. HR cannot reset a Superadmin's.
- **New accounts** (created by HR or the Superadmin) start with a temporary password they must change, and with the standard onboarding checklist.
- **Departments** are shared and unique (ignoring case). Renaming one renames it for everyone in it. Departments previously typed on employee pages were turned into real departments by the migration. People no longer type their own department.
- **Username changes** are Superadmin only, logged in the audit trail; old `@mentions` in messages and canvases are not rewritten.
- **Leave**: a request uses working days (Monday to Friday, minus company holidays) or 0.5 for a half day. It waits for the requester's manager, or any HR / Superadmin other than the requester. Approved and waiting days count against the balance (type allowance + adjustment) of the year the leave starts in. Types with allowance 0 have no limit. A leave type with requests is hidden, not deleted. Requests can start up to 60 days ago and run at most 90 days.

## Not included (on purpose)

- Attendance clock-in / clock-out and timesheets.
- Leave accrual, proration for mid-year hires, carry-over and year-end rollover (balances are per calendar year; HR adjusts by hand).
- Leave that crosses a year end is counted entirely in the year it starts.
- Multi-step approval chains (manager then HR), delegates when a manager is away, and leave notifications by email.
- Payroll, documents and contracts, performance reviews.
- A separate audit screen for HR actions beyond the existing Moderation audit log (username changes are logged there).

## Tests

`backend/test/hr.test.js` (records, departments, HR role, export, deactivate, reset, checklists, username), `backend/test/leave.test.js`, `backend/test/leave-days.test.js`, plus the schema test that guards `database/init.sql` and `backend/src/migrations.js` staying in step.
