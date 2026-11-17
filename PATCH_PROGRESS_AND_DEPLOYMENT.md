# IT Avenue Workspace — Cumulative Patches 27–36 (latest: Patch 36)

> **Status note (2026-11-17):** the sections below were written patch by patch and the newest one, Patch 33, is the last with its own write-up. Patches 34–36 were applied and tested (Patch 36 log, 2026-11-15: 463 tests, 463 pass) but were not written up here; their changed-file list is `PATCH_MANIFEST.txt` in git history (Patch 35). The whole series was reconciled into git as commit `736a351`. Current backend result: 463 tests, 462 pass; the one failure was a date-dependent leave test, since fixed. Manual verification (`docs/IT_AVE_PHASE5_STEP_BY_STEP_VERIFICATION.md`) has not been run.

# Phase 4 completion candidate — Cumulative Patch 33

**Baseline:** Patch 32, user confirmed 458/458 backend tests passed.

## Final archive-write coverage changes
- Lists: all write-mode list mutations reject archived channels; new lists and copied-list destination also require unarchived channel state. Read-only listing remains available.
- Message pins and reactions: check channel archive state after channel membership and before mutation.
- Real-time channel message sending is already guarded by `ensureCanPostToChannel` in Socket.IO. Direct messages remain unaffected.
- Prior Patch 31 canvas and file guards retained. Manager roster equality, recovery and controlled deletion retained.
- Tests added: source-coverage assertions and database-backed List archive workflow test. Existing pins/reactions mocks updated to recognize archive-state lookup.

## Verification & release gate
- Local 2/2 source tests and JavaScript syntax passed.
- Full backend suite needs running with your PostgreSQL setup; expected at least 461 tests (458+3). Pins/reactions mocks were updated for archive-state lookup.
- Manual Electron tests of archive/restore, manager changes and recovery have not occurred and must be done before production release.
- **Phase 4 feature implementation is complete; release validation is not yet confirmed.**

## Deployment
Extract ZIP over original repository (changed files only), preserving all unmodified files. Then:
```powershell
cd D:\Development\itavenue-workspace\backend
npm test 2>&1 | Tee-Object -FilePath ..\patch33-test-results.txt
```

## Cumulative history (retained verbatim)

# IT Avenue Workspace — Cumulative Patch 30 — Phase 4 regression repair

**Input:** Patch 29 user test log: 455 tests, 452 passed, 3 failed. **Current patch status:** candidate awaiting full suite.

## Patch 30 changes
- `backend/src/routes/moderation.js`: authorization occurs before shared-channel archive-state disclosure, so unauthorized deletion attempts return 403 rather than 409. For nonpersonal channels, `manage_channels`, prior archiving, and exact destructive confirmation remain required. No content-read authorization is added to a workspace administrator.
- `backend/test/moderation-channels.test.js`: updated end-to-end deletion scenario to require authorization, archive, exact phrase, and verification of deleted records/files and member notification. Legacy creator-alone permanent deletion is intentionally not preserved.
- `backend/test/security.test.js`: existing timeout and slow-mode mocks now respond to the read-only `archived_at` lookup and continue testing the original controls.

## Verified here
- JavaScript syntax checks for all three modified files passed.
- ZIP integrity verified during packaging. Full backend regression suite not runnable here without backend dependencies / scratch PostgreSQL. User should rerun 455 tests or more locally.

## Apply and test
Extract this **cumulative changed-files-only** ZIP over the original development project. Keep the unchanged project files in place.
```powershell
cd D:\Development\itavenue-workspace\backend
npm test 2>&1 | Tee-Object -FilePath ..\patch30-test-results.txt
```
Phase 4 remains an implementation candidate: live manager equality/recovery, archive-write-path coverage, UI testing and staging authorization require further verification.

## Preserved historical cumulative progress

# Patch 28 — Superadmin Team Section placement

**Baseline:** Revised Patch 27, user verified 448/448 tests passed.

## Implemented
- Superadmins can discover Team Sections outside their own reporting ancestry.
- Each Team Section channel is checked against authoritative channel membership; this change grants no channel access.
- Unrelated empty sections are omitted and a team channel is not repeated in an inherited creator section.
- Added integration assertions for a Superadmin outside the hierarchy, plus an independent source regression test.
- Nested employee inheritance, canvas full-name notifications, and personal sections from Patch 27 remain intact.

## Verification
- JavaScript syntax, focused source test, and archive integrity checked locally.
- Full backend suite and Electron manual checks remain for the user to run.
- Validate leader, direct report, grandchild, Superadmin, banned user, and a personal Section override.

## Deployment/test
Extract cumulative patch into the repository root, and run:
```powershell
cd D:\Development\itavenue-workspace\backend
npm test 2>&1 | Tee-Object -FilePath ..\patch28-test-results.txt
```
Then restart backend and source Electron client. Do not run against production until tested.

## Historical cumulative report — Patches 01–27

# IT Avenue Workspace — Patch 27 (revised) — Nested Team Sections + Canvas Display Names

This revision folds the canvas activity display-name fix into the same Patch 27 cumulative archive.

## Changes folded into Patch 27
- Backend live canvas mention/comment/reply/activity events now expose `actorDisplayName` composed of employee first, middle, and last names; falls back to username if no name exists.
- Activity feed queries expose the display name for existing/history canvas items, so old notifications also show the employee name without rewriting stored records.
- Frontend uses `actorDisplayName` for notification sentences and avatar initials; usernames remain intact for login and @mention lookup.
- Canvas mention integration test now verifies full name for socket notifications and Activity feed; source regression test added.
- Nested reporting-chain team Section fix remains unchanged.

## Validation
- JavaScript syntax checks passed for changed JS.
- Focused source regression tests passed locally.
- Full backend suite and Electron UI runtime checks pending on the user's environment.
- No database migration or employee reset is triggered by applying this patch.

## Apply
Extract revised Patch 27 ZIP into the repository root, run `npm test` from backend, and restart development backend and Electron frontend.

## PRESERVED PRIOR CUMULATIVE HISTORY

# IT Avenue Workspace — Patch 27 — Nested team Section inheritance

**Previous user-verified full suite:** Patch 26 — 446 tests passed, 0 failures.

## Patch 27 change
- Fix sidebar team Section discovery to walk the full `manager_id` reporting chain, rather than only immediate manager.
- Uses `WITH RECURSIVE ... UNION` to avoid infinite traversal on accidental reporting cycles.
- Does not grant new channel membership, posting permissions, or channel-content access. A viewer must still have channel access through existing policy.
- Added a grandchild reporting-level integration assertion to `workspace-sidebar-sections.test.js` and an independent source regression test.
- Personal and workspace Sections are unchanged. Section owner remains the only editor.

## Validation
- Local source regression test and JavaScript syntax checks: passed.
- Full backend suite and live Electron multi-level UI check still required.
- After patch: test leader -> manager -> employee, verify authorized grandchild sees the original team Section, while an unrelated user does not.

## Apply
Extract the cumulative ZIP over the repository root, then run:
```powershell
cd D:\Development\itavenue-workspace\backend
npm test 2>&1 | Tee-Object -FilePath ..\patch27-test-results.txt
```
Restart backend and frontend from source for UI verification. Patch-only ZIP includes Patches 01–27.

## PRESERVED CUMULATIVE PATCH 01–26 HISTORY

# IT Avenue Workspace — Cumulative Patch 26 — Employee reset UX

**Last user-verified baseline:** Patch 25 — 443/443 backend tests passed, 0 failures.

## Patch 26 implemented
- Added Superadmin-only **Reset Employee Roles** control inside Moderation > People and Groups > Workspace members.
- Added an explanatory warning listing what is removed and what is preserved, and reminding the operator to back up the test database.
- Reset is never run on page load or backend startup. User must open the control, type exactly `RESET EMPLOYEE ROLES`, and accept an additional confirmation dialog.
- Calls the existing Superadmin-guarded `POST /api/admin/employee-role-reset` backend route; displays returned employee/role/override counts and refreshes permission-related client state.
- Added three UI wiring regression tests: passed locally 3/3. JavaScript syntax checked.
- **No production database or deployed app was changed by preparing this patch.**

