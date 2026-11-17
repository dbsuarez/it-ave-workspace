# IT Avenue Workspace — Slash Commands Specification

**Status:** Proposed design / implementation handoff  
**Scope:** Slash commands only (Electron desktop client, mobile PWA, Express API, Socket.IO, PostgreSQL 15).  
**Coverage:** Workspace-wide command framework, including HR, messaging, channels, calls, files, canvases, tasks, IT support, directory, and administration. **First use case:** `#hr-inquiry`.

## 1. Objectives

Create a reusable command framework that employees can invoke by typing `/` in a channel composer. A shared channel can accept commands from all employees while returning confidential, **requester-only** results. The same framework must work in the Electron app and mobile PWA, and support other departments and workflows without bespoke command parsers.

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

## 11. Design decisions to finalize during implementation

- Canonical channel ID/type for `#hr-inquiry` and whether to auto-join every active employee.
- Existing leave service fields, leave-year boundary, and meaning of `used` vs future approved leave.
- Whether pending leave reduces available credits or is shown as a separate reservation.
- Which responses are purely ephemeral versus recorded as confidential user-specific activity.
- Whether commands are allowed in an HR Assistant DM as well as the channel.
- Which administrative commands, if any, belong in the first release.

**Implementation principle:** Implement one reusable, server-authorized command system; use HR Inquiry as the first consumer. Keep employee-specific replies private, and reuse the existing leave and attendance business logic.

---

## 12. Workspace-wide slash command catalog (beyond HR)

The command framework is **global across IT Avenue Workspace**, not an HR-only feature. The following commands are **proposals** for integration with existing capabilities, not claims that any feature or endpoint is already implemented. Resolve conflicts with existing application behavior before implementation. Visibility codes: **P** = private result to the requester, **S** = shared result/action in an authorized conversation, **M** = modal/form with private confirmation. Every command and interactive callback must perform server-side authorization.

### 12.1 General help, navigation, and personal utilities

| Command | Scope | Visibility | Purpose / behavior |
|---|---|---|---|
| `/help [command]` | Global | P | Search commands the user can actually execute; show syntax, examples, permissions |
| `/commands [category]` | Global | P | Browsable, filtered command directory |
| `/search <keywords>` | Global | P | Open app search with terms, returning only authorized results |
| `/jump <channel-or-person>` | Global | P | Navigate to an accessible conversation |
| `/me` | Global | P | Show signed-in identity and relevant profile shortcuts |
| `/status [text]` | Global | P | Set or view own user status, where status feature exists |
| `/away`, `/back` | Global | P | Set presence if supported; never treat presence as proof of attendance |
| `/remind <when> <text>` | Global | P | Create a personal reminder in the existing reminder system, if present |
| `/shortcuts` | Global | P | Open keyboard shortcuts/help |

### 12.2 Messaging and conversation actions

| Command | Scope | Visibility | Purpose / behavior |
|---|---|---|---|
| `/dm <person> [text]` | Global | P / S | Open DM privately; if text is supplied, preview/confirm before sending a shared DM |
| `/msg <person-or-channel> <text>` | Global | S | Send message only after target resolution and explicit confirmation on ambiguity |
| `/thread` | Channel/DM | P | Open active thread or prompt to select a parent message |
| `/reply <text>` | Thread context | S | Reply to selected parent message, not an arbitrary last message |
| `/edit` | Own message context | M | Open editor; enforce edit window and author/role permissions |
| `/delete` | Message context | M | Confirm deletion; respect retention and legal holds |
| `/pin` and `/unpin` | Message context | S | Pin/unpin selected message with channel permission |
| `/save` and `/unsave` | Message context | P | Bookmark selected message for self |
| `/react <emoji>` | Message context | S | React to selected message; valid emoji only |
| `/mark-read` | Conversation | P | Mark authorized conversation read |
| `/mute [duration]` and `/unmute` | Conversation | P | Adjust own notifications |
| `/notify [all|mentions|none]` | Conversation | P | Update own notification settings |

**Context rules:** Commands requiring a selected message/thread are offered in context menus or only when context exists. Never guess the target message. Sending commands have an explicit audit/confirmation model and are distinct from requester's private lookup responses.

### 12.3 Channel and member management

