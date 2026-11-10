# IT Avenue Workspace

Office chat application - self-hosted on your own server.

## Directory Layout

```
/backend          # Node.js + Express + Socket.io API server (Phase 1 - built)
/frontend         # Electron desktop application (Phase 2 - built)
/database         # PostgreSQL initialization scripts (Phase 1 - built)
docker-compose.yml  # One-command local development stack
.env.example      # Environment variable template
ROADMAP.md        # Roadmap, progress, and known defects (start here)
RUNBOOK.md        # How to bring the stack back; secrets; troubleshooting
REA-GHIDRA-SETUP.md  # Ghidra + REA installation, configuration, and usage
/docs             # All documentation lives here
```

## Planned Stack

| Layer | Technology | Status |
|---|---|---|
| Desktop app | Electron | ✅ Built |
| Backend | Node.js + Express + Socket.io | ✅ Built |
| Database | PostgreSQL | ✅ Built |
| Auth | JWT (username/password) | ✅ Built |
| File storage | Local disk (`uploads/` volume) | ✅ Built (S3 is optional later) |
| Container | Docker + Docker Compose | ✅ Configured |

## Getting Started

### Prerequisites

- Docker Desktop (running)
- Node.js 18+ (for local dev without Docker)

### Option 1: Docker (recommended)

```bash
cd D:\Development\itavenue-workspace

# Copy environment template
copy .env.example .env
# Edit .env with your settings

# Start the stack
docker compose up -d
```

### Option 2: Local development (backend only)

```bash
cd D:\Development\itavenue-workspace\backend
npm install
copy ..\.env.example .env
# Edit .env with your settings
# Make sure PostgreSQL is running on port 5432
npm run dev
```

## Status

- Planning: Complete
- Phase 1 (Backend + Database): Built and verified
- Phase 2 (Electron Desktop App): Built and verified end to end
- Phase 3 (Rich Features): Files, Notes, unread badges, presence, Activity, and read receipts done;
  audio Huddle MVP implemented with two-client validation pending
- Phase 4 (Deploy to Hostinger KVM): Planned

See [ROADMAP.md](ROADMAP.md) for what is built and what is still mocked,
[RUNBOOK.md](RUNBOOK.md) for operations (Docker bring-up, secrets, troubleshooting), and
[REA-GHIDRA-SETUP.md](REA-GHIDRA-SETUP.md) for the Ghidra/REA analysis setup.