## Verification and remaining work
- Patch 25: user verified 443/443 full backend suite.
- Patch 26: 3/3 focused UI-source tests passed locally. Full suite **not run** in this environment; expected roughly 446 tests after applying this cumulative ZIP.
- Execute the reset once on a backed-up test database using the Electron UX, then inspect affected roles and permissions. Confirm Owners and guests remain unchanged.
- Manual checks: Screen visibility for Superadmin only; cancellation; typo; confirmation rejection; successful result; client reconnect after the reset.

## Apply and test
Extract the ZIP over your development repository, preserving directory structure. It includes all cumulative changed files from Patches 01–26, not the entire project.
```powershell
cd D:\Development\itavenue-workspace\backend
npm test 2>&1 | Tee-Object -FilePath ..\patch26-test-results.txt
```
Then restart the backend and Electron source client. A packaged .exe requires rebuilding to receive this UI.

## PRESERVED CUMULATIVE PATCH 01–25 HISTORY

# IT Avenue Workspace — Cumulative Patch 25 — Phase 3 verification hardening

**Verified baseline:** Patch 24 — user reported 438/438 tests passed, zero failures.

## Patch 25 work
- Added five executable fake-transaction regression tests for the opt-in Employee role reset (not merely source-pattern checks).
- Covered required confirmation, admin validation, Owner/guest exclusions, role removal and action-only overrides, rollback on failure, and empty employee population.
- Verified new tests locally: 5/5 passed with Node.js 22. No database was modified.
- **No production source behavior was changed in Patch 25.** Existing Patch 24 Employee reset is still not invoked automatically.
- Groups/Sections Electron manual test, live permission audit, and staging reset execution remain outstanding. Do not claim Phase 3 release-ready on these focused tests alone.

## Testing
After extracting this cumulative changed-files-only ZIP into the full repository:
```powershell
cd D:\Development\itavenue-workspace\backend
npm test 2>&1 | Tee-Object -FilePath ..\patch25-test-results.txt
```
Expected count: approximately **443** (438 verified + 5 added tests).

## Full cumulative history (preserved from Patch 24)

# Patch 24 — one-time Employee role reset

Verified baseline: Patch 22 (431/431 full backend tests); Patch 23 and Patch 24 full suites still require user verification.

Adds explicit POST `/api/admin/employee-role-reset` (subject to actual admin-router mount) with JSON `{"confirmation":"RESET EMPLOYEE ROLES"}`. Superadmin only. Never invoked automatically. Restricts reset to member accounts that are not Superadmins; leaves guest accounts untouched. Removes assigned roles, sets legacy `is_hr=false`, and strips per-user channel *action* allow/deny overrides while keeping `view_channel` overrides. Keeps department membership, channel membership, bans, invites, messages, and all other content. Audit event is emitted. Database transaction rolls back on error. Disconnects socket sessions after success, so employees must reconnect.

Important: a role may itself have supplied channel visibility through a role-based `view_channel` override. Clearing role assignments can therefore remove access that depended exclusively on those roles; don't run before checking this in staging. A database backup is recommended before reset. The reset is intended for disposable employee-role test data, not production.

## Full cumulative development history

# IT Avenue Workspace — cumulative development, verification and deployment

## Verified baseline
Patch 20: 422/422 backend tests passed on the user’s Windows machine. Patch 21 focused tests passed locally; full suite requires user run.

## Patch 21 implementation
- Added opt-in transactional conversion for safe access-only department overrides. No migrations execute automatically at backend startup.
- Explicit approval, parameter validation, row locking, pre/post effective membership comparisons for active users, and rollback on parity drift.
- Ambiguous rules, department action overrides, and access denies remain blocked for manual mapping.
- This does NOT implement a full automatic historical action-permission migration; it needs business decisions on role and user mapping.
- NOTE: This routine is an internal operator API, not a public endpoint or unattended production migration. Backup and staging review are required.

## Cumulative patch-by-patch history (original reports preserved verbatim)

### Patch 01

# IT Avenue Workspace — Cumulative Patch 01

**Source baseline:** user-uploaded `it-ave-workspace-main.zip` (2026-11-14).  
**Mode:** direct conversation; no ChatGPT Work, no GitHub or production changes.  
**Packaging:** changed/new files only. This is the start of the cumulative patch series; subsequent revisions must include **all files from Patch 01 onward**.

## Implemented in Patch 01: legacy built-in HR role conversion

- Startup migrations add a stable legacy-HR identity marker, transfer employees currently marked `users.is_hr` into explicit `user_roles` grants, and convert the built-in HR role **in place** into a custom role. Role ID, permission array, role color, and references are retained. It is repositioned into the custom-role range.
- Converted HR is editable and assignable via the normal Roles APIs, and its employee appears in the ordinary role checkbox column rather than a special HR column.
- Core permission resolver no longer grants HR capabilities merely because `users.is_hr` is true. Role mentions now resolve through `user_roles` rather than that flag.
- Employee-facing HR UI switch remains temporarily compatible: its endpoint adds/removes the normal role assignment. Role assignments update the legacy display flag.
- HR employee authorization helper and HR-like SQL check rely on actual `manage_people` capability or Owner status instead of raw `is_hr`.
- Converted HR role cannot yet be deleted: the old employee-record HR switch still needs a stable role target. It can be renamed, recolored, repermissioned, and assigned like an ordinary custom role. Complete UI retirement before allowing deletion.

## Verification

- PASS: `node --check` on modified JavaScript application and test files.
- PASS: `node --test backend/test/hr-role-migration-source.test.js` (1 test).
- NOT RUN: PostgreSQL-dependent integration tests. The uploaded ZIP has no installed `node_modules`; `npm ci --offline` failed because dependencies are not cached. Database startup migration has not been executed here.
- NOT VERIFIED: full workspace authorization, live deployment, UI/Electron integration.

## Deployment safety / manual verification

1. **Do not deploy before backup and review.** Back up PostgreSQL (including `users`, `roles`, `user_roles`, `channel_overrides`). Have a rollback image/version ready.
2. Apply all files in this ZIP at their existing relative paths, preserving the directory structure. Do not copy only the migrations or only the backend routes.
3. Run `cd backend && npm ci && npm test` against a disposable PostgreSQL test database according to existing test prerequisites.
4. Before applying against production, inspect the HR employee(s), original HR role ID, `manage_people` grants and any special channel overrides.
5. Start backend in a staging environment. Its existing startup migration mechanism applies the conversion. Verify role ID preserved, `builtin_key` becomes null and `legacy_hr=true`, `user_roles` assigned to intended employee(s), and `users.is_hr` alone no longer grants access.
6. Test role UI, employee HR checkbox, HR management routes, role mentions, leave and attendance permissions, and reassignment/revocation. Repeat server restart to confirm no role duplication/re-grant.
7. Rollback requires a **database restore**, not just restoring code: startup migrations are data transformations and the old version assumes a built-in HR role.

## Next phases — not implemented in Patch 01

- P02: Department membership with primary + additional departments, source-tracked channel grants, automatic join, bans, direct invitation expiration, and cross-channel authorization enforcement.
- P03: Separate Access/Members/Permissions/Restrictions settings; remove department-based *action* overrides after access-impact inventory and approval.
- P04: Equal multi-manager lifecycle, archive/recovery, audited changes, history/mention enforcement, and scoped global overrides.
- P05: End-to-end regression coverage, existing Owner/View-as explicit policy gate, comprehensive migration and rollback rehearsal.

