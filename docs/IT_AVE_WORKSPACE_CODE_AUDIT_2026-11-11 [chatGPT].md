# IT Avenue Workspace — Re-Audit of Current `main`

**Audit date:** 2026-11-11 (Asia/Manila)  
**Repository:** https://github.com/dbsuarez/it-ave-workspace  
**Scope:** Read-only, targeted static inspection of current GitHub `main` pages for backend authentication, Socket.IO, uploads, Electron bridge/navigation, Docker, and startup schema handling.  
**Execution:** Direct chat only; **no ChatGPT Work**. No code changes.  
**Confidence:** Findings are grounded in GitHub file contents viewed during this audit, but not demonstrated through running tests or exploit reproduction. No clone or dependency scan was available. The repository branch is mutable; verify the exact deployed revision before remediation.

## Executive summary

The new review **does not blindly carry forward the prior audit**. The Electron application **now contains navigation confinement**, including `setWindowOpenHandler` and `will-navigate` restrictions, so the old suggestion that these restrictions are absent is **superseded**. The application also has **invitation-only registration support** and **a migrations module**, which qualify prior broad claims.

The following issues still appear in the inspected code. Priority depends on deployment: a LAN-only development instance has a different threat model from an internet-exposed office service.

| ID | Priority | Current finding | Verification |
| --- | --- | --- | --- |
| A01 | High | Socket.IO permits reauthentication without leaving previously joined personal/channel rooms | Source-confirmed; exploit not run |
| A02 | High when network-exposed | Docker development compose publishes PostgreSQL as `5432:5432` on host interfaces | Source-confirmed; intentionally documented as development |
| A03 | Medium–High | Electron preload exposes arbitrary store `get/set/delete` and the matching handlers do not validate callers | Source-confirmed; impact conditional on compromised/untrusted renderer |
| A04 | Medium | Channel and DM attachment IDs can be reassigned, with no existing-assignment guard or transaction in the inspected paths | Source-confirmed; impact requires an attachment owned by caller |
| A05 | Medium when network-exposed | Login/registration endpoints have no visible throttling; password minimum remains 6 characters | Source-confirmed for inspected routes; upstream controls not inspected |
| A06 | Medium | Upload validation accepts filename extension **or** declared MIME type, without content signature validation | Source-confirmed; not by itself an executable-file vulnerability |
| A07 | Low–Medium / deployment | CORS reflects request origin for HTTP and Socket.IO | Source-confirmed; JWT remains the authorization boundary |
| A08 | Medium / deployment | Login client uses hard-coded `http://127.0.0.1:3001` | Source-confirmed; sensible for same-machine development |
| A09 | Low–Medium / maintainability | Server retains a long chain of startup DDL **alongside** a migrations module | Source-confirmed; previous assertion that no migrations exist was inaccurate |

## Findings and recommended remediation

### A01 — Socket authentication can retain previous subscriptions (High)

