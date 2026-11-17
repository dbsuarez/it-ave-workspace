# IT Avenue Workspace — Phase 5 Step-by-Step Verification Guide

**Baseline:** Cumulative Patch 36 (Phase 4 implementation), git commit `736a351`  
**Last reported backend result:** 463 tests, 463 passed, 0 failed, 0 skipped (2026-11-15)  
**Environment:** Windows development PC, Electron desktop client, Node.js/Express + Socket.IO backend, PostgreSQL 15  
**Purpose:** Verify actual user workflows, authorization, data integrity, and release readiness. This guide is a **manual test plan**, not evidence that the manual checks have passed.

> **Safety first:** Perform destructive actions only in a disposable test workspace or restored database copy. Back up the PostgreSQL database **and** uploads before testing. Do not perform a real permanent deletion or workspace reset in a workspace with information you need to keep. Do not attempt to manufacture missing-manager conditions directly in production SQL.

## 0. How to use this document

For each test:
1. Follow **Actions** in order.
2. Compare the app with **Expected**.
3. Tick **Pass** only when all expected results hold; tick **Fail** and log details otherwise.
4. Record a screenshot and backend log excerpt if it fails. Never put passwords or tokens in screenshots/logs you share.
5. If a control label differs from the guide, record the actual location. Where the guide says a UI control is *not exposed*, verify via an approved development API client or flag **Blocked — no UI** instead of inventing a hidden menu.

Result legend: **PASS** / **FAIL** / **BLOCKED** / **NOT RUN**. Each test has an empty checkbox to mark completion and an optional note line.

## 1. Prerequisites and safe setup

### 1.1 Confirm code and environment

1. Confirm the working repository is at git commit `736a351` or later (Patch 36 is already committed; nothing needs extracting).
2. Open PowerShell and confirm the backend directory exists:
   ```powershell
   Test-Path 'D:\Development\itavenue-workspace\backend\package.json'
   ```
3. Confirm PostgreSQL and the backend are running using **your existing startup method**. Do not guess container names or run database-creation commands on production.
4. Launch Electron using the project's existing command or installed test build. Verify that it connects to the intended **test** backend (check the server address at sign-in).
5. Re-run baseline tests if code or the database changed since the verified run:
   ```powershell
   cd D:\Development\itavenue-workspace\backend
   npm test 2>&1 | Tee-Object -FilePath ..\phase5-baseline-tests.txt
   ```
6. Target: **463 passing, zero failures, zero skipped**, unless additional tests have been added. If tests skip unexpectedly, investigate PostgreSQL or other dependencies before proceeding.

- [ ] **P5-SETUP-01** Electron, backend, and database all connected to the intended test environment.
- [ ] **P5-SETUP-02** Automated tests fully pass.

### 1.2 Back up before destructive tests

1. Identify the test database and confirm it is **not production**.
2. Using the application's supported backup workflow (if configured), create a new backup containing **database and uploaded files**. If using PostgreSQL tools, confirm the database name and credentials with your existing setup; `pg_dump` alone does **not** back up uploaded files.
3. Note the backup location and creation time. Preserve a separate copy of the uploads directory.
4. Practice **restoration on a different disposable database/workspace**, not in place on your working environment.
5. Keep a test channel with identifiable sample messages/files to check after restore.

- [ ] **P5-SETUP-03** Database backup and upload backup recorded.
- [ ] **P5-SETUP-04** Restore target prepared; no production restore attempted.

### 1.3 Prepare accounts and organization

Using the **Superadmin** account and your existing administration/employee-management screens, create or verify the following **disposable test accounts**:

| Alias | Kind | Setup | Use |
|---|---|---|---|
| `SA` | Superadmin | Workspace administrative account | Metadata management, audit and recovery |
| `LEAD` | Employee/team leader | Reports configured beneath this account | Shared Team Section |
| `A` | Employee | Directly reports to LEAD | Manager 1 |
| `B` | Employee | Reports to A (grandchild of LEAD) | Manager 2 / nested hierarchy |
| `C` | Employee | No access to private test channel | Negative access test |
| `D` | Employee | Authorized member, later banned | Revocation test |
| `G` | Guest | Only a permitted guest channel | Guest restrictions |