**Important:** The approved architecture spec remains the TARGET, not an assertion that P02–P05 have been implemented. The Owner/View-as private-content access behavior still needs a separate decision before alteration.

## Cumulative files

- `backend/src/hr.js` — SHA256 `33b2d52ebd4d17a330a3d4fbb942534a5b74f1d48bfbb1c538376da3e8f369cd`
- `backend/src/migrations.js` — SHA256 `f848bf98de11005323fb928955fa6b272db0fd591715363cd76e045c7b980b61`
- `backend/src/permissions.js` — SHA256 `f44230648346c6f4c10b76b9d0d6f1619ae856fb1e4e1da0937489acae2c77a8`
- `backend/src/routes/hr.js` — SHA256 `2a0a2aee85ab01f414981685fe9853280dac33f0e2594ddf6518308ac54a9701`
- `backend/src/routes/roles.js` — SHA256 `3a5ee664fc95d927d219f04a5100fab0e4ad11cd757ee325f7cf40f2c11f8e3e`
- `backend/src/sockets/chat.js` — SHA256 `05443a90f133b4a259e8e6dbf2af4e5580a36e673fc55586207f45b462bd647b`
- `backend/test/hr-role-migration-source.test.js` — SHA256 `2e69b3ee13f1de133e7c71f697891797dd66c1ba0d34007f12d0325152475898`
- `backend/test/permissions.test.js` — SHA256 `c7db840e3d19deceb8d48aba9d315a2f7cd97e254dcdae1f18b95cdb1dc88c19`
- `backend/test/roles.test.js` — SHA256 `be26d16a90cce6f51c417dd955c330b55a2317724e47fb5633b6c777d5ec0510`
- `frontend/src/features/roles.js` — SHA256 `98280d3caa4eb48ef398bb9d76b9019869871c0f5182e7548ecaa771dced6d89`

---

### Patch 02

# IT Avenue Workspace — Cumulative Patch 02 (Test regression repair)

## Status
Source-level fixes made and JavaScript syntax verified. **Full Node test suite NOT run in this container** (backend dependencies and a configured test PostgreSQL service are unavailable). This is NOT a claim of 0 failures. Rerun `npm test` in your Windows environment and share the next log.

## Baseline and delivery
Original uploaded `it-ave-workspace-main.zip` + all Patch 01 modifications + Patch 02 modifications. The archive contains only files changed across both patches, and these notes, not the full project.

## Findings from the 378-test run
- 334 passed, 44 failed, as reported on Windows.
- Multiple HR/attendance/leave/prelaunch integration fixtures still relied on `users.is_hr = true` conferring permissions. That is intentionally no longer an authorization grant after Patch 01. Fixtures now explicitly assign the legacy HR-role record through `user_roles`.
- `backend/src/routes/files.js` called `ensureChannelMembership` without importing it; fixed the actual runtime ReferenceError. Retains membership checks (not bypassed).
- Moderation test fake SQL adapter was not updated for the new account query shape and returned 500; adapted fake.
- Channel rename test fake database incorrectly matched built-in-channel lookup and claimed every channel was built-in; adapted fake.
- Roles/channel permissions tests contained hardcoded assumptions that HR would retain `builtin_key = hr`; adjusted one ordering assertion and channel list expected data to reflect custom role identity.

## Remaining risks and verification
- The role mention integration test and other stateful tests need rerunning to confirm their expected outputs; no full database verification was possible here.
- Review failures against actual updated implementation, **never restore `is_hr` implicit privileges** just to satisfy old tests.
- Migration of production database must be tested with backup and staging first.
- This is a regression repair batch, not implementation of the entire agreed channel architecture.

## Windows verification
From the project root after extracting this ZIP, run:
```powershell
cd backend
npm ci
npm test 2>&1 | Tee-Object -FilePath ..\patch02-test-results.txt
```
Do not deploy before evaluating failures.

## Development roadmap
1. HR-role conversion: implemented in Patch 01; integration verification pending.
2. HR-related fixture regression repair and file deletion import: implemented in Patch 02; full-suite verification pending.
3. Multiple-department channel grants, bans, invitations: not started.
4. Split channel access and action permissions, UI: not started.
5. Manager lifecycle and archive/recovery: not started.
6. Regression hardening and production migration verification: not complete.

---

### Patch 03

# IT Avenue Workspace — Cumulative Patch 03

## Baseline
Original uploaded `it-ave-workspace-main.zip` plus all modifications from Patches 01–03. The ZIP contains changed/new files only, not the whole project.

## Windows Patch 02 test results
- 378 total, 374 passed, 4 failed.
- Three `backend/test/files.test.js` cases failed with HTTP 500 because the fake transaction adapter did not recognize the real channel-membership authorization query added to the file deletion path.
- One `backend/test/roles.test.js` case expected `@hr`, but an earlier test renamed the converted custom HR role to `Renamed`; a normal role mention handle should therefore change to `@renamed`.

## Patch 03 changes
- `backend/test/files.test.js`: model `ensureChannelMembership` SQL in the mocked transaction adapter and return a realistic `needs_check: false` for seeded channel members. No production authorization check was removed or weakened.
- `backend/test/roles.test.js`: expect renamed custom-role handle (`renamed`) and absence of old `hr` handle after test's rename operation.

## Verification
- `node --check` passed on both modified test files.
- Full test suite **NOT run in this environment** (Node dependencies/PostgreSQL test service not available). Previous Windows results were 374 passed, 4 failed; rerun required to confirm 378/378.

## Deployment instructions
1. Preserve a backup and keep production unchanged until verification.
2. Extract the cumulative Patch 03 ZIP into the project root, preserving paths; it includes all Patch 01 and 02 changes.
3. From `backend`, execute `npm test 2>&1 | Tee-Object -FilePath ..\patch03-test-results.txt` in PowerShell.
4. Send the resulting log if any tests fail.

## Roadmap
- HR legacy built-in role to custom role: implemented; production migration unverified.
- Test regression repairs: Patch 02 + 03 implemented; suite confirmation pending.
- Multiple departments, channel access grants, bans, invitations: pending.
- Separation of channel access and action permissions/UI: pending.
- Multiple channel managers, recovery, archive lifecycle, scoped admin privileges: pending.
- End-to-end regression, production migration and release verification: pending.

---

### Patch 04

# IT Avenue Workspace — Cumulative Patch 04

## Baseline and contents
Original user-uploaded `it-ave-workspace-main.zip`, plus the cumulative changed/new files from Patches 01–04. **Changed/new files only**, never the full source tree. Patch 04 supersedes Patches 01, 02 and 03.

## User-reported Patch 03 result
- Total: **378**
- Passed: **377**
- Failed: **1**
- Remaining failure: `backend/test/files.test.js`: unauthorized non-uploader attachment deletion returned HTTP 500, expected HTTP 403. Test adapter threw `Unexpected files query: SELECT is_superadmin, account_type, department_id FROM users ...` when the actual permission evaluation ran.

## Patch 04 changes
- `backend/test/files.test.js`: add a targeted mock response for the permission evaluator's current account-query schema, representing an active ordinary user with no special permissions. This lets the *existing production* permission check reach the expected HTTP 403 rather than failing the test mock with HTTP 500.
- No production code changes from Patch 03. No authorization bypasses or permission grants added.
- Retains all earlier HR conversion, file deletion import, and regression repairs.

## Verification
- `node --check backend/test/files.test.js`: **passed**.
- Full 378-test suite: **not rerun here** (the available source checkout has no installed backend Node dependencies or attached test PostgreSQL). The user's prior Patch 03 run is **377/378**, not a claim about Patch 04.

## Apply and retest (Windows PowerShell)
1. Back up the existing working tree and test database. Do not apply unverified migrations to production.
2. Extract this ZIP at the repository root with folder paths intact. It includes every changed source/test file since Patch 01.
3. From `backend` run `npm test 2>&1 | Tee-Object -FilePath ..\\patch04-test-results.txt`.
4. Confirm 378/378 pass, then separately test staging migration and HR access before release.

