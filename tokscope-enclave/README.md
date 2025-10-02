# Xordi Enclave (TCB)

Trusted Computing Base for secure TikTok automation. Provides isolated, multi-user session management with encrypted storage.

## Architecture

```
External Access     Internal Network Only
      │
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│   API Server    │────│ Browser Manager  │────│ Browser Pool    │
│   (port 3000)   │    │   (internal)     │    │   (internal)    │
└─────────────────┘    └──────────────────┘    └─────────────────┘
```

**Components:**
- **server.js**: Multi-user API server with session encryption
- **browser-manager.js**: Container pool manager for browser automation
- **lib/**: Shared automation clients (imported from main project)

## API Endpoints

### Session Management
```bash
POST /load-session     # Load encrypted session data
GET /health           # Check system status and active sessions
POST /save-session    # Save and encrypt session data
```

### Sampling
```bash
POST /sample          # Execute sampling (method: api|browser|web)
GET /status          # Get sampling job status
```

## Usage

### Start TCB Environment
```bash
npm run enclave
# or: docker compose -f docker-compose-audit.yml up -d
```

### Load Session
```bash
curl -X POST http://localhost:3000/load-session \
  -H "Content-Type: application/json" \
  -d @encrypted-session.json
```

### Execute Sampling
```bash
curl -X POST http://localhost:3000/scrape \
  -H "Content-Type: application/json" \
  -d '{"method": "api", "count": 5, "sessionId": "your-session-id"}'
```

## Security Features

- **Encrypted sessions**: DStack key derivation for user-bound encryption
- **Network isolation**: Browser containers only accessible via internal network
- **No external ports**: Only API server (port 3000) exposed externally
- **Isolated containers**: Browser automation in separate containers
- **No persistent storage**: Ephemeral execution environment
- **Multi-user isolation**: Session-specific browser instances

## Development

**Build containers:**
```bash
docker compose -f docker-compose-audit.yml build
```

**View logs:**
```bash
docker logs xordi-enclave
docker logs browser-manager
```

**Test:**
```bash
npm run test-enclave
```

## Files

- **server.js**: Main TCB API server
- **browser-manager.js**: Browser container lifecycle manager
- **Dockerfile.api**: API server container definition
- **Dockerfile.browser-manager**: Browser manager container
- **Dockerfile.browser**: Browser instance template
- **package.json**: Dependencies (playwright, express, dstack-sdk)