| Command | Scope | Visibility | Purpose / behavior |
|---|---|---|---|
| `/channel-info` | Channel | P | Show accessible channel metadata and rules |
| `/members` | Channel | P | Show member list subject to privacy rules |
| `/invite <person>` | Channel | M | Invite member after checking invitation privileges |
| `/leave-channel` | Channel | M | Confirm leaving; system/required channels may prohibit it |
| `/join <channel>` | Global | P / M | Join discoverable channel where permitted; private channels require invitation |
| `/create-channel` | Global | M | Open channel creation form (name, privacy, members) |
| `/topic [text]` | Channel | P / S | Read topic privately or update topic with permission |
| `/description [text]` | Channel | P / S | Read/update channel description |
| `/rename-channel <name>` | Channel | M | Rename with permission and uniqueness checks |
| `/archive-channel` | Channel | M | Confirm administrative archive, enforce retention |

Do not expose private channel existence or membership to unauthorized users through autocomplete, lookup errors, or fuzzy matching.

### 12.4 Calls, huddles, and meetings

| Command | Scope | Visibility | Purpose / behavior |
|---|---|---|---|
| `/call [person]` | DM/channel | M | Start a permitted call via existing WebRTC call workflow |
| `/huddle` | Channel/DM | S | Start or join authorized huddle; show participation notice |
| `/join-call` | Call context | P | Join a call after current membership checks |
| `/leave-call` | Call context | P | Leave current call |
| `/call-link` | Active call | P | Copy a permission-protected call link, not a universal access token |
| `/meeting` | Global | M | Open meeting creation UI only if meetings are implemented |

No slash command bypasses call membership checks or browser microphone permission prompts. Never start capture automatically as an undocumented side effect.

### 12.5 Files, canvases, and knowledge

| Command | Scope | Visibility | Purpose / behavior |
|---|---|---|---|
| `/upload` | Channel/DM | M | Open file picker, confirm recipient and permissions |
| `/files [query]` | Channel/DM/global | P | Search files user can open |
| `/file-info` | File context | P | Display permitted file details and history |
| `/canvas` | Channel/DM | P | Open associated canvas, if present |
| `/new-canvas` | Channel/DM | M | Create a canvas through existing permissions/workflow |
| `/export-canvas [pdf|docx|md]` | Canvas context | M | Invoke existing export functionality and save dialog |
| `/find-in-canvas <text>` | Canvas context | P | Search current canvas subject to permissions |
| `/bookmark` | Message/file/canvas context | P | Save selected item to personal shortcuts |

File and canvas commands must use secure resource IDs resolved server-side. File previews and export operations must not return material the requester lacks permission to access.

### 12.6 Tasks, lists, and workflow (only if corresponding modules exist)

| Command | Scope | Visibility | Purpose / behavior |
|---|---|---|---|
| `/task-create` | Global/channel | M | Open task creation form, optionally linked to conversation |
| `/task-list [mine|channel]` | Global/channel | P | Show accessible assigned or channel tasks |
| `/task-due [today|week]` | Global | P | Show own due tasks |
| `/task-assign <task> <person>` | Task context | M | Assign with project/task permissions |
| `/task-done <task>` | Task context | M | Mark complete with confirmation if required |
| `/list-create` | Channel | M | Create a list via existing list engine |
| `/list-open <name>` | Channel | P | Open an accessible list |
| `/approval-pending` | Relevant workflow | P | List approvals the user may review |

Do not create a parallel task database solely for slash commands. These commands are UI entry points into existing or separately planned modules.

### 12.7 IT support and internal services

| Command | Scope | Visibility | Purpose / behavior |
|---|---|---|---|
| `/it-help` | `#it-support` / DM to support | P | Show IT commands and support links |
| `/it-ticket` | `#it-support` / support DM | M | Open private ticket form; issue summary may be sensitive |
| `/ticket-status <ref>` | Support scope | P | Show only tickets requester owns or is permitted to see |
| `/my-tickets` | Support scope | P | List own IT requests |
| `/report-issue` | Global | M | Bug/issue form with optional attachments and diagnostics consent |
| `/service-status` | Global | P | Show centrally maintained service status; do not expose secrets |

Avoid commands that run shell commands on the server. Technical diagnostics should be allowlisted, redacted, rate-limited, and role-restricted.

### 12.8 Company directory and announcements