## Roadmap
| Scope | Status |
| --- | --- |
| HR built-in to custom role migration | Implemented; staging data migration unverified |
| HR conversion and related regression tests | Patch 04 candidate; complete suite confirmation pending |
| Multiple departments, computed grants, bans, invitations | Pending |
| Separate channel access from action permissions | Pending |
| Channel managers, recovery, archive, scoped overrides | Pending |
| End-to-end/staging verification and deployment | Pending |

---

### Patch 05

# IT Avenue Workspace — Cumulative Patch 05 / Phase 2 Foundation

## Verified baseline
- User reports Patch 04 backend suite **378 passed, 0 failed**.
- This ZIP includes **all modified source/test files from Patches 01–05**, never a full project.
- No ChatGPT Work used; no production deployment or database migration executed here.

## Implemented in this revision
- Idempotent migration statements establishing `user_departments` with one-primary-department constraint and a backfill from existing `users.department_id`.
- Separate `channel_department_grants`, `channel_direct_grants` (optional expiration), and `channel_bans` relations.
- New isolated `channelAccessPhase2.js`: validates IDs, optional future expiry, calculates union of department and direct grants, and makes explicit bans and inactive users higher precedence; includes DB inspection function.
- Eight focused unit tests for the resolution rules.

## Limitations — Phase 2 is NOT complete
- New tables and policy resolver are NOT wired into existing channel routes, file downloads, search, WebSocket subscriptions, mentions, or frontend UX. The legacy authorization pathways are unchanged, including department action overrides and Owner privileges. Therefore bans in the new table **do not yet block access**. Do not populate bans in an expectation of security enforcement.
- Automatic channel member list enrollment, invitation editing API and expiry notifications, department editing UI, audit logging, and a unified legacy-to-new grants conversion remain pending.
- Existing `users.department_id` remains the authoritative primary department in old code; secondary departments only exist in the new table until the next integration phase.
- The new migration does not modify existing access policy; it only creates relations and backfills organization memberships.
- No PostgreSQL integration test executed here. Full suite needs user rerun. This revision is development-only and must NOT be used as the final Phase 2 release.

## Checks performed
- `node --check backend/src/migrations.js`: PASS.
- `node --test backend/test/channel-access-phase2.test.js`: 8 passed, 0 failed.
- User-reported prior release candidate: 378 passed, 0 failed on Patch 04.

## Next cumulative revision
1. Implement managed department membership changes with transactional primary/secondary reconciliation.
2. Add authorized channel policy APIs and audit events; validate manager privileges and prevent broad grants without confirmation.
3. Integrate access evaluation across HTTP, file, search, socket, and mention paths and write integration tests for bans and expiration.
4. Add UI for Access/Members/Restrictions separate from action Permissions; preserve existing legacy memberships and test migration impact.
5. Run full suite and stage real database migration, then approve release.

## Apply carefully
- This patch supersedes Patch 04 and contains all previous changed files. Extract at project root preserving paths.
- Back up database before running migrations. Prefer a disposable PostgreSQL database for first startup.
- In `backend`, run `npm test` and review any failures. Do not treat these focused test results as production verification.

---

### Patch 06

# IT Avenue Workspace — Cumulative Patch 06 — Phase 2B Policy APIs

## Provenance
- Original source: user-uploaded it-ave-workspace-main.zip.
- Cumulative prior changes: patches 01–05 (Patch 05 ZIP used as source list).
- Package: changed/new files only, never the full project.
- No ChatGPT Work; no repository/database/deployment modifications.

## Implemented in Patch 06
- Added authenticated endpoints to manage department grants, direct invitations with optional expiration, channel bans/unbans, and multi-department user membership.
- Enforced management authority checks for channel mutations and `manage_people` for employee department assignments.
- Mutations use transactions and workspace audit log records.
- Checks valid active employee recipients, valid departments, input bounds and explicit full-history/access change acknowledgment.
- Enforces that an existing channel moderator cannot be banned before their management assignment is removed.
- Preserves `users.department_id` as the primary department for legacy compatibility.
- Added focused policy input validation tests.

## IMPORTANT: NOT YET READY FOR DEPLOYMENT
- APIs manipulate Phase 2 policy tables, but are **NOT YET enforcement-backed** across channel reads, downloads, search, Socket.IO, or notifications. The API replies `enforced: false` to make this explicit.
- DO NOT use ban endpoints expecting to block real-world access at this stage. Keep behind development/staging only.
- Manager checks currently respect legacy creator, `manage_channels`, or moderator authority; replacement with equal-manager design still pending.
- Expiry relies on runtime evaluation in the foundation, but that evaluation is NOT yet wired into all routes.
- Replacing department grants in a transaction has no impact-preview counts; confirmation acknowledgement is required but a server-calculated preview is still pending.
- Electron UI still pending. Existing `channel_overrides` department action permissions remain live.
- Full backend suite and real PostgreSQL integration not run here. User-reported Patch 05: 386/386 tests passed.

## Verification this session
- Node syntax checks: backend/src/routes/channelAccessPolicies.js, backend/server.js — PASS.
- `node --test backend/test/channel-access-phase2.test.js backend/test/channel-policy-validation.test.js`: 12/12 PASS.

## Next revision (Patch 07)
1. Add transactional impact preview and channel manager succession constraints.
2. Integrate unified effective-access checks throughout channel HTTP, file, search, Socket.IO, and mention paths; ensure bans immediately invalidate live subscriptions and caches.
3. Phase out department action-permission overrides safely, preserving existing permissions until explicit migrated equivalent is validated.
4. Integrate Electron management UI and complete integration tests on staged database.

## Apply / test
Apply at project root, preserving file paths. Cumulative, so no need to apply earlier patches separately.
Do not deploy this incomplete policy feature to production. On a disposable/staging database, backup first and run migrations, then `cd backend && npm test`.

---

### Patch 07

# IT Avenue Workspace — Cumulative Patch 07 — Phase 2C Partial Enforcement

## Scope and baseline
- Source: user-provided `it-ave-workspace-main.zip` plus all changed files from cumulative patches 01–06.
- Delivery: changed/new files only, cumulative (patches 01–07).
- No ChatGPT Work, no deployment or database mutation.

## Implemented in Patch 07
- Central `ensureChannelMembership` now denies access for inactive accounts and banned users, including legacy channel members and owners (explicit channel ban precedence).
- Central membership check accepts either a department grant through `user_departments` (primary and additional) or a direct grant that has not expired; legacy membership methods remain for backward compatibility.
- Both channel directory endpoints incorporate department/direct grants and ban suppression.
- On ban, API attempts to evict the targeted authenticated or View-as socket from the relevant channel room and emits `channel_access_revoked`.
- Basic channel activity notifications exclude banned users.
- Three source-level regression assertions added.

## Verification
- Node syntax checked for modified source files.
- `node --test backend/test/channel-access-phase2.test.js backend/test/channel-policy-validation.test.js backend/test/channel-access-enforcement-source.test.js`: 15/15 passed.
- Full backend suite NOT run; integration tests require user setup and PostgreSQL.

## Known gaps / DO NOT DEPLOY as complete Phase 2C
1. Existing Socket.IO subscriptions can remain after department removal or invitation expiration until explicitly revalidated; these must be evicted or filtered at emission.
2. Several socket event paths and file/search/canvas/mentions codepaths require independent verification for use of the central access check. Room broadcasts must not leak to stale subscribers.
3. Permission service `can()` retains old department action-permission overrides; the future access/permissions separation is not implemented.
4. Channel directory results still use legacy `viewableChannels` checks; new-grant permissions and owner exceptions need end-to-end review.
5. Policy-management endpoints still return `enforced: false` because comprehensive enforcement is incomplete.
6. Individual grants are not synchronized into `channel_members` and user cannot rely on all user-interface member counts/unread indicators.
7. No impact preview, effective-membership management UI, or manager succession implementation yet.
8. Test doubles for existing SQL queries may require adjustments; DO NOT loosen access checks to satisfy fixtures.

