# IT Avenue Workspace - Backend

Node.js + Express + Socket.io API server with PostgreSQL.

## Stack

- **Express** - REST API
- **Socket.io** - Real-time messaging (WebSockets)
- **PostgreSQL** - Database (via `pg`)
- **bcryptjs** - Password hashing
- **jsonwebtoken** - JWT authentication
- **dotenv** - Environment configuration

## Endpoints

### Auth
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/auth/register` | Register a new user |
| POST | `/api/auth/login` | Login and receive JWT |
| GET | `/api/auth/me` | Get current user profile (requires auth) |

### Channels
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/channels` | List all channels |
| GET | `/api/channels/my` | List channels current user belongs to |
| POST | `/api/channels` | Create a new channel |
| GET | `/api/channels/:id` | Get channel details |
| POST | `/api/channels/:id/join` | Join a channel |

### Messages
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/messages/:channelId` | Get messages for a channel (paginated) |
| GET | `/api/messages/:channelId/threads/:messageId` | Get thread replies |
| POST | `/api/messages/:messageId/reactions` | Add/remove reaction |
| POST | `/api/messages/upload` | Upload a file attachment (multipart `file`) |

### Files
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/files` | List files attached to messages the user can see |
| GET | `/api/files/:id/download` | Download the stored file |

### Notes
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/notes` | List the current user's notes |
| POST | `/api/notes` | Create a note (`title`, `content`) |
| PUT | `/api/notes/:id` | Update a note (`title`, `content`) |
| DELETE | `/api/notes/:id` | Delete a note |

### Users
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/users` | List all users |
| GET | `/api/users/:id` | Get user by ID |
| POST | `/api/users/heartbeat` | Presence keepalive (sets status online) |
| GET | `/api/users/:id/direct-messages` | Get DMs with a user |

### Socket.io Events

| Event | Direction | Description |
|-------|-----------|-------------|
| `authenticate` | Client → Server | Authenticate with JWT token |
| `join_channel` | Client → Server | Join a channel room |
| `leave_channel` | Client → Server | Leave a channel room |
| `send_message` | Client → Server | Send a message to a channel |
| `send_direct_message` | Client → Server | Send a DM |
| `typing` | Client → Server | Typing indicator |
| `huddle:join` | Client → Server | Join an authorized channel audio huddle |
| `huddle:signal` | Client ↔ Server | Relay WebRTC offers, answers, and ICE candidates between huddle members |
| `huddle:leave` | Client → Server | Leave the active channel huddle |
| `huddle:joined` | Server → Client | Huddle participants and ICE server configuration |
| `huddle:participant-joined` / `huddle:participant-left` | Server → Client | Huddle roster updates |
| `huddle:error` | Server → Client | Huddle authorization or connection error |
| `new_message` | Server → Client | New message received |
| `new_direct_message` | Server → Client | New DM received |
| `user_typing` | Server → Client | User typing indicator |
| `message_sent` | Server → Client | Message send confirmation |
| `message_error` | Server → Client | Error |

## Local Development

```bash
cd backend
npm install
cp ../../.env.example .env  # or create .env manually
npm run dev
```

Server runs on `http://127.0.0.1:3001` by default (use the literal IPv4 address; the Docker port
mapping is IPv4 only).

## Environment Variables

See `../../.env.example` for required variables.

`WEBRTC_ICE_SERVERS` is a JSON array used by channel huddles. The default public STUN server
supports many direct connections; configure a TURN server in this variable for users behind
restrictive NATs/firewalls. TURN credentials are sent to authenticated huddle participants, so use
short-lived credentials where your TURN provider supports them.
