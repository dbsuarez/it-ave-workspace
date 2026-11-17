# Phase 5 verification results (API level)

**Run:** 2026-11-17, against the development stack on commit `d2a4f48` (backend 463/463 automated tests passing).
**Method:** each test in `IT_AVE_PHASE5_STEP_BY_STEP_VERIFICATION.md` was driven through the real HTTP API and Socket.IO
using the existing `p5*` fixture accounts (SA = `admin`, LEAD = `p5lead`, A = `p5a`, B = `p5b`, C = `p5c`, D = `p5d`,
G = `p5g`) plus two throwaway accounts that were deleted afterwards. All test channels were named `p5run-*` and were
removed through the app's own archive-then-delete workflow; the database ended with the same user, channel and message
counts it started with. A pre-test backup is in `backups/phase5-pre-*.dump` (git-ignored).

**What this does not cover:** the Electron UI itself (labels, buttons, what the user actually sees) and P5-RELEASE-01
(final smoke test and sign-off), which need a person.

## Results

| Test | Result | Notes |
|---|---|---|
| P5-ACCESS-01 Department visibility | PASS | A and B (grandchild) open the channel; C gets 403 on channel, history and list. Department grants give no management rights (policy edit and archive both 403). |
| P5-ACCESS-02 Invitation and expiry | PASS | Access works while valid, stops on expiry (fetch, history, live messages); revoke removes it. |
| P5-ACCESS-03 Ban overrides all paths | PASS | With department + direct grant and two live sessions, a ban stops fetch, history, list entry, posting and live delivery on both sessions; unban restores. |
| P5-SECTIONS-01 Nested team section | PASS | LEAD, A, B see the channel inside the section and not floating; C sees nothing and cannot open it. |
| P5-SECTIONS-02 SA / personal sidebar | PASS | A's personal section is not visible to B, SA or LEAD. See observation 1 about SA content access. |
| P5-ROLES-01 Access is not permission | PASS | Per-person deny of `send_messages` stops B posting while B can still read; an explicit allow does not help once access is removed. |
| P5-MANAGER-01 Two equal managers | PASS | A and B both manage; B (not creator, not Superadmin) archives and A restores; audit names each actor. See observation 2. |
| P5-MANAGER-02 Promotion / last manager | PASS | C (no access) and banned D cannot be promoted and no membership is created; an empty roster is refused; banning the last manager returns 409; non-managers get 403. |
| P5-ARCHIVE-01 Archive is read-only | FAIL when run, **fixed afterwards** | Everything in the guide's table was blocked except the old **Wiki canvases** (finding 2) and the extra paths in finding 3. Both are fixed and unit tested; re-run this check after the backend is rebuilt. |
| P5-ARCHIVE-02 Restore and resume | PASS | Posting, reactions, pins, list and canvas edits resume; earlier content intact. |
| P5-RECOVERY-01 Last-manager recovery | PASS | Reproduced by deactivating the sole manager through the HR API. Recovery refused for a non-member, a banned user, a deactivated user, a non-admin actor and a missing confirmation; works for an existing member; audit names actor and target; the channel administrator (not a Superadmin) still cannot read the channel and is not added as a member. |
| P5-DELETE-01 Permanent deletion | PASS | Member denied (403); active channel refused (409); archived without the phrase or with a wrong phrase refused (409); exact phrase deletes; connected member notified; old links fail; audit entry written; other channels untouched. |
| P5-REALTIME-01 Live session revocation | PASS | After revocation neither of D's sessions receives message, canvas or list events; fetch, search and old file URL all denied; reconnect plus `join_channel` restores nothing. |
| P5-GUEST-01 Guest boundaries | PASS | G reads only the guest channel, gets 403 on the directory, group conversations, lists and canvas edits; search shows nothing private; G only sees people who share a channel. |
| P5-NOTIFY-01 Mentions and identity | PASS | Live and Activity-feed canvas notifications use the full name; an account with no name falls back to the username; a removed member receives no new mention or content. |
| P5-DATA-01 Migration repeatability | PASS | Database restored into a new database, a second backend started on it (migrations ran) and restarted (migrations ran again): row counts and content fingerprint unchanged, clean start log. |
| P5-DATA-02 Restore rehearsal | PASS | Backup of database and uploads restored into a separate database and uploads folder: messages, manager roster, archive state, lists, canvas and team sections identical through the API, and all 16 files download with byte-identical content. |
| P5-RELEASE-01 Final smoke test | NOT RUN | Needs a person in Electron. |