## Next steps
- Full PostgreSQL-backed test suite and SQL query validation.
- Authorize every socket emission/notification path, enforce revocation immediately for department changes and expired grants.
- Integrate file, canvas, search, and role/department mentions with consistent effective authorization.
- Build authoritative access preview, succession guards, and Electron UI.

## Local test commands
From the project backend directory: `npm test`.
Use a database backup and staging instance before applying migrations. Do not deploy Patch 07 to production.

---

### Patch 08

# IT Avenue Workspace — Cumulative Patch 08 — Socket Access Reconciliation

## Baseline and scope
- Original complete code: user-uploaded `it-ave-workspace-main.zip`.
- Includes cumulative modified files from Patches 01–07, plus Patch 08 modifications. No full project files.
- No ChatGPT Work. No production deployment or production database changes.

## Patch 08 changes
1. Added `backend/src/channelRoomReconcile.js`: rechecks every socket in a channel room with the existing central `ensureChannelMembership` authorization, evicting clients with revoked, banned, expired or unknown access; authorization lookup failures fail closed.
2. Channel-policy updates (department grant replacement, invitations, invitation removal, bans and unbans) revalidate connected subscribers following the transaction. Department membership edits collect affected user's joined channel rooms and revalidate them.
3. Before new-message and typing broadcasts from the main socket handler, stale channel-room subscribers are evicted. This covers invitation expiry without waiting for a separate mutation, on these two event paths.
4. Added 3 focused tests for room reconciliation, missing identity, and authorization query failure.

## Testing
- 18/18 focused tests passed locally: channel-room-reconcile, channel-access-phase2, channel-policy-validation, channel-access-enforcement-source.
- Node syntax checks passed for touched JS files.
- Full PostgreSQL-backed suite not run locally. User last confirmed 393/393 on Patch 07, **not Patch 08**.

## Known limitations — Phase 2C remains incomplete
- Other channel-room broadcasts in other modules must be audited and guarded; the helper is integrated into the main `new_message` and `user_typing` paths only.
- Reconciliation triggered by a route mutation may fail if the Socket.IO adapter is unavailable; the route logs the error, so websocket revocation is not a guaranteed instant notification. HTTP still checks access.
- Expiration without an event does not proactively trigger eviction; the next guarded broadcast/authorized operation does.
- Recipients of `channel_activity`, reply and role/department mention notifications still need full effective-access filtering, especially non-legacy department/direct grantees.
- Additional file, search, canvas and alternate socket path audits are required. Do not call Phase 2C production-ready.
- `enforced: false` API status intentionally remains until comprehensive enforcement is complete.
- Existing department *action* overrides are intentionally unchanged pending Phase 3 separation.

## Next steps
1. Full `npm test` in user's PostgreSQL-enabled environment and report failures; inspect mocks if they rely on exact query shapes.
2. Audit all `io.to(channel_*)`, room joins, read APIs, notifications, download endpoints and search endpoints.
3. Add integration tests for active connected sockets and grant expiry, and eliminate stale subscriptions across all events.
4. Finish UI and permission separation in later phases.

## Apply
Extract the cumulative ZIP over the original project root, preserving paths. Back up the DB and test only on staging. Run `cd backend; npm test`.

---

### Patch 09

# IT Avenue Workspace — Cumulative Patch 09

## Latest test result
Patch 08 user-run full suite: 396 tests, 395 passed, 1 failed.

## Patch 09 change
Updated `backend/test/message-replies.test.js` fake Socket.IO adapter to support `in(room).fetchSockets()`, room join/leave tracking and the current central authorization query. The Patch 08 production reconciliation and enforcement code remains unchanged. This resolves the observed unsupported adapter exception in the message-reply broadcast test while preserving fail-closed access behavior.

## Verification
- `node --check backend/test/message-replies.test.js`: passed locally.
- ZIP manifest and members: checked.
- Full test suite: **not run in this environment** because backend dependencies are not installed. User should run `npm test` and confirm.

## Development roadmap
- Phase 1 HR conversion: user-verified at Patch 04.
- Phase 2A/2B foundations and policy APIs: user-verified at Patch 06.
- Phase 2C access enforcement: **partial, in progress**. Socket reconciliation only covers selected paths.
- Phase 2D Electron access policy UI: pending.
- Phase 3 channel access vs permission separation: pending.

## Remaining security gaps
Audit all alternative Socket.IO broadcasts, notifications/mentions, search, attachments, canvases and proactive expiration eviction. Do not deploy Phase 2C to production until these are resolved and integration tested.

## Apply and test
Extract this cumulative changed-files-only ZIP over your development repository root. It contains all modified source files from Patches 01–09. Then run from `backend`: `npm test 2>&1 | Tee-Object -FilePath ..\patch09-test-results.txt`. No database or GitHub changes were performed here.

---

### Patch 10

# IT Avenue Workspace — Cumulative Patch 10

## Baseline
Original uploaded full-project ZIP + cumulative changes Patches 01–09. The user reports 396/396 tests passing for Patch 09. This patch includes ALL previous changed/new files, not the full repository.

## Implemented
- Search now applies a consistent authorization gate to channel message results and channel-linked file results.
- Bans override legacy channel membership, Owner status, department grants and direct invitations.
- Multi-department channel grants and unexpired direct invitations are included.
- Inactive accounts are excluded from channel content search.
- Legacy channel overrides and membership retained to avoid breaking existing visibility during migration.
- Added source-level assertions in backend/test/search.test.js to guard both queries.

## Verification
- JavaScript syntax checks passed for modified files.
- Full npm test suite NOT run here: backend dependencies are not installed in execution environment.
- Production access/security integration NOT yet verified. Phase 2C remains in progress.

## Limitations / upcoming
- Search SQL still does not evaluate channel-level view_channel role overrides (`needsCheckSql` + `can`); audit parity with security.js.
- Audit remaining file, canvas, mention, notification and background socket paths.
- Proactive expiration revocation needs scheduling.
- Phase 2D Electron UI is pending.

## Test locally
From project root extract this ZIP (overwrite modified files), then:

```powershell
cd D:\Development\itavenue-workspace\backend
npm test 2>&1 | Tee-Object -FilePath ..\patch10-test-results.txt
```

Do not deploy to production until full test and staging access audit.

---

### Patch 11

# IT Avenue Workspace — Patch 11: Channel File Listing Access

## Baseline
Cumulative Patch 10, whose complete backend automated suite was reported by the user as **396 passed, 0 failed**.

## Implemented
- Extracted the Patch 10 channel visibility SQL into `backend/src/channelVisibilitySql.js` for reuse.
- Made message search and file-name search use the shared SQL without changing their conditions.
- Hardened `GET /api/files` file-library listing: channel file metadata is visible only when the shared channel visibility policy permits the user. This prevents channel bans and expired direct grants from leaving attachment filenames exposed in the Files listing through old membership checks. Active primary and secondary department grants remain supported; unlinked own files and DM attachments retain their prior visibility rules.
- Added three focused source/predicate regression tests.

## Verification
- `node --test backend/test/channel-content-visibility.test.js`: 3 passed, 0 failed.
- `node --check` on the new and edited JavaScript files: passed.
- Full backend test suite: **not run in this environment**; the user should run it.

## Known limitations / work remaining
- Channel-level role/permission overrides are not yet applied uniformly in all content listing queries; this patch retains Patch 10 semantics.
- Remaining Phase 2C security audit: channel canvases shared to other channels, notification/mention eligibility, time-based socket eviction, and complete API/socket test coverage.
- Do not deploy as a fully verified security release; stage and test before production migration.

