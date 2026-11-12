# The phone app

A web app for phones, opened in the phone's browser at **`http://<server address>:3001/m/`** (the same server as the desktop app). Sign in with the same username and password. No app store, nothing to install. It is built as a Progressive Web App (PWA), so the same files become a real installable app with notifications once the server has HTTPS.

## What it does (version 1)

| Tab | What you can do |
|---|---|
| **Chat** | Channels, direct messages and group conversations: read, send, and see new messages as they arrive. Pictures and files in messages show up. Unread counts on the tab. |
| **Clock** | Clock in and out as often as you leave and come back, today's status, your month (late, over break, short, hours, overtime), ask for a correction on a past day. Managers and HR also approve corrections here. The device check and the office-network rule apply exactly as on the desktop. |
| **Leave** | Balances, request leave (with the day count shown first), cancel, and approve or decline requests from your team (managers, HR). |
| **People** | Search the directory; a person's page with call, email and Message buttons, and who they report to. |
| **Me** | Your profile, change your password (new accounts are asked to when they first sign in), sign out. |

Not in the phone app yet: sending photos or files, calls (huddles), canvases, lists, the wiki, the org chart picture, and HR screens (employee records, schedules, exports). Use the desktop app for those.

## Putting it on a phone

1. Connect the phone to the office Wi-Fi.
2. Open `http://<server address>:3001/m/` in Chrome (Android) or Safari (iPhone). The server's address is the one the desktop app connects to.
3. Sign in. In the browser menu choose **Add to Home screen** for an icon.

## Limits of plain http (office Wi-Fi only)

Browsers only allow installing a web app as a full app, working offline, and **push notifications** on a secure origin (HTTPS, or localhost). On `http://192.168.x.x` the phone app still works fully while it is open (messages arrive live, the tab badges update), and "Add to Home screen" gives a shortcut, but:

- there are **no notifications when the app is closed**, and the service worker (offline start) does not run;
- iPhones may warn about the page not being secure.

Both go away once the server has a domain and HTTPS (see `deploy/README.md`, the Caddy profile). The manifest, the icons and the service worker are already in place, so they switch on by themselves. Web push (notifications to a closed app) is the next piece to build then.

## Attendance from a phone

- The phone sends a random device id (made once per browser) with every clock-in and clock-out. The first device a person clocks in from is trusted; a new phone is allowed but flagged until HR approves it (Attendance > New devices).
- The office-network rule and the recorded IP address work the same way. As on the desktop, they need the server to see each phone's real address, which is not the case while the server runs in Docker Desktop (see `docs/EMPLOYEE_MANAGEMENT.md`).
- Clearing the browser's site data makes the phone look like a new device.

## For developers

- Files: `backend/public/m/` (index.html, manifest, service worker, `app.css`, `js/`). No build step: plain ES modules. Served by `backend/server.js` at `/m` with its own, stricter-than-needed page policy (scripts, styles, images and the socket from this server only; no inline script or style attributes).
- The app talks to the same REST API and Socket.IO events as the desktop app; nothing on the server was added for it.
- Screens never build markup from strings (`innerHTML` and friends are banned by `backend/test/mobile.test.js`); use `h()` and `put()` from `js/ui.js`.
- After changing a file in `js/`, add new files to the list in `sw.js` (a test checks it) and bump `VERSION` there.
- Tests: `backend/test/mobile.test.js`.
