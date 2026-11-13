# IT Avenue Workspace — Slash Commands Specification

**Status:** Initial leave self-service release implemented (November 13, 2026)  
**Scope:** Slash commands only (Electron desktop client, mobile PWA, Express API, Socket.IO, PostgreSQL 15).  
**First use case:** `#hr-inquiry` self-service HR commands.

### Implemented initial release

- Dedicated `#hr-inquiry` channel with immutable `command_scope = 'hr-inquiry'`; renaming a channel cannot grant or remove command access.
- Shared registry, parser and server-authorized dispatcher exposed through authenticated HTTP endpoints.
- Desktop and mobile autocomplete with keyboard/touch selection, private response cards and `//` escaping for literal messages.
- `/leave`, `/leave-count`, `/leave-used`, `/leave-remaining`, `/leave-details`, `/leave-history`, `/leave-pending`, `/leave-status`, `/leave-types`, `/leave-request`, `/leave-cancel`, and `/hr-help`.
- Requester-only responses that are neither inserted into message history nor broadcast through channel sockets.
- Metadata-only command auditing and tests for scope, identity isolation, invalid input, cancellation authorization and non-persistence.

Attendance commands, policy/document commands, HR tickets and privileged administrative commands remain later roadmap work.

## 1. Objectives

Create a reusable command framework that employees can invoke by typing `/` in a channel composer. A shared channel can accept commands from all employees while returning confidential, **requester-only** results. The same framework must work in the Electron app and mobile PWA, and later support additional departments and workflows without bespoke command parsers.

### Core rules

- A slash command is an application action, **not an ordinary chat message**.
- By default, employee-specific HR outputs are **private/ephemeral**: visible only to the requester, not inserted into shared channel history or broadcast to room subscribers.
- The server derives employee identity from the authenticated session, not a user-supplied employee ID.
- Commands respect channel scope, roles, permissions, and existing HR business rules.
- All sensitive execution and follow-up interactions are authorized server-side.
- Typing a slash command must not notify other channel members or appear in their exports/search.
- Ordinary free-text posts to `#hr-inquiry` remain public to that channel; the UI must make this distinction clear.

## 2. First channel: `#hr-inquiry`

Provision an HR Inquiry channel that all active employees can access. Its composer supports slash commands and autocomplete. The HR Assistant displays results as a private response within the channel interface, for example:

```text
#hr-inquiry

You: /leave-remaining

HR Assistant                                    [Only visible to you]
Leave balance — 2026
Vacation Leave: 8 days available
Sick Leave:     5 days available
[View details] [Request leave]
```

These numbers are illustrative, not real employee records. A private response can include structured cards, tables, links to existing HR screens, and buttons. Follow-up actions must perform fresh permission checks. Do not persist private cards as channel messages.

**UX choice:** Show a transient local command echo and private result for the invoking client; optionally let the employee reopen the underlying HR view through existing app navigation. Do not claim ephemeral results are permanent history. If private cross-device history is later required, implement a separately scoped and access-controlled store.

## 3. Employee command catalog

### 3.1 Leave balances and history

| Command | Description | Output |
|---|---|---|
| `/leave` | Summary of own leave balances | All leave types, totals, used, remaining |
| `/leave-count` | Total allocated/earned leave credits | Breakdown per leave type and period |
| `/leave-used` | Approved leave already consumed | Total and type breakdown |
| `/leave-remaining` | Available leave credits | Available credits per leave type |
| `/leave-details` | Comprehensive leave accounting | Allocated, carryover, adjustments, used, pending, available, dated usage |
| `/leave-history` | Own leave application history | Dates, type, duration, status, reference |
| `/leave-pending` | Own leave applications awaiting action | Pending items and requested dates |
| `/leave-types` | Defined leave types and eligibility | Type names, rules, policy links |
| `/leave-request` | Start a leave application | Existing leave request form/modal |
| `/leave-status` | Check application status | Recent applications, status and links |
| `/leave-cancel` | Cancel an eligible request | Confirmation and server-validated workflow |
| `/leave-policy` | Show leave policy | Policy summary and source document |

