# Dashboard Design Notes

## Purpose

The dashboard is a **standalone external service** that demonstrates how an untrusted host can interact with the xordi enclave. It's explicitly outside the trusted compute base and serves as both:
1. A practical management interface for enclave instances
2. A reference implementation for external API consumers

## Architecture

```
┌─────────────────────┐
│  Browser Client     │
│  (User Interface)   │
└──────────┬──────────┘
           │ HTTP/SSE
           ▼
┌─────────────────────┐
│  Dashboard Server   │ ← examples/dashboard.js (port 4000)
│  (Untrusted Host)   │
└──────────┬──────────┘
           │ HTTP API
           ▼
┌─────────────────────┐
│  Xordi Enclave API  │ ← xordi-enclave-api (port 3000)
│  (Trusted)          │
└─────────────────────┘
```

## Key Design Principles

### 1. External Perspective
- Dashboard runs **outside** the enclave (different process, different container)
- Cannot access enclave internals, only public API
- Demonstrates the boundary between trusted and untrusted components

### 2. State Persistence
- Saves encrypted session data to `examples/dashboard-sessions.json`
- Session data comes from enclave (already encrypted if dstack enabled)
- Survives dashboard restarts
- Format: `{ "sessions": { "sessionId": { data, metadata } } }`

### 3. Real-time Updates
- Server-sent events (SSE) for auth QR code polling
- No WebSockets needed - keeps it simple
- Browser polls for session list updates

## Features

### Auth Flow
1. User clicks "New Auth Session"
2. Dashboard calls `POST /auth/start/:sessionId` (generates new sessionId)
3. Opens modal with SSE connection to `/dashboard/auth-stream/:authSessionId`
4. Server polls enclave's `/auth/poll/:authSessionId` every 2s
5. Streams QR code updates to browser
6. When complete, calls `POST /load-session` and saves to local file
7. Auto-refreshes session list

### Session Management
- **List**: Shows all sessions with username, nickname, last activity
- **Delete**: Calls dashboard endpoint which removes from local storage (enclave sessions are ephemeral)
- **Sample**: Triggers FYP or watch history sampling with configurable count

### Video Results
- Full video details displayed in activity feed
- Each video shows:
  - Description (full text)
  - Author (@username)
  - Clickable link to TikTok video
  - Video ID
- Results persist in activity log until dashboard restart

### Health Monitoring
- Polls `/health` every 10s
- Shows:
  - System status (healthy/degraded)
  - Session count (active/max)
  - Browser container availability
  - Uptime

## UI Layout

```
┌────────────────────────────────────────────────────────────┐
│ Xordi Enclave Dashboard                                    │
│ ● Connected | Health: Healthy | Sessions: 2/10             │
│ Containers: 5 available | Uptime: 2h 15m                   │
├────────────────────────────────────────────────────────────┤
│ [+ New Auth Session]                                       │
├────────────────────────────────────────────────────────────┤
│ Active Sessions                                            │
│                                                             │
│ ┌──────────────────────────────────────────────────────┐  │
│ │ @alice (Alice Smith) • user123...                    │  │
│ │ Last activity: 2 minutes ago (sampled 10 videos)     │  │
│ │ [Sample FYP ▼] [Sample History ▼] [Delete Session]  │  │
│ └──────────────────────────────────────────────────────┘  │
│                                                             │
│ ┌──────────────────────────────────────────────────────┐  │
│ │ @bob (Bob Jones) • user456...                        │  │
│ │ Last activity: never                                  │  │
│ │ [Sample FYP ▼] [Sample History ▼] [Delete Session]  │  │
│ └──────────────────────────────────────────────────────┘  │
│                                                             │
├────────────────────────────────────────────────────────────┤
│ Recent Activity                                            │
│                                                             │
│ 14:23:15 - Sampled 10 videos for @alice (FYP)            │
│   1. "Amazing sunset timelapse" by @naturelover           │
│      → https://www.tiktok.com/@naturelover/video/123...   │
│   2. "Quick pasta recipe" by @cookingwithjen              │
│      → https://www.tiktok.com/@cookingwithjen/video/456..│
│   ... (8 more)                                             │
│                                                             │
│ 14:20:42 - New auth completed for @bob                    │
│ 14:15:30 - Dashboard started                               │
└────────────────────────────────────────────────────────────┘
```

## API Endpoints (Dashboard Server)

### External API (for browser)
- `GET /` - Serve dashboard UI
- `GET /dashboard/auth-stream/:authSessionId` - SSE for QR polling
- `POST /dashboard/auth/start` - Start new auth session
- `GET /dashboard/sessions` - Get session list (augmented with local metadata)
- `DELETE /dashboard/sessions/:sessionId` - Delete session from dashboard
- `POST /dashboard/sample` - Trigger sampling (proxies to enclave)
- `GET /dashboard/health` - Get enclave health

### Internal (to enclave)
All proxied through to `http://xordi-enclave-api:3000`

## Data Storage

### `examples/dashboard-sessions.json`
```json
{
  "sessions": {
    "user123abc...": {
      "sessionData": {
        "user": { "sec_user_id": "...", "username": "alice", ... },
        "cookies": [...],
        "tokens": {...}
      },
      "metadata": {
        "addedAt": "2025-09-29T20:00:00Z",
        "lastActivity": "2025-09-29T20:15:00Z",
        "lastAction": "sample_foryoupage",
        "lastResult": { "count": 10, "method": "browser_automation" }
      }
    }
  }
}
```

## Technology Choices

### Why SSE instead of WebSockets?
- Simpler protocol (just HTTP)
- One-way communication is sufficient
- Automatic reconnection in browsers
- No need for ws:// protocol handling

### Why single-file implementation?
- Easy to understand and audit
- No build step required
- HTML/CSS/JS embedded in Express server
- Demonstrates complete external integration in ~500 LOC

### Why save encrypted sessions?
- Dashboard acts as session "wallet"
- Can reload sessions into enclave after restart
- Demonstrates external storage of credentials
- Still encrypted (from dstack if enabled)

## Security Considerations

Since dashboard runs on untrusted host:
- **Cannot** access enclave internals
- **Cannot** decrypt dstack-encrypted sessions without TEE
- **Can** store encrypted session blobs
- **Can** trigger enclave operations via API
- **Can** observe video metadata (not credentials)

This boundary demonstrates the enclave's trust model: credentials stay in TEE, only derived data (video lists) leave the enclave.

## Testing the Dashboard

```bash
# Terminal 1: Start enclave
docker compose -f docker-compose-audit.yml up

# Terminal 2: Start dashboard
node examples/dashboard.js

# Browser: Open http://localhost:4000
```

The dashboard should:
1. Connect to enclave and show health
2. Allow creating new auth sessions
3. Display QR codes for authentication
4. List authenticated sessions
5. Trigger sampling operations
6. Show detailed video results
7. Persist state across restarts