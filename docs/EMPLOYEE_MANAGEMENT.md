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
- **People > Attendance**: everyone clocks in and out and sees their own month (late, short, hours, overtime, leave). Managers also get **My team** (who is in, late, absent or on leave on a day, and each person's month). HR gets **Everyone**, can fix or add a day by clicking it, edits **Work schedules**, and uses **Export for payroll**.
- **People > Leave > All records** (HR and Superadmin): every leave request in any status, with filters (search, status, type, dates) and a CSV export.
- **People > Manage** (HR and Superadmin): a table with search and status/department filters, **Add people** (the same form as Moderation > Create accounts, with CSV/Excel import), **Departments**, **Checklists**, **Leave settings**, **Export CSV**. Click a row for the employee record.
- **Employee record**: names, employee number, employment type, department, job title, reports to, location, status (active / on leave / resigned), hire date, last day, leave balances (adjust per person per year), onboarding and offboarding checklists, reset password, deactivate / reactivate. The Superadmin also sees the username and the HR switch.

## Rules worth knowing

- **Deactivating** signs the person out immediately (token version bumped, sockets dropped), blocks sign-in, hides them from the directory, org chart, DM list and search, moves their direct reports up to their manager, removes extra-manager links and department headship, sets status Resigned with a last day, and starts the offboarding checklist. Messages, files and history stay. **Reactivating** does not restore reporting lines. A Superadmin cannot be deactivated (remove the role first); nobody can deactivate themselves.
- **Reset password** gives a temporary password once; the person is signed out and must choose their own at next sign-in. HR cannot reset a Superadmin's.
- **New accounts** (created by HR or the Superadmin) start with a temporary password they must change, and with the standard onboarding checklist.
- **Departments** are shared and unique (ignoring case). Renaming one renames it for everyone in it. Departments previously typed on employee pages were turned into real departments by the migration. People no longer type their own department.
- **Username changes** are Superadmin only, logged in the audit trail; old `@mentions` in messages and canvases are not rewritten.
- **Leave**: a request uses working days (Monday to Friday, minus company holidays) or 0.5 for a half day. It waits for the requester's manager, or any HR / Superadmin other than the requester. Approved and waiting days count against the balance (type allowance + adjustment) of the year the leave starts in. Types with allowance 0 have no limit. A leave type with requests is hidden, not deleted. Requests can start up to 60 days ago and run at most 90 days.

## Attendance and the payroll export

- **Several clock-ins a day.** People clock in and out as often as they leave and come back: in 8:00, out 12:00 (lunch), in 13:00, out 17:00. Each pair is a punch (up to 10 a day). One record per person per day, in the company time zone (`COMPANY_TIMEZONE`, default `Asia/Manila`; a wrong name stops the server at start). The server's clock is the only clock used.
- A **work schedule** has a start, an end, a break, a grace period, an overtime threshold and the work days. The default is 8:00 to 17:00 with a one-hour break. People without their own schedule follow the default (set per person in the employee record).
- **Late**: the first clock-in of the day after start + grace; late minutes count from the start. **Over break**: time away between clock-ins beyond the break plus grace (back from lunch at 13:25 is 25 minutes over). **Undertime**: the last clock-out before the end. **Hours worked**: the sum of the stretches. One long stretch with no break punched loses the scheduled break.
- **Overtime and rank/position level.** Each employee has a position level in their record: **Rank and file** (earns overtime) or **Managerial** (does not). Overtime is the time past the end of the schedule once it reaches the threshold. Managerial staff get no overtime and no rest-day/holiday premium hours; their hours are still counted, and any time past the end shows as "after-hours, not overtime". Work on a rest day or holiday is counted apart for rank and file (never late or overtime).
- A day is **absent** when it is a past work day with no clock-in, no approved leave and no holiday. Half a day of leave with no clock-in is half a day absent. Days before a hire date or after a last day are left out. A past day with an open stretch is **No clock-out**.
- **Corrections.** An employee clicks a past day (up to 31 days back) in their own timesheet, enters what the day should show and a reason; their manager (or HR when they have none) approves or declines. Approval rewrites the day and marks it "Corrected". HR can also fix any day directly. Waiting corrections show as a badge on the People icon and in Attendance > Corrections.
- **Office network rule.** HR lists the office addresses (an IP like 203.0.113.7 or a range like 192.168.10.0/24, one entry per office or branch) and can switch on "only clock in and out from these networks". Employees marked "Can clock in from anywhere" in their record are exempt. A blocked person sees why and who to ask.
- **IP address on every punch.** Each clock-in and clock-out records the address it came from, whether or not the rule is on. HR sees the addresses (hover the times in a timesheet); employees and managers do not. **Caveat:** when the server runs in Docker Desktop on Windows or Mac, it sees every computer as Docker's own address (for example 172.21.0.1), so the recorded address and the network rule cannot tell computers apart. Run the server on a Linux host (or directly on a computer) where it sees real addresses; behind a reverse proxy set `TRUST_PROXY`. The Office network screen warns when it sees a Docker-style address.
- **Device check.** The app sends a random id made once per installation with every clock-in and clock-out. The first device a person clocks in from is trusted; clocking in from any other is allowed but flagged "New device" on their timesheet and listed under Attendance > New devices until HR approves it (a new phone, for example). Approving clears the flag, including on earlier days. Clocking in with no device id is flagged too. Forgetting a device flags it again if used (or trusts it again if it is their only one). The desktop app is the only client today; a phone client would send the same id header.
- **Export for payroll** (HR, up to 62 days): a summary row per employee (level, overtime eligibility, scheduled days, present, absent, paid and unpaid leave, holidays, late minutes and times, over break, undertime, hours worked, overtime hours, after-hours not overtime, rest-day/holiday hours, days without clock-out), or one row per employee per day with every clock-in and out. It is meant to be imported into payroll or checked by the accountant; the app does not compute pay, tax or contributions.

## Not included (on purpose)

- Payroll itself: salaries, tax and contribution tables (SSS, PhilHealth, Pag-IBIG, withholding), 13th-month pay, loans, payslips. Attendance and leave are exported in a form payroll can use.
- Geofencing (GPS location), photos at clock-in, and a phone app.
- Leave accrual, proration for mid-year hires, carry-over and year-end rollover (balances are per calendar year; HR adjusts by hand).
- Leave that crosses a year end is counted entirely in the year it starts.
- Multi-step approval chains (manager then HR), delegates when a manager is away, and leave notifications by email.
- Payroll, documents and contracts, performance reviews.
- A separate audit screen for HR actions beyond the existing Moderation audit log (username changes are logged there).

## Tests

`backend/test/hr.test.js` (records, departments, HR role, export, deactivate, reset, checklists, username), `backend/test/leave.test.js`, `backend/test/leave-days.test.js`, `backend/test/attendance.test.js`, `backend/test/attendance-rules.test.js`, plus the schema test that guards `database/init.sql` and `backend/src/migrations.js` staying in step.

## Before go-live: the shared test password

Moderation (Superadmin) has a **Before go-live: shared test password** card. Switched on, new employee accounts get `testpass123` (override with `PRELAUNCH_PASSWORD`) and are not asked to change it, password resets give the same one, and **Give every employee the test password now** sets it for all existing employees (they are signed out). Superadmins, guests and deactivated accounts are never touched, and guests never get it. **Go live** switches it off and makes every employee choose a new password at their next sign-in. Do not leave it on for real use: anyone who knows it can sign in as any employee. Every step is in the audit log.
