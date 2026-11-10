# IT Avenue Workspace - Runbook

Everything a human is likely to forget. Read this before touching the stack.

Project root: `D:\Development\itavenue-workspace`

## Stack overview

| Layer | Technology | Container |
|---|---|---|
| Database | PostgreSQL 15 (alpine) | `itavenue-db` |
| API + Socket.io | Node.js + Express | `itavenue-backend` |
| Desktop client | Electron 28 (loads `file://`) | n/a (runs on host) |

Ports: backend `3001`, Postgres `5432`. Both bound on `0.0.0.0`.

## Bringing everything back after a restart / reboot

Docker daemon comes up on login, but the containers are not auto-started:

```cmd
cd D:\Development\itavenue-workspace
docker compose up -d
```

Expected output: `Container itavenue-db Healthy` followed by `Container itavenue-backend Started`.

Verify:

```cmd
docker ps --filter name=itavenue
curl.exe -s http://127.0.0.1:3001/api/health
```

Expect `{"status":"ok",...}` and `pg_isready` healthy. If health fails, check `docker logs itavenue-backend`.

## Starting the desktop app

Do **not** run plain `npm start`. Your environment exports `ELECTRON_RUN_AS_NODE=1`,
which forces Electron to run as plain Node.js and crashes with
`TypeError: Cannot read properties of undefined (reading 'whenReady')`.
Always use the launcher, which clears that variable:

```cmd
D:\Development\itavenue-workspace\frontend\start.cmd
```

or the equivalent one-liner:

```cmd
cd /d D:\Development\itavenue-workspace\frontend
set ELECTRON_RUN_AS_NODE=
npm start
```

The app auto-loads your stored session (`electron-store`), skips the login page if a token exists,
and opens the main window. Log in with your registered account if the app shows the login card.

### Window chrome

The app runs frameless: there is no native title bar and no native menu bar.

- Minimize, maximize/restore, and close are the buttons at the top right of the app window.
- The login window has its own slim bar with minimize and close.
- All menu commands (File, Edit, View, Window, Help) live in the hamburger button at the top left,
  as flyout submenus. Shortcuts still work: `Ctrl+K` search, `Ctrl+N` new message, `Ctrl+R` reload,
  `Ctrl+Shift+R` force reload, `Ctrl+Shift+I` devtools, `F11` full screen, `Ctrl+Q` quit.
- The top bar is the drag region; drag from empty topbar space to move the window.

## Known issues / things to forget to check

- `ELECTRON_RUN_AS_NODE=1` is set globally in this machine's environment
  (check with `echo %ELECTRON_RUN_AS_NODE%`). Every Electron launch must clear it.
- The backend binds IPv4 only (`0.0.0.0:3001`). In the frontend, use `127.0.0.1:3001`, never `localhost`.
- CORS is `origin: true`, which is fine for a self-hosted JWT-authenticated office app, but if you put this behind a reverse proxy you may want to lock it down.
- Socket.io client path in `index.html`/`login.html` is `../node_modules/socket.io-client/dist/socket.io.js`.
  Do not "fix" it back to `build/client/`; that path does not exist.
- `renderer.js` must not declare `const { electronAPI } = window` or any element lookup may collide
  with the preload's exposed global. Declare nothing; use `window.electronAPI`.
- `styles.css` must keep `html, body { overflow: hidden }` to kill the app-level scrollbars.
- The default window is 1200x800, min 900x600. A separate login window is 480x720.

## Secrets in `D:\Development\itavenue-workspace\.env`

```
BACKEND_PORT=3001
FRONTEND_URL=http://localhost:3000
POSTGRES_USER=itavenue
POSTGRES_PASSWORD=change_me_in_production
POSTGRES_DB=itavenue
DATABASE_URL=postgresql://itavenue:change_me_in_production@db:5432/itavenue
JWT_SECRET=change_this_to_a_random_secret_string
JWT_EXPIRES_IN=7d
MAX_FILE_SIZE_MB=25
UPLOAD_DIR=/app/uploads
```

**You must change `POSTGRES_PASSWORD` and `JWT_SECRET` before this app touches a network.**
Default values are public in this file and in git history. Generate random values:

```cmd
powershell -Command "[guid]::NewGuid().ToString()"
powershell -Command "[guid]::NewGuid().ToString()"
```

After editing `.env`, recreate the containers:

```cmd
cd D:\Development\itavenue-workspace
docker compose down
docker compose up -d
```

## Resetting the database

```cmd
cd D:\Development\itavenue-workspace
docker compose down -v
```

`-v` deletes the `itavenue_db_data` and `itavenue_uploads` volumes. Everything is lost:
users, channels, messages, uploads. Next `docker compose up -d` re-runs `database/init.sql` and
seeds the four default channels (general, random, dev, announcements).

## Rebuilding the backend after code changes

```cmd
cd D:\Development\itavenue-workspace
docker compose up -d --build backend
```

Verify with `curl -s http://127.0.0.1:3001/api/health`.

## Frontend edits

After changing any file in `frontend/src` or `frontend/main.js`:

1. Close the running Electron window.
2. `start.cmd` to relaunch. The renderer loads `file://` pages fresh every launch.

Syntax check a renderer file before relying on it:

```cmd
node --check D:\Development\itavenue-workspace\frontend\src\renderer.js
```

## Why this app is "look-alike" and not Slack

IT Avenue Workspace is original code. The purple theme, name, IA logo, channels-and-messages
across it are industry-standard chat patterns we implemented ourselves from scratch. No Slack code,
assets, or branding are included or were copied. The Huddle, Files-tab and Notes-tab screens are mock
UI unless explicitly wired to the backend; labels on those views say so.

## Where things live

```
D:\Development\itavenue-workspace\
├── backend\            Express + Socket.io API  (started in Docker)
├── frontend\           Electron desktop app     (runs on host)
├── database\           init.sql seeded on first boot
├── docker-compose.yml  db + backend, one command
├── .env                secrets (edit me)
├── start.cmd           clear ELECTRON_RUN_AS_NODE and launch Electron
└── README.md / RUNBOOK.md  what you are reading
```

## Known-good launch, in order

```cmd
cd D:\Development\itavenue-workspace
docker compose up -d          # bring DB + API up, wait for healthy
D:\Development\itavenue-workspace\frontend\start.cmd
```

Log in (or register), and the main window should show the sidebar, the general channel, live messages
coming from the database, and a working `+ New channel` flow.

## If the window is blank / nothing responds

- Most likely: `ELECTRON_RUN_AS_NODE` was not cleared -> launcher crash. Use `start.cmd`.
- Or the backend isn't up. Check `docker ps`.
- Or renderer JS failed silently (no console window). Run the syntax check:
  `node --check D:\Development\itavenue-workspace\frontend\src\renderer.js`.
  The pattern we hit before was a parse-time error killing the whole file, leaving all listeners
  unattached while the chrome still looked correct.

## See also

- [REA-GHIDRA-SETUP.md](REA-GHIDRA-SETUP.md) - Ghidra and REA installation, configuration, and analysis usage (separate from this app's stack).

