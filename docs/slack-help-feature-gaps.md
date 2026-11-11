# Slack Help Center Feature Gaps

Comparison of IT Avenue Workspace with Slack's **Getting started** Help Center
category and the relevant guides linked from it. This is a focused comparison,
not an exhaustive inventory of every Slack product or plan feature.

Reviewed: 2026-11-11

## Scope and method

The supplied page, [Getting started](https://slack.com/help/categories/360000049043),
contains these sections:

- Intro to Slack
- Getting started for Slack admins
- Getting started for new users
- Review roles & permissions

The comparison also uses Slack's quick-start and actions guides and its
role/guest permission guides. Product claims below are checked against this
repository's [frontend feature inventory](./frontend.md),
[roadmap](./ROADMAP.md), and current frontend/backend implementation.
“Missing” means no corresponding user-facing feature was found in the app;
it does not mean the underlying Slack feature is appropriate for this
self-hosted project.

## Gaps to consider

| Priority | Feature in Slack guidance | Current app status | Gap |
|---|---|---|---|
| High | **Mentions** to notify a person in a conversation | Messages are plain text and no mention picker/notification handling was found | Add user mentions, autocomplete, and notifications for mentioned users. |
| High | **Activity feed** for mentions, threads, and reactions | Activity currently lists channels with unread messages | Expand Activity into an event feed with filters or sections for mentions, replies, and reactions to the user's messages. |
| High | **Notification preferences** | Preferences currently cover theme and Enter-to-send only | Add configurable notifications (at minimum mentions, DMs, replies, and channel activity), plus a pause/Do Not Disturb option. |
| High | **Group direct messages** | DMs are one-to-one; backend conversations address one other user | Support group conversations with multiple participants, participant management, and group history. |
| High | **Save messages/files for later** | Messages can be pinned per channel; no private saved-items list was found | Add a personal saved-items view distinct from shared channel pins. |
| High | **Edit or delete your own messages** | Moderators can remove channel messages; no ordinary-user edit/delete flow was found | Let authors edit and delete their own messages, with clear edit history or deletion behavior. |
| High | **Guest / restricted member roles** | Roles are member, channel moderator, and Superadmin; channel access can be restricted | Consider guest accounts with explicit channel allowlists and constrained permissions. Slack also has separate single- and multi-channel guest types; those billing distinctions may not fit this self-hosted app. |
| Medium | **Reminders** | No reminder creation or reminder list was found | Add personal or message-linked reminders with due time and notification delivery. |
| Medium | **Schedule a message for later** | Messages send immediately | Add scheduled-send date/time, review/cancel controls, and delivery handling. |
| Medium | **Rich message formatting** | Message text is rendered escaped as plain text; Canvas has Markdown separately | Add a safe composer/renderer for common formatting such as bold, lists, and quotes. |
| Medium | **Custom sidebar sections** | Sidebar contains fixed channel, DM, and unread lists | Let users organize conversations into personal sections and reorder them. |
| Medium | **Conversation tabs and shared resources** | Pins, Files, and Canvas are separate views; channels do not have configurable resource tabs | Allow channel/DM headers to surface shared links, files, canvases, and other resources as configurable tabs or folders. |
| Medium | **User groups** | No user-group management or group-mention support was found | Create named groups of users and mention a group in a channel. |
| Medium | **Workspace invitations and member onboarding** | Users can register directly; no invitation workflow was found | Add admin-issued invitations, expiration/revocation, and an onboarding path for invited users. |
| Medium | **Manual status and pause notifications** | Presence is primarily automatic (online/away/offline); no user-set status message or DND control was found | Add a user-controlled status and a notification pause/snooze control. |
| Medium | **Video and screen sharing in calls** | Huddle is an audio-only WebRTC MVP, limited to six participants; validation and TURN support remain outstanding | Decide whether to add video and screen sharing, and improve call reliability before expanding call scope. |
| Lower | **Integrations and workflow automation** | No app directory, integration framework, or workflow builder was found | Add webhook/integration support or lightweight automations if the product needs them. |
| Lower | **Workspace discovery and multiple workspaces** | The client connects to one configured backend/workspace | Consider workspace switching/discovery only if users need to participate in multiple deployments. |

## Existing capabilities that already overlap

The app already has channels, one-to-one DMs, file sharing, search, pins,
emoji reactions, read receipts, profile editing, channel-level member/moderator
permissions, shared Lists and Canvas, and an audio-only Huddle MVP. These are
not listed as missing merely because Slack's guides mention them; their current
scope or maturity is noted where relevant above.

## Suggested order

1. Mentions and a richer Activity feed.
2. Notification controls and group DMs.
3. Own-message edit/delete and personal saved items/reminders.
4. Guest/invitation flows and improved role administration.
5. Scheduled sending, formatting, and channel/DM resource organization.
6. Integrations, workflows, and any expansion of Huddle after validating the
   existing audio implementation.

## Slack references

- [Getting started category](https://slack.com/help/categories/360000049043)
- [What is Slack?](https://slack.com/help/articles/115004071768-What-is-Slack)
- [How to use Slack: your quick start guide](https://slack.com/help/articles/360059928654-How-to-use-Slack--your-quick-start-guide)
- [Understand your actions in Slack](https://slack.com/help/articles/360002063088-Understand-your-actions-in-Slack)
- [Getting started for new Slack users](https://slack.com/help/articles/218080037-Getting-started-for-new-Slack-users)
- [Types of roles in Slack](https://slack.com/help/articles/360018112273-Types-of-roles-in-Slack)
- [Permissions by role in Slack](https://slack.com/help/articles/201314026-Permissions-by-role-in-Slack)
- [Understand guest roles in Slack](https://slack.com/help/articles/202518103-Understand-guest-roles-in-Slack)
