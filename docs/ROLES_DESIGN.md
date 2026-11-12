# Roles and channel overrides - design (proposal, nothing built yet)

Adapted from section 9 of `DISCORD_COMPLETE_FEATURES_AND_ARCHITECTURE.md` (roles, ranked order, permission bits,
channel overwrites, one central permission check). Scope chosen: **roles plus channel overrides**.

## What we have today

Access is decided in many places with different rules:

| Rule | Where |
| --- | --- |
| `users.is_superadmin` (bypasses almost everything) | security.js, channels.js, moderation.js, files.js |
| `users.is_hr` (people, leave, attendance) | hr.js |
| `channel_members.role` = member or moderator (per channel) | security.js, moderation.js, files.js |
| `users.account_type` = member, guest, bot | channels.js, sockets/chat.js |
| `is_private` channel + explicit membership | channels.js |
| Canvas roles viewer, commenter, editor, owner | canvas routes |

Problems: every new permission means another hard-coded check; you cannot say "Managers may delete messages
everywhere" or "only HR sees #hr-private" without code changes; a stale check in one route is a security hole.

## Target model

1. **Roles** (`roles`): name, color, rank (position; lower number = higher), permissions (a list of keys), built-in flag.
   Built-ins: **Owner** (the Superadmin, all permissions, cannot be edited or removed), **HR**, **Everyone** (the default
   every account has; its permissions are the baseline). Others are created in Moderation (e.g. Manager, Support).
2. **Assignments** (`user_roles`): a person holds any number of roles. Their permissions are the union of all their roles
   plus Everyone. `is_hr` and `is_superadmin` become the HR and Owner role assignments (columns kept in step during the
   move, then retired).
3. **Hierarchy**: you can only create, edit, assign or remove roles ranked below your highest role, and only grant
   permissions you hold. Nobody can touch a role at or above their own.