| Command | Scope | Visibility | Purpose / behavior |
|---|---|---|---|
| `/directory [name|department]` | Global | P | Search allowed employee directory fields |
| `/whois <person>` | Global | P | Show permitted profile/contact data |
| `/announcements` | Global | P | Open authorized company announcements |
| `/announce` | Announcement channel | M / S | Privileged announcement composer with preview/confirmation |
| `/poll` | Channel | M / S | Create a poll if polls module exists |
| `/poll-results` | Poll context | P / S | Read results under poll visibility rules |

### 12.9 Administrative and moderation actions

| Command | Scope | Visibility | Purpose / behavior |
|---|---|---|---|
| `/admin-help` | Admin scope | P | List authorized administrative commands |
| `/audit [filters]` | Admin scope | P | Open scoped audit search with mandatory reason if required |
| `/user-status <person>` | Admin scope | P | Show permitted account state, never credentials/tokens |
| `/disable-user <person>` | Admin scope | M | High-risk action requiring explicit identity verification and confirmation |
| `/enable-user <person>` | Admin scope | M | Authorized account reinstatement with audit log |
| `/channel-permissions` | Channel admin scope | P / M | Inspect or edit permissions through verified UI |
| `/retention-policy` | Admin scope | P | Display applicable data-retention settings |

Do not support `/impersonate`, `/read-any-dm`, `/get-password`, or unrestricted admin SQL/shell commands. Elevated records access should use a separate approved and audited flow; slash commands may link to it but must not silently grant it.

### 12.10 HR-specific commands

Section 3 is the authoritative HR catalog for `/leave*`, `/attendance*`, `/schedule`, `/hr-*`, `/holidays`, and `/my-profile`. HR commands remain self-service by default, requester-only, with the authenticated employee ID resolved server-side. Privileged HR approvals and reporting require separate permissions and scopes.

## 13. Cross-workspace command discovery and namespaces

- Global `/` autocomplete lists only commands available to the current signed-in user **and current composer context**.
- Use category tabs/filters: **General, Messages, Channels, Calls, Files, Tasks, IT, HR, Admin**.
- Suggested commands are contextual; typing `/` in `#hr-inquiry` prioritizes leave/attendance, while a selected message prioritizes `/reply`, `/pin`, and `/save`.
- Reserve unique canonical command names. Use aliases for discoverability but never aliases that unexpectedly change meaning; protect `help`, `me`, `status`, `leave`, `call`, and `search` from plugin collisions.
- Commands may have options such as `--year 2026` or guided argument chips. Parse quotes, whitespace, slash prefixes and Unicode safely; reject unknown arguments rather than guessing.
- Support exact names before fuzzy matching. Suggest accessible users/channels only; do not leak restricted entities in autocomplete.
- Show a command preview before destructive, broad-broadcast, or external actions.
- All client displays (Electron and PWA) should share server-provided command metadata but use native appropriate UX (keyboard and accessible touch navigation).
- For users who type literal text starting with `/`, offer an explicit escape mechanism (e.g., `//` or “Send as message”) and document it.

## 14. Suggested reusable command schema

```ts
type CommandVisibility = 'private' | 'shared' | 'modal';
type CommandContext = 'global' | 'channel' | 'dm' | 'thread' | 'message' | 'canvas' | 'call';

type CommandDefinition = {
  name: string;
  aliases?: string[];
  category: 'general' | 'messages' | 'channels' | 'calls' |
    'files' | 'tasks' | 'it' | 'hr' | 'admin';
  description: string;
  usage: string;
  contexts: CommandContext[];
  allowedChannelIds?: string[];
  permission: string;
  defaultVisibility: CommandVisibility;
  argumentsSchema?: unknown; // validate using an established schema library
  requiresConfirmation?: boolean;
  rateLimitPolicy?: string;
  auditPolicy?: 'minimal' | 'administrative' | 'sensitive';
  enabled: boolean;
  execute: (ctx: AuthenticatedCommandContext, args: unknown) => Promise<CommandResult>;
};
```

**Execution contract:** Parse → validate arguments → verify session → verify command availability/context → resolve target object → authorize object-level action → execute via existing service → return typed result to the correct recipient(s) → audit according to policy. Re-authorize all button clicks, modals, pagination, and any delayed action. Never trust client-supplied visibility or user ID.