## Roadmap
- Phase 1: HR role migration — user-verified automated suite.
- Phase 2A/2B: multiple departments and policy APIs — user-verified automated suite.
- Phase 2C: enforcement — in progress, file-library visibility improved in this patch.
- Phase 2D: Electron UI — pending.
- Phase 3: separating channel access and action permissions — pending.

## Apply and test
Extract this cumulative patch at the IT Avenue Workspace repository root, preserving paths. It includes all project-file changes from Patches 01–11 relative to the original repository baseline.

```powershell
cd D:\Development\itavenue-workspace\backend
npm test 2>&1 | Tee-Object -FilePath ..\patch11-test-results.txt
```

---

### Patch 12

# IT Avenue Workspace — Patch 12 (Phase 2C)

## Baseline
Patch 11: 399/399 backend tests passed on user's Windows environment. This patch is cumulative from original project and includes patches 01–12.

## Changes
- Shared standalone canvases now evaluate **current** authorization for each channel that grants access, rather than trusting `channel_members`. Ban, expiration, deactivation, and per-channel access policy checks inherit the central guard. Ownership and explicit personal canvas collaboration remain independent.
- Channel-activity personal-room notifications, user/role/department mention activity, and reply notifications revalidate channel membership at delivery time. Query failures fail closed.
- Two source-level guard tests assert these security checkpoints.

## Verification / limitations
- Run full `npm test` on the user's Windows environment; runtime dependencies for the full suite are not installed here.
- Source guards do not substitute for integration tests; The standalone-canvas test fixture has been updated for the new grant enumeration. Full database-backed and notification integration tests still need to be run.
- Remaining: recipient enumeration for direct/department grants (currently legacy enumeration); channel-shared canvas listings; automatic expiration timer; Socket.IO other broadcast audit; permission parity across search/list SQL; Phase 2D UI.
- Not production-ready. Back up DB before migrations; review staging access tests.

## Apply
Extract cumulative ZIP at repo root, keeping paths; run `cd backend; npm test`.

---

### Patch 13

# IT Avenue Workspace — Patch 13 progress

Baseline: cumulative Patch 12; user reported **401/401** tests passing.

## Implemented
- Fixed `/api/canvas/standalone` discovery for canvases shared through channels: SQL candidate selection now reuses `channelVisibleToUser`, covering secondary departments, direct unexpired grants, bans, deactivation, and old membership.
- Preserved canvas ownership and direct collaborator access regardless of channel grant revocation.
- Preserved the second-stage `getStandaloneCanvasRole` runtime authorization gate, which independently checks current effective channel membership and channel permission overrides before returning canvas content.
- Added two focused regression tests for policy features and independent personal access.

## Verification
- Syntax and focused Node tests are run locally in this environment.
- Full backend suite requires user rerun; no production migration or deployed security claim.

## Roadmap
- Phase 2C in progress. Next: expand channel activity recipient discovery to department/direct grants; proactively reconcile expiring socket invitations; audit remaining permission-override equivalence and socket emission paths; cover changes with runtime integration tests.
- Phase 2D Electron UI pending; Phase 3 permission UI separation pending.

## Deploy/test
Unzip at repo root in development. From `backend`, run `npm test 2>&1 | Tee-Object -FilePath ..\patch13-test-results.txt`. Do not deploy to production without staging verification.

---

### Patch 14

# IT Avenue Workspace — Patch 14 (Phase 2C completion candidate)

Baseline: Patch 13 (user verified 403/403 backend tests).

## Implemented
- Grant-aware channel notification recipient discovery for legacy memberships, secondary departments, valid direct invitations and existing department overrides. Explicit bans and inactive users excluded.
- @user, @department, and @role mentions limited to discovered channel-access candidates and checked again against central authorization before delivery.
- One periodic expiry sweep per Socket.IO server; expired direct grants trigger room reconciliation without channel activity. Timer unref'ed to support clean test shutdown.
- Kept existing API enforcement flag unchanged until full security and staging review.
- New targeted regression assertions.

## Verification and limitations
- Focused source tests and JavaScript syntax can run here, but the full suite and staging security tests need the user's environment.
- A security audit must still evaluate shared huddles, other route-specific direct SQL checks, race conditions and channel role overrides. Do not treat as production verified without live staging tests.
- Periodic sweep has bounded delay (default 30 seconds), not exact real-time revocation. Some clients may need to re-join on the next authorization attempt.

## Roadmap
- Phase 2C: implementation candidate; pending full suite, staging security audit and any follow-up repairs.
- Phase 2D: Electron UI pending.
- Phase 3: access/permission separation pending.

## Test
Extract cumulative ZIP to repository root. Run: `cd backend; npm test` and send output. Do not deploy to production before verification.

---

### Patch 15

# IT Avenue Workspace — Patch 15 Regression Repair

Baseline: Cumulative Patch 14 (user executed 406 tests; 404 passed, 2 failed).

## Repairs
1. Fixed SQL syntax in `backend/src/sockets/chat.js`: closed recipient grant-alternatives parenthesis before `AND NOT EXISTS` for channel bans. Previous malformed PostgreSQL query raised `42601` and prevented role mention notifications.
2. Updated `backend/test/phase2c-notification-canvas-source.test.js` to validate `recipient.id` (the actual returned SQL field) instead of stale `recipient.user_id`.
3. Added source regression test for the grant group closing before the ban clause.

No authorization bypass or permission relaxation was introduced. Active access is still independently rechecked at notification delivery.