1. Use **Employee/People Management** to assign reporting lines: `LEAD → A → B`.
2. Assign A and B to a test department (if applicable). Make C outside that department and without an individual channel grant.
3. Use separate Electron sessions where possible. If one desktop instance is available, sign out and sign back in between account checks; after changing access, restart/reload the client to check stale cached navigation.
4. Create a disposable private channel named `phase5-private` and a disposable channel named `phase5-delete-me` (use distinctive names; avoid clashes).
5. Populate `phase5-private` with a sample message, a reply, one file, a canvas, and a List; these will serve as read-only checks after archiving.
6. Record channel IDs/links where available. Do not copy authentication tokens into your log.

- [ ] **P5-SETUP-05** Test users, hierarchy, two disposable channels, and sample content ready.

## 2. Channel access, departments, and Sections

### P5-ACCESS-01 — Department-based visibility
**Actions**
1. As SA or an authorized channel administrator, open `phase5-private` → **Channel Access** (or equivalent access tab).
2. Grant access to the test department containing A and B. Leave C without direct invitation or department grant.
3. Sign in as A; find and open the channel.
4. Sign in as B; find and open it.
5. Sign in as C; search and try opening the channel using its previously recorded link if available.

**Expected:** A and B can open content. C cannot discover or retrieve content, even with a direct link. A department provides visibility, **not** automatic posting or moderation privileges.

- [ ] PASS / FAIL / BLOCKED — P5-ACCESS-01  
Notes: __________

### P5-ACCESS-02 — Individual invitation and expiry
**Actions**
1. Remove D from the channel's department scope, then add D through a direct channel invitation or direct access grant.
2. Confirm D can join and read.
3. If expiry is supported in the Channel Access UI, set a short, safe future expiration in the test environment.
4. After expiry, refresh D's client and try the channel and a direct content link.
5. If no expiry control exists in Electron, mark **Blocked — UI** and ask for API-level testing.

**Expected:** Direct access works while valid, then expires; no ongoing Socket.IO notifications or content retrieval after revocation. An unrelated department grant, if one remains, can still grant access, so remove that first when testing expiry alone.

- [ ] PASS / FAIL / BLOCKED — P5-ACCESS-02  
Notes: __________

### P5-ACCESS-03 — Ban overrides every access path
**Actions**
1. Grant D access through both department and direct membership, if possible.
2. Have D open the channel and keep the session connected.
3. As a permitted manager/moderator, ban D with a reason.
4. Try refreshing, posting, reading history, opening a file or canvas, and receiving a new notification as D.
5. Check a second already-connected session for D if available.

**Expected:** D loses access despite department/direct grants; content and notifications stop, and existing Socket.IO room membership is reconciled. Never use an authorized admin's private-content access as evidence of a bypass.

- [ ] PASS / FAIL / BLOCKED — P5-ACCESS-03  
Notes: __________

### P5-SECTIONS-01 — Nested Team Section placement
**Actions**
1. As LEAD, create a Team Section using the sidebar Section tools.
2. Put an appropriately authorized test channel in it; identify the channel by exact name.
3. Sign in as A (direct report), then B (grandchild via A).
4. Check the sidebar, then refresh/restart Electron and check again.
5. Confirm the channel does **not** appear duplicated as a floating channel.

**Expected:** LEAD, A and B see the authorized channel under the same Team Section; unauthorized users do not gain access merely because of the Section.

- [ ] PASS / FAIL / BLOCKED — P5-SECTIONS-01  
Notes: __________

### P5-SECTIONS-02 — Superadmin and personal sidebar separation
**Actions**
1. Make sure SA is individually or otherwise legitimately authorized for the test channel where content access is needed.
2. Sign in as SA and inspect sidebar placement.
3. Compare with LEAD's Section, and ensure the channel is not floating or duplicated.
4. Create/modify a **personal** Section for A, then inspect B/SA's layout.

**Expected:** SA sees shared Section placement for channels SA may view; a personal Section of A is not automatically copied to others. Administrative metadata visibility must not silently grant private channel content access.