Examples:

```text
/leave-remaining
/leave-remaining sick
/leave-used vacation 2026
/leave-history 2025
/leave-details 2026
```

Use canonical leave-type IDs behind readable names and aliases; the backend resolves/filter-validates them. The selected year should default to the current leave year under company policy, not necessarily the calendar year. Explain the effective period on every response.

### 3.2 Attendance and schedule

| Command | Description |
|---|---|
| `/attendance-today` | Own clock-in/out records today |
| `/attendance-week` | Own weekly attendance summary |
| `/attendance-month` | Own monthly attendance summary |
| `/attendance-late` | Own late occurrences and durations |
| `/attendance-absences` | Own recorded absences |
| `/attendance-details` | Own detailed attendance ledger |
| `/schedule` | Own assigned work schedule |

Distinguish official/approved records from provisional, missing, or disputed attendance entries. Use company timezone and shift/calendar rules.

### 3.3 HR assistance

| Command | Description |
|---|---|
| `/hr-help` | List commands available to current employee in current scope |
| `/hr-policy` | Browse policy topics and policy documents |
| `/holidays` | Company holiday calendar |
| `/my-profile` | Own HR profile, excluding unnecessarily sensitive fields |
| `/hr-contact` | HR contact information or confidential inquiry entry point |
| `/hr-ticket` | Create a confidential HR inquiry/ticket |

### 3.4 Privileged commands (future)

Potential HR-only commands include `/leave-approvals` and `/hr-report`. They must use distinct privileged permissions, not an employee command with an optional `employeeId` parameter. Do not include them in employee autocomplete or allow execution without authorization.

## 4. Command discoverability and composer behavior

1. Typing `/` opens a searchable menu of currently permitted commands.
2. Filter by prefix, alias, description, permitted channel, and current role.
3. Show command name, short description, argument hints, and optional examples.
4. Support keyboard up/down, Enter to select, Escape to close, and click/tap.
5. Selecting a command can insert an argument template; validate input before execution.
6. Use autocomplete for leave types, periods, and other enumerated arguments.
7. Display busy, success, empty, forbidden, and error states without exposing internal errors.
8. Private replies should be marked **Only visible to you** and visually distinct from shared messages.
9. Keep feature parity between Electron and mobile PWA; adapt menu dimensions and navigation for touch.
10. Unknown commands should return a private suggestion to run `/hr-help` rather than being posted to the channel.

If a user explicitly chooses to send text literally starting with `/`, provide an escape mechanism (e.g., `//` or a composer mode), clearly documented and consistently implemented.

## 5. Command scope and visibility

Support at least these command scopes:

| Scope | Example | Authorized usage |
|---|---|---|
| Specific channel | `/leave-details` in `#hr-inquiry` | Channel member with `hr.leave.read_self` |
| Global | `/help` | Available wherever allowed |
| HR Assistant private conversation | `/attendance-month` | Authenticated employee |
| HR staff channel | `/leave-approvals` | HR role plus channel access |
| Admin only | `/hr-report` | Explicit privileged policy |

**Do not use channel display names for authorization.** Use immutable channel IDs or defined channel types. A renamed channel must retain its policy; an unrelated channel named `hr-inquiry` must not automatically gain HR command privileges.

Visibility policies:

- `private`: only the invoking user/device/connection gets the result; no normal channel message persistence.
- `shared`: only for expressly designated non-sensitive commands, after explicit scope/permission checks.
- Default to `private` for all HR personnel data.

For requests continuing across reconnections/devices, choose a documented private-response persistence strategy; otherwise return results as ephemeral and require rerunning the command.

## 6. Architecture and modules

Use the existing shared backend. No separate bot service is necessary.

```text
Electron composer ─────┐
                      ├── authenticated HTTPS/Socket.IO request
Mobile PWA composer ───┘                │
                                       ▼
                       Slash command dispatcher (backend/)
                           ├── Parse & validate arguments
                           ├── Verify session and active status
                           ├── Check channel scope and permissions
                           ├── Resolve actor -> employee record
                           ├── Call existing leave/attendance services
                           └── Return requester-only structured result
```