## Verification
- `node --check` on both changed files: PASSED.
- `node --test test/phase2c-notification-canvas-source.test.js`: 3/3 passed.
- Complete backend suite: NOT run here (user's environment needed). Expected test count after adding one test: 407, but not a guarantee.
- Database/staging security verification: NOT complete.

## Roadmap
- Phase 2C: implementation candidate repaired, still pending complete backend suite, staging authorization audit and role-override/huddle reviews.
- Phase 2D: Electron UI pending.
- Phase 3: separate Channel Access and Permissions pending.

## Apply and test
Extract this *cumulative* patch onto repository root, overwriting existing files. It already includes all modifications from patches 01–15. Back up project and database before deployment; do not deploy to production on the strength of this patch alone.

```powershell
cd D:\Development\itavenue-workspace\backend
npm test 2>&1 | Tee-Object -FilePath ..\patch15-test-results.txt
```

---

### Patch 16

# IT Avenue Workspace — Cumulative Patch 16: Phase 2D Electron UI

## Implementation
- New **Access** tab in channel moderation, distinct from **Permissions**.
- Department grant checkbox editor and explicit history-exposure confirmation.
- Direct invitations (permanent or expiring), revocation, bans with required reasons, unbans.
- Employee editor supports multiple departments and primary selection with impact confirmation.
- Uses existing Phase 2B backend APIs and shows server-side errors.
- Client-side restrictions are convenience only; backend remains authoritative.

## Verification
- Patch 15: user verified 407/407 backend tests.
- Patch 16: JavaScript syntax checks; new frontend source-level integration assertions.
- Full npm test on Patch 16: user verification pending.
- Actual Electron UI/staging authorization manual tests pending.

## Roadmap
- Phase 1 and 2A–2C: prior implementation complete; Phase 2C staging security audit still pending.
- Phase 2D: UI implementation assembled, full suite and manual Electron verification pending.
- Phase 3: Channel Access vs Permissions architecture and deeper authorization reconciliation pending.

## Apply
Extract cumulative patch ZIP at project root preserving relative paths. It already contains changes from Patches 01–16. Run `cd backend; npm test`. Restart the Electron source client to pick up frontend changes; installed packaged client needs rebuild. Back up database before migration/restart.

---

### Patch 17

# IT Avenue Workspace — Patch 17: Scoped channel moderator access guard

## Change
- Channel moderator capability checks now first require effective channel content access.
- This closes a path where an Owner, channel moderator, or manage_messages role could otherwise reach moderator-only channel operations despite a channel ban or revoked grant.
- Explicitly retains normal channel moderator permissions for authorized members.
- Adds two focused runtime tests; backend production permissions logic beyond this guard remains unchanged.

## Caveat / boundary
- The gate affects routes using `ensureChannelModerator`, including webhook and moderation paths. Test these workflows manually in a staging database, especially Owner metadata-recovery behavior. This does not implement the full Phase 3 separation or manager recovery path.
- Phase 2D Electron screens still require hands-on UI testing.

## Verification
- Patch 16: user verified 409/409 backend tests.
- Patch 17: focused runtime tests, syntax and ZIP integrity checked locally.
- Full Patch 17 backend suite has not run here; user verification required.

## Roadmap
- Phase 2D: implementation and existing full suite passed; manual UI checks pending.
- Phase 3: access-vs-capability enforcement started; audit all moderator/admin endpoints, design metadata-only recovery separate from channel-content authorization, then migrate department action overrides with compatibility plan.

## Apply / test
Extract this cumulative changed-files-only ZIP over the project root. Back up your development database before restarting. Run:

```powershell
cd D:\Development\itavenue-workspace\backend
npm test 2>&1 | Tee-Object -FilePath ..\patch17-test-results.txt
```

---

### Patch 18

# IT Avenue Workspace — Cumulative Patch 18

## Baseline
Patch 17: 411/411 full backend tests passed on user's machine.

## Implemented
- Repair empty Moderation → People and Groups → Groups by adding a Superadmin-only group metadata inventory endpoint and rendering panel. No private group messages are exposed.
- Project creator-defined ordinary channel sections into other viewers' sidebars. Inherited channel IDs are checked against current backend channel authorization and also resolved against each viewer's authorized `state.channels`; personal and team channels are excluded. Existing workspace sections remain authoritative.
- Preserve individual sidebar preferences and legacy moderation authorization.

## Limits and follow-up
- Owner-defined section names are shared as channel organization metadata, not personal-only preferences; this is the requested behavior for ordinary channels.
- Multiple creators' sections with the same name remain distinct; shared workspace sections take priority.
- Live UI verification and the full backend suite need to be run on user's machine. Full Phase 3 access/permission separation remains outstanding.

## Deployment/testing
Extract this patch ZIP at repository root (all earlier patches included). Run `cd backend; npm test`. Restart frontend from source to test the UI. Keep production unchanged until manual verification.

---

### Patch 19

# IT Avenue Workspace — Cumulative Patch 19: Core Phase 3 Access/Actions Boundary

## Baseline
Patch 18 passed 413/413 tests on the user's machine. Patch 19 contains all changes since Patch 01 and remains patch-only.

## Implemented
- Enforce current channel membership before evaluating action permissions in `ensureChannelPermission`, including when Everyone ordinarily has the action. A role never substitutes for channel-content access.
- Add a read-only department-override audit helper splitting `view_channel` rules from action grants/denials, flagging the latter for deliberate migration. No existing department override is deleted or changed.
- Four targeted regression tests for the boundary and migration assessment.

## Key limitation / honest status
This is NOT yet a completed Phase 3 migration. Existing department action overrides are still interpreted by the permission resolver and channel creation still writes legacy department action overrides. Migrating them requires preserving current effective permissions, design decisions on role assignments, and end-to-end verification. The new channel membership check may require updates to test fixtures and may reveal callers relying on missing access checks. Do not deploy until the full suite and staging access tests pass.

## Tests
Focused tests: run `node --test backend/test/phase3-core-separation.test.js` from repository root.
Full: `cd backend; npm test`.

## Outstanding
- Migrate historical department action overrides to explicit role/user overrides with a reviewable dry-run and rollback procedure.
- Stop writing action overrides on department-channel creation without changing intended behavior.
- Apply a single entry-vs-action policy to remaining channel endpoints, huddles, notifications, and admin recovery.
- Manual Electron checks for Groups/Sections/Channel Access.

---

### Patch 20

# IT Avenue Workspace — Patch 20: Phase 3 Department Policy Transition

## Baseline
Patch 19: 417/417 backend tests passed on the user's Windows environment.

## Implemented
- New department channels use `channel_department_grants` to control entry, and no longer insert new department-based action overrides.
- Keep ordinary role/Everyone action permissions; the channel creator remains a moderator via explicit channel membership.
- Read-only historical migration planner classifies access-only rules and identifies action grants, action denies, and access-deny blockers.
- Five focused tests validate the boundary, blockers and read-only planning.

## Migration safety
**Existing department-based action overrides remain active for compatibility.** They cannot be transparently replaced by a snapshot of per-user overrides without changing behavior when employees move departments, change roles, or access changes. The safe plan is to review a policy mapping to actual roles or channel-specific individual overrides before disabling them. The planner does not mutate any existing rows.

## Status
Core Phase 3 is materially advanced but not complete. Automated test suite still requires a full run on user's machine; live migration parity and explicit mapping of historical action rules remain outstanding. Do not deploy to production solely from the focused checks.

## Testing
From repository root: `node --test backend/test/phase3-department-transition.test.js`
Complete suite: `cd backend; npm test`

## Next
1. Review planner output on a staging copy with real data. Decide explicit role/user mappings for blocked rules.
2. Stage transactional conversion, compare effective per-user permissions before/after, with rollback.
3. Run manual Electron and private-channel security tests before production release.

---

## Verification and deployment checklist

1. Back up the database and uploads before applying any schema or policy migrations.
2. Apply this cumulative changed-files ZIP over the original approved source baseline.
3. From `backend`, run `npm test` and inspect any failures before deploying.
4. Test the Electron UI, channels, bans, Sections, Groups, huddles, attachments, mentions, and sockets in staging.
5. Inventory legacy department overrides with the read-only planner; do not run opt-in conversion until approved and tested on a staging copy.
6. Manual conversion of action overrides remains blocked pending explicit permission mapping and parity verification.
7. No production deployment or full backend suite is claimed for Patch 21.


## Patch 22 — Guarded dry-run migration (new)
- Migrating access-only department overrides now defaults to dryRun=true, regardless of approval flag.
- A real commit requires BOTH dryRun:false and approved:true; dry runs always ROLLBACK.
- Transaction uses SERIALIZABLE isolation for a consistent concurrency-sensitive snapshot; serialization failures are surfaced and not retried automatically.
- All changes are opt-in through the internal migration API. Nothing runs on startup.
- Department action overrides, access denies and contradictory overrides remain blocked.
- Parity verification covers current active users only. Future department changes and unreviewed legacy rules need staging review.
- Added four tests for dry run, approval, unsafe rule and argument validation.

### Verification
- Last user-verified complete baseline: Patch 20, 422/422. The 422-test result shared after Patch 21 is not evidence that Patch 21 was applied; Patch 21 expected 427.
- Patch 22 focused migration tests run locally: 9/9 passed. Syntax and ZIP integrity checked.
- Full cumulative backend suite for Patch 22 has not been run here; user should run it locally. Expected 431 tests if Patch 21 files and 4 new tests are present.

### Deployment / operator safety
1. Extract the cumulative ZIP into the original approved repository; verify backend/test/phase3-department-migration-execution.test.js exists.
2. Run `cd backend; npm test`.
3. Back up PostgreSQL and uploads; test on a staging copy and review all legacy override mappings.
4. Preview an eligible conversion with dryRun default using a dedicated pg client; do not commit production changes without explicit approval and review.
5. A real conversion is explicit: `migrateAccessOnlyDepartmentOverride(client, { channelId, departmentId, dryRun: false, approved: true })`. Do not run this without backup and staging parity.
6. Run manual UI, channel access, huddle, Files, canvas, role override and socket security checks before production.


## Patch 23 — Core Phase 3 simplified for test workspace
- With the user's clarification that accounts are test users, completed the behavioral cutover: department overrides affect `view_channel` only, never send_messages, moderation, or other action permissions.
- Existing department visibility override rows are retained for compatibility, and new department action override writes are rejected with HTTP 400.
- Legacy department action allow/deny arrays are intentionally ignored at runtime; staff now receive action permissions through Everyone, roles, and individual overrides only. No users are deleted, converted, or silently granted Employee roles; testing accounts remain intact.
- Updated existing channel permission integration test and added four regression tests for ignored action overrides, preserved visibility, consistent permission explanations, and API guard.
- This change intentionally alters effective action permissions if a test account previously depended on a department action override. Do not apply to an unrelated production database.
- Previous migration tools remain opt-in and are not automatically invoked.

### Verification
- Last user-confirmed full suite: Patch 22, 431/431 tests passed.
- Patch 23 focused tests: 4/4 passed. Syntax checks passed. Full test suite must be run by user. Expected approximately 435 tests.
- Staging manual checks and Electron client verification remain outstanding.

### Install and test
1. Back up your test database if any data matters. Extract this cumulative patch to your development project root.
2. Run `cd backend; npm test`.
3. Check channel permissions: a department grants visibility, but cannot grant/deny posting; roles and individual overrides still work.
4. Verify the Groups and shared Section features in the Electron client.


## Phase 4 — Cumulative Patch 29–31 candidate (2026-11-14)

Implemented: moderator roster listing and replacement with single active-manager minimum and audit; reversible channel archive/restore; posting blocked for archived channels; permanent deletion restricted to archived shared channels with explicit confirmation and manage_channels. Original project data untouched.

**Remaining:** manual Electron UI for managers/archive/recovery; database-backed integration tests; broad moderation/delete regression updates; permission-path audit for non-message writes. This is NOT a completed or release-ready Phase 4.

Testing: focused structural checks only; full suite must be run by user.

Further in this Phase 4 candidate: Electron Channel Access tab now offers manager roster edits, archive, restore, and permanent delete. Promoting a manager requires existing channel membership, preventing an implicit access grant. Still requires integration and complete-suite testing.


## Patch 31 — Phase 4 hardening (2026-11-14)
- Channel managers may replace the manager roster and archive/restore shared channels independently of workspace-wide `manage_channels`, provided they retain actual authorized channel membership. Workspace `manage_channels` remains a metadata-level administrative path; this does not grant content visibility.
- Added `POST /api/moderation/channels/:channelId/recover-manager` for workspace-authorized administrative recovery only when no active, unbanned manager remains. Explicit `RECOVER CHANNEL MANAGER` confirmation; replacement must already be a legitimate, active, unbanned member with valid channel access. Changes audited. Recovery grants no new membership or channel access.
- Added reusable `ensureChannelNotArchived` and enforced it on channel canvas HTTP mutations (including comments and channel images), and channel-attached file deletion. Channel message posting restriction already introduced in Patch 29 remains.
- Expanded focused structural checks from 6 to 9 (9/9 passed in sandbox). JS syntax checks passed.

**Not claimed complete:** Full backend suite must run in the user's PostgreSQL-backed environment; live Electron workflows and all possible write paths (notably lists, socket-based interactions, and other upload paths) still require coverage/security audit. Phase 4 remains NOT fully verified or release-ready.

### Apply/test Patch 31
Unzip over existing working tree, from project root, preserving paths. Run:
```powershell
cd D:\Development\itavenue-workspace\backend
npm test 2>&1 | Tee-Object -FilePath ..\patch31-test-results.txt
```
Restart backend/Electron. Test channel manager roster, archive/restore, recovery using test accounts, plus archive mutation denial. No migrations newly added by Patch 31; earlier cumulative migrations remain included.


## Patch 31 — Phase 4 hardening (2026-11-14)
- Channel managers may replace the manager roster and archive/restore shared channels independently of workspace-wide `manage_channels`, provided they retain actual authorized channel membership. Workspace `manage_channels` remains a metadata-level administrative path; this does not grant content visibility.
- Added `POST /api/moderation/channels/:channelId/recover-manager` for workspace-authorized administrative recovery only when no active, unbanned manager remains. Explicit `RECOVER CHANNEL MANAGER` confirmation; replacement must already be a legitimate, active, unbanned member with valid channel access. Changes audited. Recovery grants no new membership or channel access.
- Added reusable `ensureChannelNotArchived` and enforced it on channel canvas HTTP mutations (including comments and channel images), and channel-attached file deletion. Channel message posting restriction already introduced in Patch 29 remains.
- Expanded focused structural checks from 6 to 9 (9/9 passed in sandbox). JS syntax checks passed.

**Not claimed complete:** Full backend suite must run in the user's PostgreSQL-backed environment; live Electron workflows and all possible write paths (notably lists, socket-based interactions, and other upload paths) still require coverage/security audit. Phase 4 remains NOT fully verified or release-ready.

### Apply/test Patch 31
Unzip over existing working tree, from project root, preserving paths. Run:
```powershell
cd D:\Development\itavenue-workspace\backend
npm test 2>&1 | Tee-Object -FilePath ..\patch31-test-results.txt
```
Restart backend/Electron. Test channel manager roster, archive/restore, recovery using test accounts, plus archive mutation denial. No migrations newly added by Patch 31; earlier cumulative migrations remain included.


## Patch 32 — Phase 4 regression fixture repair (2026-11-14)
User's complete Patch 31 suite: **458 tests / 453 passed / 5 failed**. Three file-deletion tests rejected the new archive-state SQL in a mocked transaction; two canvas tests returned HTTP 500 after the new canvas archive-state lookup was introduced. The log establishes these as fixture/guard interaction regressions, not a verified production bug.

This repair extends the existing in-memory SQL fixtures in `backend/test/files.test.js` and `backend/test/canvas.test.js`: active channels return `archived_at: null`, and canvas ID lookups resolve to stored canvas channel IDs. The production archive guard remains unchanged.

**Testing:** syntax checks performed in sandbox. Full backend suite requires the user's dependencies and PostgreSQL-backed setup. Do not mark Phase 4 release-ready on this repair alone.

To test: extract cumulative changes over your development repository and run `cd D:\Development\itavenue-workspace\backend; npm test`. Expected count: 458.


## Patch 34 — Selective Phase 5 primary-department synchronization
- Base: verified cumulative Patch 33 (461/461 backend tests reported by user).
- Reviewed incoming `phase5-code-changes.zip`; **did not** merge it wholesale.
- Kept: creation-time primary department membership, cautious legacy backfill.
- Reimplemented: HR primary department change with transaction/rollback and secondary membership preservation.
- Clearing primary converts primary membership to secondary; access remains intact until separately revoked.
- Added two source-level safety tests; backend integration test on user environment remains required.
- No unrelated changes to Phases 1–4.


## Patch 35 — Cumulative Socket Security File Restoration (2026-11-15)
- Patch 34 test run: 463 total, 458 passed, 5 failed, 0 skipped.
- All five failures stem from an omitted cumulative file `backend/src/sockets/chat.js`: Patches 33 and 34 omitted this file, despite earlier cumulative packages including it. Old locally installed socket handler remained in the working tree.
- Restored the *exact* Socket.IO handler from verified cumulative Patch 32 (no additional socket behavior changes). This handler includes channel activity candidate discovery, access revalidation, mention notification filters, and expiration sweeper setup.
- Retains the original Patch 34 department-sync changes intact.
- Verification: ZIP integrity and syntax check. Full backend regression suite must run in Windows environment; target 463 passed, 0 failures, 0 skipped.
- Apply cumulative ZIP over original source or existing repository, replacing files by relative path. If there are local modifications, review before overwriting.
- Run `cd D:\Development\itavenue-workspace\backend; npm test 2>&1 | Tee-Object -FilePath ..\patch35-test-results.txt`.