- [ ] PASS / FAIL / BLOCKED — P5-SECTIONS-02  
Notes: __________

## 3. Roles, actions, and channel managers

### P5-ROLES-01 — Access is not permission to act
**Actions**
1. Give A and B channel visibility through a department.
2. In the channel **Permissions** area, configure the Everyone and/or test role rules so A may post but B cannot (or use per-person overrides).
3. As both accounts, open and read the channel; attempt to post.
4. Remove B's department grant, leaving a valid direct invitation if intended, and recheck action permissions.

**Expected:** Access and action permissions are independent. Departments affect who can enter, while roles and individual action overrides determine allowed actions. A user whose access is removed cannot bypass with a role permission.

- [ ] PASS / FAIL / BLOCKED — P5-ROLES-01  
Notes: __________

### P5-MANAGER-01 — Two equal managers
**Actions**
1. As SA or an authorized channel manager, open `phase5-private` → **Channel Access** → manager controls.
2. Verify A and B both already have channel access.
3. Assign both as channel managers; save.
4. Sign in as A and confirm manager roster and channel settings are available.
5. Sign in as B and perform a reversible manager-level operation (for example, archive then restore the disposable channel, or change the roster and revert).
6. Check the audit log for who performed each change.

**Expected:** A and B can exercise equivalent channel-management authority, without requiring creator login or workspace-wide Superadmin privileges. Changes are audited.

- [ ] PASS / FAIL / BLOCKED — P5-MANAGER-01  
Notes: __________

### P5-MANAGER-02 — No unauthorized promotion; protect last active manager
**Actions**
1. Try assigning C (no channel access) as a manager.
2. Try assigning an inactive or banned account, if safe to arrange.
3. Attempt to remove managers until only one eligible manager remains; try removing that last manager through the normal control.
4. Attempt the same actions as a non-manager regular member.

**Expected:** Promotion does not create membership; ineligible candidates are rejected. Ordinary operations do not leave a channel without an eligible manager. Unauthorized roster edits are refused.

- [ ] PASS / FAIL / BLOCKED — P5-MANAGER-02  
Notes: __________

## 4. Archive, read-only behavior, and restore

### P5-ARCHIVE-01 — Archive/read-only channel
**Actions**
1. Populate `phase5-private` with sample messages, replies, pinned message, reaction, file, canvas content, and List rows.
2. As A or B, archive the channel using the channel management control.
3. As an authorized member, open history, files, canvas, and Lists.
4. Attempt each operation below and record the behavior:

| Operation while archived | Expected |
|---|---|
| Read existing messages and replies | Allowed if previously authorized |
| Send new message or reply (including real-time Socket.IO send) | Denied |
| Add/change/remove reaction | Denied |
| Pin or unpin a message | Denied |
| Create/change/delete List or row; copy a List into the channel | Denied |
| Edit canvas; add comment or image | Denied |
| Delete channel-attached file | Denied |
| Restore the channel as authorized manager | Allowed |

5. Check the app communicates why the operation is blocked. If the UI hides the button entirely, record that and confirm the backend guard with the existing tests or approved API client.
6. Repeat the archive write attempt as SA **only if SA already has content access**, to ensure high privilege does not override read-only state.

**Expected:** Archive preserves existing content for authorized readers and prevents content changes across covered paths, regardless of privilege.

- [ ] PASS / FAIL / BLOCKED — P5-ARCHIVE-01  
Notes: __________

### P5-ARCHIVE-02 — Restore and resume
**Actions**
1. As A or B, restore the same channel.
2. Refresh authorized member sessions.
3. Post a new message, react, pin/unpin, update a List and a canvas according to their normal permissions.
4. Verify previous messages/files/canvases/Lists are intact.

**Expected:** Allowed mutations resume only after restoration; original access/permission and content are preserved.

- [ ] PASS / FAIL / BLOCKED — P5-ARCHIVE-02  
Notes: __________

## 5. Administrative recovery and controlled deletion

### P5-RECOVERY-01 — Last-manager recovery (isolated environment only)
**Important:** The recovery endpoint is meant for an existing channel that **already has no active eligible manager**. Normal manager controls intentionally prevent creating that condition. Do **not** bypass normal controls or tamper with the real database to force it.

