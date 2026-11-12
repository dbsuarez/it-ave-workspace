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