**Response types:** private text, private structured card, private list/table, navigation, modal opening instruction, shared conversation event, confirmation-required action, and structured error. Every type should declare retention rules and whether it may appear in exports/search/notifications.

**Idempotency:** Give write commands a request ID and deduplicate retries. Avoid duplicate task creation, announcements, leave submissions, or outgoing messages on socket reconnect.

## 15. Socket.IO and API delivery rules by visibility

| Response/action | Recipient | Persistence | Notes |
|---|---|---|---|
| Private lookup | Requesting authenticated session/socket | No shared channel message | For cross-device private history use separate access-controlled store |
| Open form | Requesting client | Normally no shared event | UI checks must be repeated on submission |
| Shared message | Authorized channel/DM participants | Existing messages table | Check write permission before insert and audience before broadcast |
| Channel management | Authorized channel members | Existing channel state + audit | Update active rooms/subscriptions after permission changes |
| Admin action | Authorized admin | Domain records + audit | High-risk confirmation, possible second-party approval |

Do not publish private results via `io.to(channelRoom).emit`. A private response should use the requesting socket acknowledgement or an authenticated requester-specific delivery mechanism; if using user rooms, never send to a room chosen by the client. Socket authorization must be reassessed for each command, not only during initial connection.

## 16. Command usage examples

```text
#hr-inquiry
/leave-remaining
/leave-details --year 2026
/attendance-month
/hr-ticket

#general
/help
/directory accounting
/dm @alex
/remind tomorrow 9am Submit the report

#project-team
/channel-info
/members
/task-create
/upload
/poll

#it-support
/it-ticket
/my-tickets
/service-status

[With a message selected]
/reply Thanks, I'll handle this.
/react 👍
/save

[With a canvas open]
/export-canvas pdf

[Authorized admin context only]
/admin-help
/audit
```

Arguments, mentioned users, and exact invocation syntax must be finalized against the app's existing entities and UI. These are desired examples, not evidence of implemented endpoints.

## 17. Expanded implementation roadmap and acceptance tests

**Phase A — Generic foundation**: registry, permission/scope checks, command help/autocomplete, argument schemas, private response cards, command errors, typed result events, client support in Electron and PWA.

**Phase B — Existing capabilities first**: `/help`, `/commands`, `/search`, `/dm`, `/channel-info`, `/members`, `/mute`, `/files`, `/canvas`; hook into existing backend services, not duplicate business logic.

**Phase C — HR self-service**: deliver Section 10 roadmap including leave/attendance commands with strict own-record access.

**Phase D — Operational workflows**: `/it-ticket`, `/my-tickets`, `/upload`, task/list/meeting commands **only when underlying modules and permission checks exist**.

**Phase E — High-risk commands**: account/channel administration, announcement broadcast, controlled approval flows, comprehensive audits and optional two-person approval.

**Required automated test cases:**

1. Unauthorized and disabled users cannot invoke any command.
2. User A never sees User B's private command response via channel, DM, Socket.IO rooms, API, exports, search, notifications, or logs.
3. A user cannot retrieve someone else's leave/ticket data by adding IDs or changing request parameters.
4. Commands scoped to a channel fail in other channels, including direct API and socket invocation.
5. Removed channel members cannot execute commands on that channel or receive later shared events.
6. Command discovery and autocomplete reveal no hidden/private channel or restricted admin capability.
7. Context-required commands fail without valid selected message/file/canvas references.
8. All mutating commands verify permission and idempotency; retries cannot duplicate writes.
9. High-risk and destructive commands require explicit confirmation and appropriate audit details.
10. Electron and PWA show consistent private/shared outcomes with no sensitive local notifications.
11. Input validation blocks unbounded arguments, injection, HTML/script execution, spoofed slash commands, and unauthorized resource references.
12. Feature flags cleanly hide unsupported commands without generating empty actions.

## 18. Scope exclusions and build guidance

This is a **slash-command specification only**. It defines how commands invoke existing features; it does not specify full independent implementations of chat, task management, meetings, HR policy, file storage, encryption, or deployment. A command whose underlying feature does not yet exist stays disabled until implemented. Before coding, inventory existing route/service names, role definitions, channel IDs, schemas and the Electron/PWA composers, then implement against those interfaces with regression tests.