**Actions**
1. In a dedicated disposable database, reproduce a genuine no-active-manager condition using a supported account deactivation/removal workflow, if available.
2. Verify replacement A is an **existing active, unbanned, authorized channel member**.
3. Sign in as SA, locate administrative recovery (if UI exposed). If not, mark **Blocked — no Electron recovery UI** and use the documented authenticated development endpoint only with approval.
4. Recovery endpoint for developers: `POST /api/moderation/channels/{channelId}/recover-manager` with the exact confirmation `RECOVER CHANNEL MANAGER`. Confirm the exact request-body schema in source/API docs **before sending**; this guide does not invent a body format.
5. Recover management to A; inspect audit entries.
6. Try a non-member, banned member, or inactive account as replacement, and try a non-admin actor.
7. Check SA's private-channel message and file access both **before and after** recovery without granting SA membership.

**Expected:** Recovery works only when truly required; replacement already has access; unauthorized alternatives fail; audit identifies actor and target; SA cannot suddenly read private content.

- [ ] PASS / FAIL / BLOCKED — P5-RECOVERY-01  
Notes: __________

### P5-DELETE-01 — Permanent deletion safeguards (throwaway channel only)
**Actions**
1. Verify `phase5-delete-me` is a **disposable** channel and take a backup.
2. As C (ordinary non-manager), attempt to delete it; check denial.
3. As SA/authorized manager, attempt deletion while the channel is active.
4. Confirm active shared channels require archiving before permanent deletion.
5. Archive the disposable channel.
6. Attempt deletion without the required confirmation; verify refusal.
7. Only after you have rechecked the channel name and verified the backup, enter the exact confirmation phrase requested by the UI and delete it.
8. Verify that channel navigation/search no longer exposes it, connected members are notified appropriately, and its content is no longer available through old links.
9. Inspect audit log entry and ensure unrelated channels remain untouched.

**Expected:** Authorization → archive required → explicit confirmation → deletion and notification, without accidental deletion of another channel.

- [ ] PASS / FAIL / BLOCKED — P5-DELETE-01  
Notes: __________

## 6. Cross-feature and live-session security

### P5-REALTIME-01 — Access changes in a live session
**Actions**
1. Open the same authorized channel in two signed-in sessions for D (if practical).
2. From A, post a message; confirm delivery to D.
3. Remove D's sole access grant or ban D without signing D out.
4. As A, post another message and update a channel canvas or List.
5. Try a fresh fetch, search query, and old file URL from D.

**Expected:** No new channel events or content are delivered to revoked D; old links fail appropriately. Reconnection does not restore revoked access.

- [ ] PASS / FAIL / BLOCKED — P5-REALTIME-01  
Notes: __________

### P5-GUEST-01 — Guest boundaries
**Actions**
1. Grant G access only to a designated guest-safe channel.
2. Confirm G can interact only to the extent configured for a guest.
3. Attempt opening `phase5-private`, browsing employees without the required permission, or starting restricted group conversations.
4. Check channel canvas/List write restrictions and files from the guest account.

**Expected:** Guest permissions remain constrained; no private-channel or employee-directory exposure through shared links or search.

- [ ] PASS / FAIL / BLOCKED — P5-GUEST-01  
Notes: __________

### P5-NOTIFY-01 — Mentions and notification identity
**Actions**
1. As A, mention B in an authorized channel message and canvas.
2. As B, inspect Activity and notifications. Compare display name with configured first/middle/last name.
3. Remove B's access and verify new channel mention/activity is not delivered.
4. Confirm canvas activity uses the full employee name where supplied and falls back to username if name components are absent.

**Expected:** Correct display name and access-filtered notifications, without leaking channel content to ex-members.

- [ ] PASS / FAIL / BLOCKED — P5-NOTIFY-01  
Notes: __________

## 7. Migration, backup/restore, and deployment readiness

### P5-DATA-01 — Migration repeatability
**Actions**
1. On a **disposable** restored copy, run the project's documented migration startup/workflow (do not guess a command).
2. Note migration version and logs; rerun using the supported workflow.
3. Check employee roles, multiple departments, reporting lines, Section placement, manager rosters, and archive state.
4. Run the backend tests and inspect for database errors.