Suggested logical backend components (adapt paths/names to the actual repository):

```text
backend/
  commands/
    registry.js
    parser.js
    dispatcher.js
    permissions.js
    handlers/
      leave.js
      attendance.js
      hr.js
    schemas/
      responses.js
```

The command handler should call existing HR services/repositories rather than reproduce leave-balance calculations or duplicate validation rules.

### Registry metadata

Each command definition should support:

```js
{
  name: 'leave-details',
  aliases: [],
  description: 'Show your leave allocations and history',
  scopes: [{ type: 'channel-type', value: 'hr-inquiry' }],
  permission: 'hr.leave.read_self',
  visibility: 'private',
  arguments: [{ name: 'year', type: 'leave-year', required: false }],
  enabled: true,
  auditPolicy: 'metadata-only',
  handler: async (context, args) => { /* existing HR service */ }
}
```

Registry metadata can drive autocomplete and help, but **server-side dispatch remains authoritative** for execution.

### Illustrative handler

```js
const leaveDetails = {
  name: 'leave-details',
  permission: 'hr.leave.read_self',
  visibility: 'private',

  async handler({ authenticatedUser, services }, { year }) {
    const employee = await services.employees.findByUserId(
      authenticatedUser.id
    );
    if (!employee) throw new Error('EMPLOYEE_NOT_FOUND');

    const details = await services.leave.getDetails({
      employeeId: employee.id,
      year
    });

    return {
      visibility: 'private',
      kind: 'leave-details',
      data: details
    };
  }
};
```

`authenticatedUser` must be resolved from a verified server-side session. The dispatcher must enforce command permission and the channel's immutable ID/type before calling this handler. Treat these snippets as architecture examples, not drop-in replacements for existing modules.

## 7. Execution flow and private Socket.IO responses

1. Client sends `{ command, args, channelId, requestId }` through authenticated HTTPS or Socket.IO.
2. Server authenticates the **current** session and verifies the account is active.
3. Server validates name/arguments against the registry; rejects unknown or disabled commands.
4. Server checks channel membership, immutable scope, employee permission, and rate limits.
5. Handler resolves authenticated user to employee and queries authorized HR records.
6. Server returns a typed response to the initiating request/connection only (Socket.IO acknowledgement or authenticated HTTP response).
7. Client renders the private card locally. No shared room broadcast or normal message insertion occurs.
8. Client follow-up buttons invoke authorized endpoints with fresh checks.

Prefer Socket.IO acknowledgements for one-off command results, or an HTTP response if already using API calls. If a private push event is needed, target a server-verified user/device socket room and guard against stale membership and session revocation. Never send an HR result via `io.to(channelId).emit(...)`.

Server must ignore any client-supplied `userId` or `employeeId` when handling `read_self` commands. A modified payload such as `/leave-details employee=42` must never expose someone else's data.

### Response structure

```json
{
  "requestId": "opaque-request-id",
  "visibility": "private",
  "kind": "leave-summary",
  "title": "Leave balance",
  "period": "2026",
  "data": {
    "leaveTypes": []
  },
  "actions": [
    { "type": "open-route", "route": "leave/history" }
  ]
}
```

Action IDs/routes must be allowlisted on the client. An incoming response must never contain executable JavaScript, untrusted HTML, shell commands, or arbitrary URLs that the client executes.

## 8. Leave-accounting semantics

All displayed values come from the existing HR leave rules. Clarify in the UI and in API contracts:

- Difference between **allocated/earned**, **carryover**, **manual adjustments**, **used**, **pending/reserved**, **available**, and **expired** days.
- Whether pending requests reserve available balance (policy-dependent). Do not silently count pending as approved leave used.
- Approved requests may contain future leave dates. Decide whether `/leave-used` means **already taken** or **approved consumption including upcoming dates**; ideally display both separately.
- Distinguish calendar days, working days, half-days, and hours as applicable.
- Support year boundaries, accrual dates, probation/eligibility rules, entitlements, and corrections.
- For `/leave-details`, show dated applications and their status, grouped by leave type, with links to authorized existing forms.
- For multi-type totals, label breakdowns: vacation and sick credits may not be interchangeable.
- Always show the effective period, data-as-of time, and units.