**Evidence:** [`backend/src/sockets/chat.js`](https://github.com/dbsuarez/it-ave-workspace/blob/main/backend/src/sockets/chat.js) — `socket.on('authenticate', ...)` sets `currentUserId`, then calls `socket.join(\`user_${currentUserId}\`)`. The handler has no one-time-authentication guard and does not leave old `user_*`, `channel_*`, or huddle subscriptions before accepting another token.

**Threat model:** A client possessing valid JWTs for accounts A and B can authenticate as A, join A's authorized rooms, then send `authenticate` with B's JWT on the same connection. Socket.IO room memberships persist unless explicitly removed. This may expose events emitted to A's rooms after the switch; it does **not** imply the attacker can obtain A's token without access to A's credentials.

**Fix:** Prefer one authenticated identity per socket lifetime; reject or disconnect on a second authenticate event. Alternatively, leave all non-socket-ID rooms and reset huddle/presence state before switching identities. Add a two-account socket regression test that attempts to receive A's DM and channel events after authenticating as B.

### A02 — Postgres host-port binding (High only if exposed)

**Evidence:** [`docker-compose.yml`](https://github.com/dbsuarez/it-ave-workspace/blob/main/docker-compose.yml) declares `ports: ["5432:5432"]`; [`docs/RUNBOOK.md`](https://github.com/dbsuarez/it-ave-workspace/blob/main/docs/RUNBOOK.md) explicitly describes a development setup with Postgres and backend on `0.0.0.0`.

**Impact:** PostgreSQL is potentially reachable by other hosts when host firewall/router rules allow it. This is a deployment exposure, not proof of database compromise. The file itself is labeled development.

**Fix:** For production, remove the DB `ports` mapping entirely (backend-to-DB traffic works on the Compose network). If host access is necessary for local development, bind `127.0.0.1:5432:5432`. Separately review firewall and DB credentials.

### A03 — Electron privileged storage access is broad (Medium–High)

**Evidence:** [`frontend/preload.js`](https://github.com/dbsuarez/it-ave-workspace/blob/main/frontend/preload.js) exposes `storeGet`, `storeSet`, `storeDelete` for arbitrary keys. [`frontend/main.js`](https://github.com/dbsuarez/it-ave-workspace/blob/main/frontend/main.js) implements those calls with `store.get/set/delete(key)` without an allowlist or explicit sender validation. The renderer stores `authToken` through this bridge in [`frontend/src/login.js`](https://github.com/dbsuarez/it-ave-workspace/blob/main/frontend/src/login.js).

**Impact:** Malicious script executing within an authorized renderer could read or overwrite credentials and other app storage. `contextIsolation: true` and `nodeIntegration: false` are correctly enabled, and navigation confinement reduces some exposure; neither makes arbitrary IPC access harmless in the event of renderer compromise.

**Fix:** Allowlist permitted settings; expose dedicated authenticated-session operations with narrowly defined semantics; check `event.senderFrame` and originating window for sensitive IPC handlers; consider keeping bearer tokens out of general-purpose renderer-visible storage.

### A04 — Attachment linking lacks single-assignment enforcement (Medium)

**Evidence:** [`backend/src/sockets/chat.js`](https://github.com/dbsuarez/it-ave-workspace/blob/main/backend/src/sockets/chat.js), `send_message` and `send_direct_message`, check `uploaded_by` but update `files.message_id` or `files.dm_message_id` by file ID plus owner without `... IS NULL` checks. Message insertion and attachment linking are distinct queries.

**Impact:** A file uploaded by a caller may be reused/relinked to later messages; a file could also have competing channel and DM associations unless constrained elsewhere in the schema. Concurrent sends can produce inconsistent associations or orphaned messages.

**Fix:** Use a database transaction. Claim an upload once with `UPDATE files SET ... WHERE id=$... AND uploaded_by=$... AND message_id IS NULL AND dm_message_id IS NULL RETURNING id`. Roll back the message insert if the claim failed. Add tests for repeated ID use, cross-channel use, concurrent sends and DM/channel crossover.

### A05 — Authentication abuse controls are incomplete in inspected routes (Medium–High)

**Evidence:** [`backend/src/routes/auth.js`](https://github.com/dbsuarez/it-ave-workspace/blob/main/backend/src/routes/auth.js) has unauthenticated `/login` and `/register` handlers without route-level throttling and permits passwords of length 6. [`backend/server.js`](https://github.com/dbsuarez/it-ave-workspace/blob/main/backend/server.js) shows normal Express middleware and no visible rate limiter for these paths.

**Important update:** Registration **does support invitation-only mode** using `moderation_settings.registration_mode`; do not repeat the previous claim that the project lacks invitation-only registration. Whether it is enabled is a runtime configuration question.

**Fix:** Add account- and IP-based rate limiting for login and registration, with a trusted reverse-proxy configuration where applicable. Adopt a stronger minimum password policy, preferably longer passphrases. Do not rely solely on an optional upstream gateway without documenting that assumption.

### A06 — Upload type checks trust client-provided metadata (Medium)

**Evidence:** [`backend/src/security.js`](https://github.com/dbsuarez/it-ave-workspace/blob/main/backend/src/security.js) accepts a file when `isMimeAllowed(file.mimetype)` **or** `isExtensionAllowed(file.originalname)` succeeds; [`backend/src/routes/messages.js`](https://github.com/dbsuarez/it-ave-workspace/blob/main/backend/src/routes/messages.js) invokes it in Multer's `fileFilter`. File size limits exist, which is positive.

**Impact:** A client may submit nonmatching file bytes under an allowed extension/MIME. Risk depends on how files are served, downloaded and previewed. This is not an assertion that uploaded code is executed by the server.

**Fix:** Where practical verify actual file signatures for known binary formats; treat text/archives cautiously; use randomized storage names without untrusted original filenames in the path; retain attachment authorization and safe download headers. Test a mismatched MIME/extension/payload combination.

### A07 — Permissive CORS is a hardening issue, not a standalone auth bypass (Low–Medium)

**Evidence:** [`backend/server.js`](https://github.com/dbsuarez/it-ave-workspace/blob/main/backend/server.js) uses `origin: true` with `credentials: true` for Express CORS and Socket.IO.

**Interpretation:** The Electron `file://` application has a `null` origin, and the repository documents this decision. CORS is not authorization; JWT checks still matter. Broad cross-origin browser access increases attack surface if future endpoints use cookie credentials or another browser-accessible secret.

**Fix:** Document intended clients; restrict browser origins where feasible while explicitly supporting the desktop client's needed behavior. Keep authorization in backend handlers. Lower priority than A01/A03.

### A08 — Loopback API address impedes remote deployment (Medium for distributed desktop users)

**Evidence:** [`frontend/src/login.js`](https://github.com/dbsuarez/it-ave-workspace/blob/main/frontend/src/login.js) sets `const API_BASE = 'http://127.0.0.1:3001'`.

**Impact:** Correct when Electron and backend run on the same machine; incorrect for desktops connecting to a central server. A packaged app installed on another PC would point at **that PC's** loopback address.

**Fix:** Centralize API/socket endpoint configuration; use a supported per-install server setting or build-time deployment value. Require HTTPS/WSS when accessing a remote server across untrusted networks. Add a remote-client smoke test.

### A09 — Mixed startup DDL and migration runner (Low–Medium)

**Evidence:** [`backend/server.js`](https://github.com/dbsuarez/it-ave-workspace/blob/main/backend/server.js) imports `./src/migrations` but still performs a long chain of `ALTER TABLE` / `CREATE TABLE` operations during app startup.

**Important update:** The prior audit described migrations as absent; the current code **does** have a migrations module. The issue is overlapping responsibility and the operational risk of large ad-hoc startup schema changes, not the absence of any migration infrastructure.

**Fix:** Consolidate schema upgrades into the existing migration system, record migration versions, apply each change once, and keep startup limited to checking compatible schema state. Validate restart and upgrade paths using a populated database copy.

## Superseded, corrected or contextualized prior findings

| Previous assessment | Current status | Evidence |
| --- | --- | --- |
| Electron navigation restrictions absent | **Superseded / addressed:** `confineNavigation()` prevents in-app navigation and child windows; external HTTP(S) links open through the system browser. Further sender validation is a separate concern. | [`frontend/main.js`](https://github.com/dbsuarez/it-ave-workspace/blob/main/frontend/main.js) |
| No invitation-only registration | **Not applicable:** registration can require an invitation based on `moderation_settings.registration_mode`. | [`backend/src/routes/auth.js`](https://github.com/dbsuarez/it-ave-workspace/blob/main/backend/src/routes/auth.js) |
| No migration infrastructure | **Correction:** a migrations module is imported, but startup DDL remains. | [`backend/server.js`](https://github.com/dbsuarez/it-ave-workspace/blob/main/backend/server.js) |
| Database exposure always High | **Contextualized:** development compose explicitly exposes it; severity becomes high when host/network access is actually permitted. | [`docker-compose.yml`](https://github.com/dbsuarez/it-ave-workspace/blob/main/docker-compose.yml) |
| CORS `origin: true` proves authentication bypass | **Incorrect framing:** permissive CORS alone does not bypass bearer-token validation. | [`backend/server.js`](https://github.com/dbsuarez/it-ave-workspace/blob/main/backend/server.js) |

## Practical order of work

1. **P0:** Lock socket identity for its whole connection and test A/B account isolation (**A01**).
2. **P0 for production:** Remove external PostgreSQL binding and verify network/secret configuration (**A02**).
3. **P1:** Restrict Electron IPC and test renderer-origin trust boundaries (**A03**).
4. **P1:** Make attachment linking transactional and one-time (**A04**).
5. **P1:** Add authentication throttling and improve password policy (**A05**).
6. **P2:** Harden uploads and verify download/preview behavior (**A06**).
7. **P2 / release:** Centralize endpoint configuration; document CORS policy (**A07–A08**).
8. **P3:** Consolidate migration paths and run upgrade tests (**A09**).

## Suggested regression test checklist

- [ ] Socket A→B authentication attempt cannot receive any A personal/channel events.
- [ ] Disconnect invalidates room memberships; revoked channel member receives no subsequent private-channel events.
- [ ] DB 5432 is not reachable from other machines in the production deployment.
- [ ] Renderer IPC cannot access arbitrary store keys or invoke sensitive handlers from an unapproved frame.
- [ ] The same uploaded file ID cannot be attached twice, across DMs and channels, or under concurrent requests.
- [ ] Login/registration requests trigger configured throttle responses after abuse thresholds.
- [ ] Uploaded file with conflicting name/MIME/content is blocked or safely served as untrusted content.
- [ ] Packaged client successfully connects to a configured remote backend over TLS.
- [ ] Populated database upgrades with the migration runner, then restarts idempotently.

## Scope and verification limitations

This is a **targeted re-audit of publicly browsable files on `main`**, not an exhaustive audit of every route, WebRTC flow, webhook implementation, UI injection sink or third-party dependency. The environment could browse GitHub source but could not clone the repository from the shell. **No tests, dependency vulnerability scan, live network inspection, or exploitation were performed.** Code observations are not proof that current production deployment shares the same configuration. Always validate after applying fixes and before declaring the service production-ready.

**No ChatGPT Work was used.**