**Expected:** No destructive unexpected changes; migrations are safe to rerun when designed to be idempotent; current schema supports all Phase 4 fields.

- [ ] PASS / FAIL / BLOCKED — P5-DATA-01  
Notes: __________

### P5-DATA-02 — Restore rehearsal
**Actions**
1. Create identifiable sample message, file, List, canvas, and manager assignment in disposable test environment.
2. Produce a backup via supported mechanism, ensuring upload files are included.
3. Restore to a **different** disposable database/workspace.
4. Sign in and compare sample content, manager roster, Section placement, and archive state.
5. Check whether file downloads actually work; database row presence alone is insufficient.

**Expected:** Data and uploads restore consistently. Do not mark PASS if the content is present but files are missing.

- [ ] PASS / FAIL / BLOCKED — P5-DATA-02  
Notes: __________

### P5-RELEASE-01 — Final smoke test
**Actions**
1. Restart PostgreSQL/backend and Electron using your normal development setup.
2. Sign in as SA, A, B, C, and G; check intended navigation and session persistence.
3. Send message, update canvas/List, download file, archive and restore disposable channel, inspect audit history.
4. Run full backend suite and save output:
   ```powershell
   cd D:\Development\itavenue-workspace\backend
   npm test 2>&1 | Tee-Object -FilePath ..\phase5-final-tests.txt
   ```
5. Inspect server/Electron logs for unhandled errors, secrets or token leakage, repeated permission failures or migrations running unexpectedly.
6. Confirm current changed-files patch, manifest, migration instructions, and recovery backup are retained together.

**Expected:** All relevant checks PASS with no unresolved security-critical failures; all applicable automated tests pass with zero skips.

- [ ] PASS / FAIL / BLOCKED — P5-RELEASE-01  
Notes: __________

## 8. Issue report template (copy for each failure)

```markdown
### P5-ISSUE-001 — Short description
- Test ID: P5-____
- Result: FAIL / BLOCKED
- Account/role: 
- Environment: Windows + Electron version / backend version / test database
- Test channel (safe alias only):
- Prerequisites:
- Steps to reproduce:
  1.
  2.
  3.
- Expected:
- Actual:
- Time and timezone:
- Error message / redacted log:
- Screenshot filename:
- Reproduces after Electron refresh/restart?:
- Severity: Critical / High / Medium / Low
```

**Security severity guide:** **Critical:** unauthorized private content read or destructive action; **High:** denied user receives events, archived write bypass, admin recovery bypass; **Medium:** legitimate functionality blocked or incorrect Section; **Low:** misleading UX text, minor layout.

## 9. Completion gate and sign-off

Do **not** mark Phase 5 release-ready merely because the backend suite passes. Before sign-off:

- [ ] Full backend suite: all current tests pass, **zero skipped** (Patch 36 baseline: 463/463).
- [ ] Access, department, invitation, bans, and live-session revocation tests pass.
- [ ] Team and Superadmin shared Section placement tests pass.
- [ ] Manager assignment/authority/last-manager protection tests pass.
- [ ] Archived channel is read-only across messages, Socket.IO, Lists, canvases, files, reactions and pins.
- [ ] Administrative recovery has been verified in a disposable environment or explicitly documented as **blocked**.
- [ ] Controlled permanent deletion passes in a disposable channel.
- [ ] Guest, notifications and name-display checks pass.
- [ ] Backup and restoration rehearsal has been performed with uploads.
- [ ] No unresolved **Critical** or **High** issues.
- [ ] Release candidate includes migrations, cumulative change manifest and rollback guidance.

**Final outcome:** `NOT RUN` / `BLOCKED` / `FAILED` / `READY FOR RELEASE CANDIDATE`

**Tester:** __________  **Date:** __________  **Patch:** 33 or later  **Test environment:** __________

---

**Important distinction:** The 463/463 result establishes backend regression success for Patch 36; the checks above establish whether the Electron experience, security boundaries, and backup/recovery workflows work end-to-end. They are intentionally separate.