4. **Permission keys** (first set, kept small and meaningful for a company chat):
   `view_channel`, `send_messages`, `attach_files`, `add_reactions`, `mention_everyone`, `create_channels`,
   `manage_channels`, `manage_messages` (delete/pin others'), `timeout_members`, `manage_roles`, `manage_people`
   (HR: employees, leave, attendance), `view_audit_log`, `manage_workspace` (settings, integrations, slow mode).
5. **Channel overrides** (`channel_overrides`): for a channel, per role or per person, each key is allow, deny or inherit.
   Precedence, in order: Owner bypasses; then channel member-specific override; then the role overrides for that channel
   (any allow beats a deny between roles, as Discord does); then the role grants; then Everyone. A private channel is one
   where Everyone has `view_channel` denied and chosen roles/people are allowed.
6. **One function**: `can(userId, permission, { channelId })` in `backend/src/permissions.js`, used by every REST route,
   socket event, search, and file download. It returns the answer from a short per-request cache that is dropped when a
   role, assignment or override changes (so a demoted person loses access on their next request, and a socket event
   `permissions_updated` makes open clients refresh).
7. Channel moderator (`channel_members.role`) stays as a shortcut: it is treated as an override granting
   `manage_messages` and `timeout_members` in that channel, so existing channels behave as before.

## Where it shows in the app

- Moderation > **Roles** tab: list ordered by rank (drag to reorder), create/edit with a permission checklist and color,
  member counts, who holds each role.
- Person page (Employees record): role chips with add/remove, limited by your rank.
- Channel settings > **Permissions**: roles/people rows with allow/deny/inherit toggles; "Make private" becomes a preset.
- Role color on names and a role badge in the member list; `@Role` mentions reuse the existing @groups, gated by
  `mention_everyone`-style permission.
- Audit log entries for every role, assignment and override change.

## Build in phases (each shippable, tests and a migration each)

1. **Engine**: tables, `can()`, built-in roles, migration that maps today's flags to roles; replace hard-coded checks
   route by route, with a test per route proving the old behavior is unchanged. No new screens yet.
2. **Roles screen + assignment** (Moderation tab, person page) and the hierarchy rules, audit log.
3. **Channel overrides** screen and enforcement in messages, search, files, sockets (hidden content never leaks:
   unread counts, search snippets, file downloads).
4. **Role mentions, colors, badges**, and the offboarding hook (deactivation clears roles).

## Test matrix (from the Discord doc, trimmed)

Two roles with conflicting overrides; Everyone denied but a person allowed; role removed while the person is viewing the
channel (history, search, download, socket all denied); hierarchy (cannot edit a higher role, cannot grant what you lack);
Owner cannot be removed; last HR cannot be removed by themselves; guest accounts stay confined; stale socket after
downgrade.

## Decisions needed before phase 1

- Keep **Superadmin** as the single Owner, or allow several Owners? (Recommend: several, at least one always remains.)
- Should HR stay a fixed role or become an ordinary editable role? (Recommend: built-in but its permissions editable.)
- Guests: keep the current guest rules untouched in phase 1? (Recommend: yes.)

## Status

Decisions (2026-11-12): several Owners allowed (at least one always remains); HR is a built-in role with editable
permissions; guest accounts unchanged in phase 1.

**Phase 1 done (engine):** tables `roles`, `user_roles`, `channel_overrides` with the three built-in roles seeded;
`backend/src/permissions.js` (`can`, `requirePermission`, `resolvePermission`, the permission list); the Superadmin and
`is_hr` flags still drive Owner and HR, so nothing changed for anyone. First wiring: a role granting `manage_messages`
now also passes the channel-moderator check. Next in phase 1: move the remaining hard-coded checks (post, delete,
moderation, HR routes) onto `can()` one route at a time, each with a test proving the old behavior is unchanged.

**Phase 1 wiring so far:** moderation settings, slow mode, audit log (no channel) and changing a channel's moderators
check `manage_workspace`, `view_audit_log` and `manage_channels`; the HR routes accept any role with `manage_people`
(`requireHr`); channel-moderator checks accept a role with `manage_messages`. Still on the old flags: posting rules,
message and file deletion, canvases, the places that read `is_hr`/`is_superadmin` directly (leave and attendance scope,
people), and the sockets.

**Phase 2 done (first version):** `/api/roles` (list, create, edit, delete, move up/down, give custom roles to a person)
with the hierarchy rules in `backend/src/roles.js` (you manage only roles below your own and grant only permissions you
hold; Owner is untouchable; HR and Everyone keep their names but their permissions are editable) and an audit entry for
every change. Moderation has a **Roles** tab (Superadmin only for now): the ranked list, New role / Edit with a
permission checklist, and "Give roles to a person". Still to do in phase 2: role chips on the person's record, and
showing the Roles tab to anyone whose role grants `manage_roles`. Phase 3 (channel overrides screen) is next.

**Phase 2 finished:** the Roles tab now shows for anyone whose role grants `manage_roles` (the access answer carries `canManageRoles`), and a person's employee record has a Roles section to give or take custom roles.

**Phase 3 done:** channel overrides. `GET/PUT /api/channels/:id/permissions` (creator, Owner or a role with
`manage_channels`), a Permissions card on each channel in Moderation (rows for roles and people, Inherit/Allow/Deny per
permission, saves at once), and enforcement of `view_channel` (opening the channel, history, and the channel lists),
`send_messages`, `attach_files` and `add_reactions`. Ordinary channels cost no extra queries: the check only runs when a
channel has a setting for that permission or the Everyone role no longer grants it. The Roles tab's "Give roles to a
person" is now a table of everyone against the custom roles (tick to save). Not yet: open clients refreshing live when
permissions change (the `permissions_updated` socket event is sent but the app does not listen yet), `mention_everyone`
enforcement, and phase 4 (role mentions, colors on names, badges).

**Update (same day, later):** open clients now refresh when roles or channel permissions change (`permissions_updated`),
file deletion, topic editing and channel deletion also accept the matching role permission, and a person's page shows
their roles as colored chips (`roles` on `/api/people`). `mention_everyone` is reserved: the app has no @everyone yet, so
nothing enforces it. Still open: role colors next to names in messages, role mentions (@role), and moving the rest of the
old flag checks (canvases, remaining sockets) onto `can()`.

**Phase 4 done:** message authors show their full name (username when none) in the color of their highest custom role
(`roleColor` on `/api/users` and `/api/auth/me`); roles can be @mentioned by a handle made from the name (`Team lead` is
`@team-lead`; HR is `@hr`), offered in the composer's @ picker, highlighted in messages, and notifying everyone who holds
the role and is in the channel (`/api/roles/mentionable`, `notifyMessageActivity`). Any member may mention a role.
Left as they are on purpose: canvases keep their own viewer/commenter/editor/owner roles with the Owner bypass, and
guest accounts are unchanged.

**Access checker (2026-11-12):** Moderation > Roles > Check access. Pick a person or a role: it lists every permission
with the reason it is allowed or not, and every channel with can-see / send / attach / react and why (`GET
/api/roles/check`, `explainPermission` in `permissions.js`, kept equal to `resolvePermission` by a test). It never acts as
anyone. A read-only "View as" (the app opened as that person, every write refused, DMs hidden, audited) is the planned
next step.

**View as (2026-11-12):** an Owner opens Moderation > Roles > Check access, picks a person, and presses "View as". The app
reopens as that person for one hour with an orange bar ("Viewing as ... Read-only. Exit View as"). Rules
(`backend/src/viewAs.js`, applied in `middleware/auth.js`): the token is read-only (any write is refused), it may read only
channels, channel messages, people, groups, lists and channel canvases, and everything private to the person is refused
(direct messages, notes, saved items, reminders, search, files they sent, leave, attendance, settings); the live socket
refuses it, so nothing is received or shown online as them; it stops working if the Owner who started it stops being
an Owner; starting it is written to the audit log (`view_as_started`). Not available for another Owner. The Owner's own
sign-in is kept in the `viewAsReturn` store key and restored by Exit.

**View as is live (2026-11-12):** the viewing session keeps a listen-only socket (`watchUserId` in `sockets/chat.js`): it
joins only the channel rooms the person is in, so new messages, reactions and permission changes appear without
reloading; it never joins their personal room (DMs, notifications), never marks them online, and every action is refused.

**Go-live switch (2026-11-12):** Moderation > Rules and audit log > Launch mode (`backend/src/launch.js`,
`/api/admin/launch`). Pre-launch is today's relaxed testing mode; **Go live** (after a confirmation) turns the shared test
password off and makes everyone choose their own, and limits clocking to the office networks, and it is refused while an
office network is not listed. The card also lists warnings: not on https, a proxy without TRUST_PROXY, a short or default
JWT_SECRET, CORS open to every site. Return to pre-launch relaxes clocking but never brings the shared password back.

**View as, testing mode (2026-11-12):** while the workspace is Pre-launch, View as shows everything the person can read,
including their direct messages, notes, saved items, leave and attendance, still strictly read-only (every write is refused,
no presence, no acting as them); the orange bar says so and the audit entry records `includesPrivate`. The moment the
workspace goes Live this mode ends and View as returns to what their roles decide (channels, people, lists, channel canvases),
so employees' private messages are not open to anyone looking through their eyes. (`viewAsRefusal(..., { full })`.)

**View as with sample content after go-live (2026-11-12):** once the workspace is Live, View as keeps the person's real
structure (their channels, tabs, people, what is allowed) but channel messages, threads, pins, reactions, channel canvases
and lists come from fixed made-up samples (`backend/src/viewAsDemo.js`, applied in `middleware/auth.js`), never from the
database; a channel the person cannot open is still refused. The sidebar items for direct messages, notes, saved items and
activity stay hidden in this mode (their content would have to be invented too). Pre-launch keeps the real-data testing view.
