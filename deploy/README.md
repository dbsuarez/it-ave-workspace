# Deploying IT Avenue Workspace

Everything here is optional and off by default: `docker compose up -d` still starts just the database
and the backend. Each extra is a Compose **profile** you switch on when you need it.

| You want | Turn on | Section |
|----------|---------|---------|
| HTTPS (encrypted traffic) | `--profile tls` | [HTTPS](#https) |
| HTTPS on this computer for development | `--profile tls` + mkcert | [Local HTTPS with mkcert](#local-https-with-mkcert) |
| Backups that run by themselves | `--profile backup` | [Scheduled backups](#scheduled-backups) |
| Calls that work across restrictive networks | `--profile turn` | [Calls across firewalls (TURN)](#calls-across-firewalls-turn) |
| A signed Windows installer | `CSC_LINK` + `npm run dist` | [Signing the installer](#signing-the-installer) |

## HTTPS

Without HTTPS, passwords, messages and the login token cross the network in the clear. On a trusted office LAN
that is a risk you may accept; anywhere else it is not acceptable.

```powershell
# 1. In .env: your domain (or the server's address), and keep the backend reachable only through the proxy
SITE_ADDRESS=chat.example.com
BACKEND_BIND=127.0.0.1
TRUST_PROXY=1

# 2. Start the backend and the proxy
docker compose up -d backend
docker compose --profile tls up -d proxy
```

- **A real domain** pointing at this machine (ports 80 and 443 reachable from the internet): Caddy gets and
  renews a free Let's Encrypt certificate by itself. Nothing else to do.
- **An IP address or no domain** (office LAN): Caddy makes its own certificate authority. The apps will refuse
  the certificate until each computer trusts that authority:
  1. Copy the root certificate out: `docker cp itavenue-proxy:/data/caddy/pki/authorities/local/root.crt .`
  2. On each Windows computer, double-click it, *Install Certificate*, *Local Machine*, place it in *Trusted Root
     Certification Authorities*.
- **Point the desktop app at it:** on the sign-in window, set the server address to `https://chat.example.com`
  (no port). The app checks the address before saving it.
- The old [`nginx.conf`](nginx.conf) in this folder is an alternative if you already run Nginx.

Check it worked: open `https://your-address/api/health` in a browser; it should say `{"status":"ok"}` with a lock
icon and no warning.

## Local HTTPS with mkcert

For development on your own computer (and a phone on the same Wi-Fi) you can have real, trusted HTTPS without a
domain. [mkcert](https://github.com/FiloSottile/mkcert) makes a small certificate authority that only this computer
trusts, and a certificate signed by it. The service worker and web push of the phone app need this, and it is a
rehearsal for the real domain.

```powershell
powershell -ExecutionPolicy Bypass -File deploy\local-https.ps1
```

The script installs mkcert (winget), adds its authority to your trust store (Windows asks you to confirm), makes
`deploy\certs\local.pem` and `local-key.pem` for `localhost`, `127.0.0.1` and this computer's LAN addresses, and prints
the lines to put in `.env`:

```
CADDYFILE=./deploy/Caddyfile.local
LOCAL_SITE_ADDRESSES=https://localhost, https://127.0.0.1, https://192.168.18.63
PROXY_HTTPS_PORT=8443
```

Then `docker compose --profile tls up -d proxy` and open `https://localhost:8443/api/health`.

- **Port 8443** is used because something else (XAMPP's Apache here) already holds 443. If 443 is free on your
  machine, leave `PROXY_HTTPS_PORT` out.
- **Desktop app:** set the server address on the sign-in window to `https://localhost:8443`. The app uses the Windows
  trust store, so no warning appears. For development you can also start it with `API_BASE` and `SOCKET_URL` set to
  that address.
- **Phone:** the phone does not trust your authority yet. Send it `rootCA.pem` (its folder is printed by
  `mkcert -CAROOT`), install it as a CA certificate (Android: Settings, Security, Encryption and credentials, Install
  a certificate, CA certificate; iPhone: open the file, install the profile, then Settings, General, About,
  Certificate Trust Settings, switch it on), then open `https://<this computer's LAN address>:8443/m/`.
- **Keep `deploy\certs\local-key.pem` private** (git ignores the folder) and never share `rootCA-key.pem`: whoever has
  it can make certificates your computer trusts. The certificate lasts about two years; run the script again to renew.
- This is for development only. Real deployments use the Caddy setup above with a real domain.

## Scheduled backups

```powershell
docker compose --profile backup up -d backup
```

Every 24 hours (`BACKUP_INTERVAL_HOURS`) it writes `db-<date>.dump` and `uploads-<date>.tar.gz` to `./backups`
and deletes backups older than 14 days (`BACKUP_KEEP_DAYS`). One backup is taken as soon as it starts. Files
are written under a temporary name and renamed, so a half-written file is never mistaken for a good one.

**Copy `./backups` off the machine** (another disk or cloud storage). Restoring is in
[`docs/BACKUP.md`](../docs/BACKUP.md). Test a restore now and then; a backup you have never restored is a hope,
not a backup.

## Calls across firewalls (TURN)

Calls go directly between computers when they can. Behind strict firewalls or some mobile networks they cannot,
and need a relay. Run one on a **Linux server with a public address** (the relay uses host networking and a UDP
port range, so it does not work on Docker Desktop for Windows):

```bash
# .env
TURN_EXTERNAL_IP=203.0.113.10        # the server's public address
TURN_USER=itavenue
TURN_PASSWORD=choose-a-long-random-password
WEBRTC_ICE_SERVERS='[{"urls":"stun:stun.l.google.com:19302"},{"urls":"turn:203.0.113.10:3478","username":"itavenue","credential":"choose-a-long-random-password"}]'

docker compose --profile turn up -d turn
docker compose up -d backend          # picks up the new WEBRTC_ICE_SERVERS
```

Open **3478 (UDP and TCP)** and **49160-49200 (UDP)** in the server's firewall. The credential is sent to every
signed-in client, so treat it as shared; use a long random one.

To check it really relays, the call test in [`docs/CALL_TEST.md`](../docs/CALL_TEST.md) includes a "relay only"
step.

## Signing the installer

An unsigned installer works, but Windows SmartScreen warns "unknown publisher" and some company policies block
it. To sign:

1. Buy a **code-signing certificate** (an `.pfx` file from a certificate authority; an EV certificate removes the
   SmartScreen warning immediately, a standard one builds reputation over time). Microsoft's *Trusted Signing*
   service is an alternative.
2. Build with the certificate (never commit it or its password):

   ```powershell
   cd frontend
   $env:CSC_LINK = "C:\secure\itavenue-codesign.pfx"
   $env:CSC_KEY_PASSWORD = "the password"
   npm run dist
   ```
3. Check it: `npm run verify:installer` lists each build as `SIGNED` or `UNSIGNED` and exits with an error if any
   is unsigned. `npm run smoke -- --exe "dist\win-unpacked\IT Avenue Workspace.exe"` checks the built app opens.

## Which web sites may call the API (CORS)

Only the desktop app, local tools and the sites listed in `CORS_ORIGINS` (comma separated) may call the API from
a browser. Leave it empty unless you add a web client. The desktop app needs no entry.

## Automated checks (CI)

`.github/workflows/ci.yml` runs on every push and pull request: the backend tests against a real PostgreSQL
(failing if any are skipped), the desktop client checks and tests, a check that the committed editor bundle
matches its source, a dependency audit, and a Windows smoke test that the app starts.