## Findings that need a decision or a fix

1. **FIXED (same day): deleting a team section permanently deleted its channels and their messages.** `channels.team_section_id` is
   `ON DELETE CASCADE` (`database/init.sql`, `backend/src/migrations.js`) and `DELETE /api/settings/sidebar/team/:id`
   removes the section directly. A team leader can therefore destroy channels and history in one call, bypassing the
   archive-first and exact-phrase protection that Phase 4 put on channel deletion. Fix: the route now refuses (409) to
   delete a section that still holds channels, the constraint is `ON DELETE SET NULL` in `init.sql` and in an idempotent
   migration that converts existing databases, and the confirmation dialog says so. Tests in
   `workspace-sidebar-sections.test.js`. The running Docker backend needs a rebuild to pick this up.
2. **FIXED (same day): Wiki canvases ignored the archive.** `PUT` and `DELETE /api/canvases/:id` succeed in an archived channel
   (`backend/src/routes/canvases.js` has no `ensureChannelNotArchived`; `routes/canvas.js` does). Comments and images on
   Wiki canvases were not exercised and probably have the same gap. Fix: create, edit and delete now return 409 in an
   archived channel (reading stays allowed); test in `canvases.test.js`.
3. **FIXED (same day): other write paths accepted in an archived channel** (not in the guide's table; the decision was to block all of them): editing and deleting your own message (`routes/messageEdits.js`), editing the channel topic
   (`PATCH /api/channels/:id`), adding a channel link, and creating a scheduled message (delivery is correctly refused
   later). Blocked correctly: new messages and replies, reactions, pins, lists and items, channel canvas and comments,
   file deletion, incoming webhooks, slash commands, moderator message deletion. Fix: editing or deleting your own
   message, the topic, adding or removing a link and creating a scheduled message now return 409 in an archived channel
   (`messageEdits.js`, `channels.js`, `channelLinks.js`, `scheduled.js`); test in
   `owner-private-access-and-archive-writes.test.js`.

## Observations (design points to confirm)

1. **CHANGED (same day): Superadmins no longer bypass private-channel access by default.** They used to read history,
   search and post in private channels they were not a member of (`is_superadmin` checks in `security.js` and several
   queries). That is now a workspace switch, **Owner access to private channels** (Moderation > Superadmin tab > Private channel access, Owner
   only, audited as `owner_private_access_on/off`), off by default. With it off an Owner needs a membership, department
   grant or invitation like anyone else, can no longer self-join a private channel, and does not get its search results,
   Activity, saved items or sidebar placement. Public channels, personal channels and channel administration (managers,
   archive, recovery, deletion) are unchanged. While the switch is off an Owner also cannot give themselves access through administration: adding themselves
   as a member, a direct invitation to themselves, or a grant (or view override) for a department they belong to are
   refused (403). A channel manager inviting the Owner is still allowed. Not covered: an Owner changing their own
   department membership in People management.
   See `backend/src/ownerChannelAccess.js`; tests in `owner-private-access-and-archive-writes.test.js`.
2. **Department-only readers cannot be promoted to manager** until they hold a channel membership row (409 "Assign a
   channel membership before promoting this employee"). Add them as members first.
3. Department visibility does not remove default posting rights: users who can read through a department can post
   unless a channel permission denies it (that denial works, see P5-ROLES-01).
4. The access-policy endpoints still answer `enforced: false` and the file header says enforcement is not complete,
   although enforcement is live. The wording is stale and misleading.
5. Starting a backend on a restored copy gives accounts inserted outside the app the default-channel memberships a
   normal sign-up creates. Expected, and unrelated to the restore itself.