Suggested `/leave-details` sections: employee's own period, leave type table (earned, carryover, adjustments, approved usage, pending, available), and chronological usage/history (dates, number of working days, status, reference). Avoid making up credits when HR records are incomplete.

## 9. Security, privacy, and observability

- Derive actor identity from authenticated backend session; never trust employee identifiers in command text.
- Authorize **every** execution and follow-up action; hiding autocomplete is not sufficient security.
- Treat `#hr-inquiry` as a shared channel: show an explicit notice that ordinary posts are visible to members; command replies are private.
- Do not write HR payloads to general message tables, search indexes, channel exports, notifications to others, or raw application logs.
- Audit metadata (`actor`, command name, timestamp, outcome, request ID) without including leave balances or medical/leave reasons by default.
- Implement per-account and per-command throttling, input validation, length limits, safe errors, and anti-enumeration checks.
- Require explicit privileged RBAC and separate workflow for HR/admin access to someone else's records.
- Sanitize/render responses as structured data; never interpolate raw HTML or execute markup from the server.
- Remove ephemeral private cards on sign-out, account switch, or session invalidation; prevent stale cached employee data from being displayed to the next user.
- Do not assume privacy only because the Electron/PWA UI hides something: test events and APIs with altered clients.

## 10. Initial release scope and roadmap

| Phase | Deliverable | Acceptance criteria |
|---|---|---|
| 1. Framework | Registry, parser, dispatcher, scoped permissions, private response contract | Wrong scope/role rejected; private results never broadcast |
| 2. Composer | `/` autocomplete, keyboard/touch selection, validation, response cards | Works in Electron and PWA |
| 3. Balance commands | `/leave`, `/leave-count`, `/leave-used`, `/leave-remaining`, `/leave-details` | Correct records for authenticated employee only |
| 4. History commands | `/leave-history`, `/leave-pending` with year/type filters | Dates, statuses, partial-day handling consistent with HR system |
| 5. Actions | `/leave-request`, `/leave-status`, optional `/leave-cancel` | Reuses existing workflows with fresh authorization |
| 6. Discovery/testing | `/hr-help`, command tests, audit policy | No cross-user leaks; all errors safely handled |

### Required tests

- Employee A and B run the same command in `#hr-inquiry`: each receives only their own results.
- A malicious client supplies a different user/employee ID: no cross-employee data returned.
- Command entered in an unauthorized channel is rejected even if a channel shares the display name.
- Private output does not appear in room broadcasts, stored channel messages, channel search, exports, or unrelated socket clients.
- Inactive/revoked sessions and removed channel members cannot invoke commands.
- Concurrent requests/retries do not mix request IDs or private results.
- Unknown command, invalid year/type, no employee record, no balance, and HR backend errors are handled clearly.
- Desktop and mobile PWA show equivalent authorized data and private-response treatment.
- Sensitive result cards disappear on sign-out/account switch and do not remain in shared caches.

## 11. Finalized initial-release decisions

- `#hr-inquiry` is provisioned for all active members and authorized by an immutable channel scope, never its display name.
- Leave uses the existing calendar-year accounting. `used` includes approved future leave, which matches the existing Leave screen.
- Pending leave reserves available credits but remains separately labeled in every balance response.
- Result cards are purely ephemeral and disappear on channel change or sign-out. Only command name, actor, channel, request ID, outcome and time are audited.
- Commands are channel-only in the initial release. HR Assistant DMs can be added later without weakening channel-scope authorization.
- No privileged administrative commands are included in employee autocomplete or dispatch.

**Implementation principle:** Implement one reusable, server-authorized command system; use HR Inquiry as the first consumer. Keep employee-specific replies private, and reuse the existing leave and attendance business logic.
