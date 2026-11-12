# Install the phone app (PWA) on your phone

Written 2026-11-12 for trying the phone app on your own phone over the office Wi-Fi. It uses the local HTTPS set up with
mkcert (see `deploy/README.md`, "Local HTTPS with mkcert").

## Before you start

- The phone is on the **same Wi-Fi** as this computer.
- This computer is on, Docker is running, and the proxy is up:

  ```powershell
  docker compose --profile tls up -d proxy
  ```

- This computer's address is `192.168.18.63` today. If it is different on another network (check with `ipconfig`), run
  `powershell -ExecutionPolicy Bypass -File deploy\local-https.ps1` again, then add the new address to
  `LOCAL_SITE_ADDRESSES` in `.env` and restart the proxy.

## 1. Make the phone trust the certificate

The phone does not know your local certificate authority yet, so it would show a warning. Send it this file (email,
USB cable, or any file transfer):

```
C:\Users\cha0s\AppData\Local\mkcert\rootCA.pem
```

Send only `rootCA.pem`. Never send `rootCA-key.pem` (the same folder): whoever has it can make certificates your
computers trust.

**Android**
1. Open the file on the phone, or go to Settings, Security, Encryption and credentials, Install a certificate.
2. Choose **CA certificate**, confirm the warning, and pick `rootCA.pem`.

**iPhone**
1. Open the file; choose to install the profile (Settings, Profile Downloaded).
2. Then go to Settings, General, About, Certificate Trust Settings and **switch it on** for the mkcert authority.

## 2. Open the app

In Chrome (Android) or Safari (iPhone), open:

```
https://192.168.18.63:8443/m/
```

A browser warning means step 1 is not finished. Sign in with your workspace account.

## 3. Install it

- **Android (Chrome):** menu (three dots), **Install app** (or Add to Home screen).
- **iPhone (Safari):** Share button, **Add to Home Screen**.

## If it does not work

- **The page does not load at all:** Windows Firewall may block port 8443. Allow inbound TCP 8443 for Docker (or
  for this computer's private network), then try again. Also check the phone is on the same Wi-Fi and the proxy
  is running.
- **A certificate warning:** the certificate was not installed or trusted (step 1; on iPhone the Trust Settings switch
  is separate from installing).
- **No "Install" option:** reload the page once; the install offer appears only on a trusted https address.

## What to expect

- Chat, attendance, leave and people work. Attendance clocking only works from the office network, but Docker
  Desktop on Windows hides each device's real address, so that rule cannot tell devices apart here. It is fixed on the
  Linux host.
- Offline, only the app shell opens; messages and data need the connection.
- Push notifications are not set up yet: they need a real domain or the Linux host.
- Tell Claude what the phone shows if something fails.
